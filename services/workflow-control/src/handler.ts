import { createHash, randomUUID } from 'node:crypto';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { z } from 'zod';

import {
  agentResultEnvelopeSchema,
  workflowInputSchema,
  type AgentResultEnvelope,
} from '@migration/contracts';
import {
  parseConfig,
  workflowControlConfigSchema,
  type WorkflowControlConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import type { TerminalCode } from '@migration/domain';
import { writeLog } from '@migration/observability';

const MAX_RESULT_BYTES = 1024 * 1024;

const workflowCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('mark_started'),
      workflow: workflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_result'),
      workflow: workflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_failed'),
      workflow: workflowInputSchema,
      terminalCode: z.enum([
        'cancelled',
        'budget_exhausted_model_calls',
        'budget_exhausted_tool_calls',
        'budget_exhausted_iterations',
        'budget_exhausted_time',
        'invalid_model_output',
        'policy_rejected',
        'upstream_transient',
        'upstream_permanent',
        'infrastructure_failed',
      ]),
      safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    })
    .strict(),
]);

interface WorkflowDependencies {
  readonly config: WorkflowControlConfig;
  readonly database: AppDatabase;
  readonly s3: S3Client;
}

let cachedDependencies: WorkflowDependencies | undefined;

async function dependencies(): Promise<WorkflowDependencies> {
  if (cachedDependencies) {
    return cachedDependencies;
  }
  const config = parseConfig(workflowControlConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
  };
  return cachedDependencies;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  return handleWorkflowCommand(event, context.awsRequestId, await dependencies());
}

export async function handleWorkflowCommand(
  event: unknown,
  requestId: string,
  dependency: WorkflowDependencies,
): Promise<{ readonly status: string }> {
  const command = workflowCommandSchema.parse(event);
  const { workflow } = command;
  if (command.operation === 'mark_started') {
    const result = await dependency.database
      .updateTable('agentRuns')
      .set({
        status: 'running',
        startedAt: new Date(),
        updatedAt: new Date(),
        version: workflow.expectedVersion + 1,
      })
      .where('id', '=', workflow.agentRunId)
      .where('organisationId', '=', workflow.organisationId)
      .where('status', '=', 'queued')
      .where('version', '=', workflow.expectedVersion)
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      const current = await dependency.database
        .selectFrom('agentRuns')
        .select(['status', 'version'])
        .where('id', '=', workflow.agentRunId)
        .where('organisationId', '=', workflow.organisationId)
        .executeTakeFirst();
      if (current?.status !== 'running') {
        throw new Error('Agent run is not in the expected queued state.');
      }
    }
    writeLog('info', {
      event: 'agent_run_started',
      requestId,
      correlationId: workflow.correlationId,
      organisationId: workflow.organisationId,
      agentRunId: workflow.agentRunId,
    });
    return { status: 'running' };
  }

  if (command.operation === 'mark_failed') {
    await markFailed(
      dependency.database,
      workflow.organisationId,
      workflow.agentRunId,
      command.terminalCode,
      command.safeErrorCode,
    );
    writeLog('warn', {
      event: 'agent_run_failed',
      requestId,
      correlationId: workflow.correlationId,
      organisationId: workflow.organisationId,
      agentRunId: workflow.agentRunId,
      safeErrorCode: command.safeErrorCode,
    });
    return { status: 'failed' };
  }

  const envelope = await readResult(
    dependency,
    workflow.organisationId,
    workflow.agentRunId,
  );
  if (envelope.terminal.code !== 'completed') {
    await markFailed(
      dependency.database,
      workflow.organisationId,
      workflow.agentRunId,
      envelope.terminal.code,
      envelope.terminal.safeErrorCode ?? 'AGENT_RUN_FAILED',
      envelope,
    );
    return { status: 'failed' };
  }
  await persistSuccess(dependency, envelope);
  writeLog('info', {
    event: 'agent_run_completed',
    requestId,
    correlationId: workflow.correlationId,
    organisationId: workflow.organisationId,
    agentRunId: workflow.agentRunId,
    outcome: 'completed',
  });
  return { status: 'succeeded' };
}

async function readResult(
  dependency: WorkflowDependencies,
  organisationId: string,
  agentRunId: string,
): Promise<AgentResultEnvelope & { readonly artifact: ArtifactBytes }> {
  const key = resultKey(dependency.config.APP_ENVIRONMENT, organisationId, agentRunId);
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: key,
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength > MAX_RESULT_BYTES ||
    response.ContentLength < 1
  ) {
    throw new Error('The agent result artifact has an invalid size.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new Error('The agent result artifact could not be read completely.');
  }
  const parsed = agentResultEnvelopeSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8')),
  );
  if (parsed.organisationId !== organisationId || parsed.agentRunId !== agentRunId) {
    throw new Error('The agent result artifact does not match workflow ownership.');
  }
  return {
    ...parsed,
    artifact: {
      key,
      digest: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.byteLength,
    },
  };
}

interface ArtifactBytes {
  readonly key: string;
  readonly digest: string;
  readonly bytes: number;
}

async function persistSuccess(
  dependency: WorkflowDependencies,
  envelope: AgentResultEnvelope & { readonly artifact: ArtifactBytes },
): Promise<void> {
  await dependency.database.transaction().execute(async transaction => {
    const current = await transaction
      .selectFrom('agentRuns')
      .select(['status', 'resultArtifactId'])
      .where('id', '=', envelope.agentRunId)
      .where('organisationId', '=', envelope.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.status === 'succeeded') {
      const artifact = await transaction
        .selectFrom('artifacts')
        .select('digest')
        .where('id', '=', current.resultArtifactId)
        .executeTakeFirstOrThrow();
      if (artifact.digest !== envelope.artifact.digest) {
        throw new Error('A completed run cannot be replaced by another result.');
      }
      return;
    }
    if (current.status !== 'running') {
      throw new Error('Only a running agent run can ingest a result.');
    }
    const artifactId = randomUUID();
    await transaction
      .insertInto('artifacts')
      .values({
        id: artifactId,
        organisationId: envelope.organisationId,
        ownerType: 'agent_run',
        ownerId: envelope.agentRunId,
        artifactType: 'final_result',
        objectKey: envelope.artifact.key,
        digest: envelope.artifact.digest,
        bytes: envelope.artifact.bytes,
        mediaType: 'application/json',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .executeTakeFirstOrThrow();
    for (const action of envelope.actions) {
      await transaction
        .insertInto('agentActions')
        .values({
          id: action.id,
          agentRunId: envelope.agentRunId,
          sequence: action.sequence,
          toolName: action.toolName,
          toolVersion: action.toolVersion,
          status: action.status,
          inputDigest: action.inputDigest,
          outputDigest: action.outputDigest,
          safeErrorCode: action.safeErrorCode,
          startedAt: new Date(action.startedAt),
          completedAt: new Date(action.completedAt),
        })
        .onConflict(conflict =>
          conflict.columns(['agentRunId', 'sequence']).doNothing(),
        )
        .execute();
    }
    await transaction
      .updateTable('agentRuns')
      .set(expression => ({
        status: 'succeeded',
        terminalCode: 'completed',
        safeErrorCode: null,
        resultArtifactId: artifactId,
        returnedModel: envelope.model.returnedModel,
        openaiRequestId: envelope.model.requestId,
        inputTokens: envelope.usage.inputTokens,
        outputTokens: envelope.usage.outputTokens,
        modelCalls: envelope.usage.modelCalls,
        toolCalls: envelope.usage.toolCalls,
        iterations: envelope.usage.iterations,
        completedAt: new Date(),
        updatedAt: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', envelope.agentRunId)
      .where('organisationId', '=', envelope.organisationId)
      .executeTakeFirstOrThrow();
  });
}

async function markFailed(
  database: AppDatabase,
  organisationId: string,
  agentRunId: string,
  terminalCode: Exclude<TerminalCode, 'completed'>,
  safeErrorCode: string,
  envelope?: AgentResultEnvelope,
): Promise<void> {
  await database
    .updateTable('agentRuns')
    .set(expression => ({
      status: 'failed',
      terminalCode,
      safeErrorCode,
      returnedModel: envelope?.model.returnedModel ?? null,
      openaiRequestId: envelope?.model.requestId ?? null,
      inputTokens: envelope?.usage.inputTokens ?? 0,
      outputTokens: envelope?.usage.outputTokens ?? 0,
      modelCalls: envelope?.usage.modelCalls ?? 0,
      toolCalls: envelope?.usage.toolCalls ?? 0,
      iterations: envelope?.usage.iterations ?? 0,
      completedAt: new Date(),
      updatedAt: new Date(),
      version: expression('version', '+', 1),
    }))
    .where('id', '=', agentRunId)
    .where('organisationId', '=', organisationId)
    .where('status', 'in', ['queued', 'running'])
    .execute();
}

function resultKey(
  environment: string,
  organisationId: string,
  agentRunId: string,
): string {
  return `env/${environment}/org/${organisationId}/run/${agentRunId}/result/final.json`;
}
