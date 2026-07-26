import { createHash, randomUUID } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  impactAnalysisInputArtifactSchema,
  impactAnalysisPreparedInputSchema,
  impactAnalysisResultSchema,
  impactAnalysisWorkflowInputSchema,
  type ImpactAnalysisPreparedInput,
  type ImpactAnalysisResult,
} from '@migration/contracts';
import {
  impactAnalysisControlConfigSchema,
  parseConfig,
  type ImpactAnalysisControlConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase, type Database } from '@migration/database';
import { writeLog } from '@migration/observability';

const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const STALE_RUN_MS = 20 * 60 * 1_000;

const commandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('prepare'),
    workflow: impactAnalysisWorkflowInputSchema,
  }),
  z.object({
    operation: z.literal('finalize'),
    workflow: impactAnalysisPreparedInputSchema,
  }),
  z.object({
    operation: z.literal('mark_failed'),
    workflow: impactAnalysisPreparedInputSchema,
    safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
  }),
]);

interface Dependencies {
  readonly config: ImpactAnalysisControlConfig;
  readonly database: AppDatabase;
  readonly s3: S3Client;
  readonly now: () => Date;
  readonly id: () => string;
}

let cached: Dependencies | undefined;

async function dependencies(): Promise<Dependencies> {
  if (cached) return cached;
  const config = parseConfig(impactAnalysisControlConfigSchema);
  cached = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
    now: (): Date => new Date(),
    id: randomUUID,
  };
  return cached;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  try {
    return await handleImpactAnalysisCommand(
      event,
      context.awsRequestId,
      await dependencies(),
    );
  } catch (error) {
    const safeCode =
      error instanceof ImpactAnalysisControlError
        ? error.safeCode
        : 'IMPACT_ANALYSIS_CONTROL_FAILED';
    writeLog('error', {
      event: 'impact_analysis_control_failed',
      requestId: context.awsRequestId,
      safeErrorCode: safeCode,
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    });
    throw new ImpactAnalysisControlError(safeCode);
  }
}

export async function handleImpactAnalysisCommand(
  event: unknown,
  requestId: string,
  dependency: Dependencies,
): Promise<unknown> {
  const command = commandSchema.parse(event);
  if (command.operation === 'prepare') {
    const prepared = await prepare(dependency, command.workflow);
    writeLog('info', {
      event: 'impact_analysis_run_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      agentRunId: prepared.impactAnalysisRunId,
      outcome: prepared.alreadySucceeded ? 'already_succeeded' : 'running',
    });
    return prepared;
  }
  if (command.operation === 'mark_failed') {
    await markFailed(
      dependency.database,
      command.workflow.impactAnalysisRunId,
      command.safeErrorCode,
      dependency.now(),
    );
    return { status: 'failed' };
  }
  const { result, digest: resultDigest } = await readResult(
    dependency,
    command.workflow,
  );
  const status = await finalize(dependency, command.workflow, result, resultDigest);
  writeLog(status === 'succeeded' ? 'info' : 'warn', {
    event: 'impact_analysis_run_finalized',
    requestId,
    correlationId: command.workflow.correlationId,
    agentRunId: command.workflow.impactAnalysisRunId,
    outcome: status,
    safeErrorCode: result.safeErrorCode ?? undefined,
  });
  return { status };
}

async function prepare(
  dependency: Dependencies,
  workflow: z.infer<typeof impactAnalysisWorkflowInputSchema>,
): Promise<ImpactAnalysisPreparedInput> {
  const now = dependency.now();
  const source = await dependency.database
    .selectFrom('migrationCandidates as candidate')
    .innerJoin(
      'dependencyObservations as observation',
      'observation.id',
      'candidate.dependencyObservationId',
    )
    .innerJoin(
      'repositorySnapshots as snapshot',
      'snapshot.id',
      'observation.repositorySnapshotId',
    )
    .innerJoin(
      'migrationSpecifications as specification',
      'specification.id',
      'candidate.migrationSpecificationId',
    )
    .select([
      'candidate.id as candidateId',
      'candidate.organisationId',
      'candidate.repositoryId',
      'candidate.status as candidateStatus',
      'snapshot.id as repositorySnapshotId',
      'snapshot.commitSha',
      'snapshot.objectKey as snapshotObjectKey',
      'snapshot.digest as snapshotDigest',
      'snapshot.status as snapshotStatus',
      'snapshot.expiresAt',
      'specification.id as migrationSpecificationId',
      'specification.trustState',
      'specification.specification',
    ])
    .where('candidate.id', '=', workflow.candidateId)
    .executeTakeFirst();
  if (
    source?.candidateStatus !== 'open' ||
    !['reviewed', 'vendor_verified'].includes(source.trustState) ||
    source.snapshotStatus !== 'available' ||
    source.expiresAt <= now
  ) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_INPUT_NOT_AVAILABLE');
  }

  const existing = await dependency.database
    .selectFrom('impactAnalysisRuns')
    .selectAll()
    .where('candidateId', '=', source.candidateId)
    .where('repositorySnapshotId', '=', source.repositorySnapshotId)
    .where('migrationSpecificationId', '=', source.migrationSpecificationId)
    .where('snapshotDigest', '=', source.snapshotDigest)
    .executeTakeFirst();
  if (existing?.status === 'succeeded') {
    return preparedFrom(
      workflow.correlationId,
      source,
      existing.id,
      existing.inputObjectKey,
      existing.inputDigest,
      existing.resultObjectKey,
      1,
      true,
    );
  }
  if (
    existing?.status === 'running' &&
    now.getTime() - existing.updatedAt.getTime() < STALE_RUN_MS
  ) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_IN_PROGRESS');
  }
  if (existing && existing.attempt >= 10) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_RETRY_EXHAUSTED');
  }

  const latestReport = await dependency.database
    .selectFrom('impactReports')
    .select('revision')
    .where('candidateId', '=', source.candidateId)
    .orderBy('revision', 'desc')
    .executeTakeFirst();
  const reportRevision = (latestReport?.revision ?? 0) + 1;
  const runId = existing?.id ?? dependency.id();
  const prefix = `env/${dependency.config.APP_ENVIRONMENT}/impact-analysis/candidate/${source.candidateId}/run/${runId}`;
  const inputObjectKey = `${prefix}/input.json`;
  const resultObjectKey = `${prefix}/result.json`;
  const input = impactAnalysisInputArtifactSchema.parse({
    schemaVersion: '1.0',
    candidateId: source.candidateId,
    impactAnalysisRunId: runId,
    organisationId: source.organisationId,
    repositoryId: source.repositoryId,
    repositorySnapshotId: source.repositorySnapshotId,
    commitSha: source.commitSha,
    snapshotObjectKey: source.snapshotObjectKey,
    snapshotDigest: source.snapshotDigest,
    migrationSpecificationId: source.migrationSpecificationId,
    migrationSpecification: source.specification,
    reportRevision,
  });
  const inputBody = JSON.stringify(input);
  const inputDigest = digest(Buffer.from(inputBody));
  await dependency.s3.send(
    new PutObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: inputObjectKey,
      Body: inputBody,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': '1.0',
        'candidate-id': source.candidateId,
        'snapshot-digest': source.snapshotDigest,
      },
    }),
  );

  await dependency.database.transaction().execute(async transaction => {
    if (existing) {
      await transaction
        .updateTable('impactAnalysisRuns')
        .set(expression => ({
          status: 'running',
          attempt: expression('attempt', '+', 1),
          safeErrorCode: null,
          correlationId: workflow.correlationId,
          inputObjectKey,
          inputDigest,
          resultObjectKey,
          impactReportId: null,
          requestedModel: dependency.config.OPENAI_MODEL,
          returnedModel: null,
          openaiRequestId: null,
          modelCalls: 0,
          toolCalls: 0,
          iterations: 0,
          inputTokens: 0,
          outputTokens: 0,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }))
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .insertInto('impactAnalysisRuns')
        .values({
          id: runId,
          candidateId: source.candidateId,
          repositorySnapshotId: source.repositorySnapshotId,
          migrationSpecificationId: source.migrationSpecificationId,
          snapshotDigest: source.snapshotDigest,
          status: 'running',
          attempt: 1,
          safeErrorCode: null,
          correlationId: workflow.correlationId,
          inputObjectKey,
          inputDigest,
          resultObjectKey,
          impactReportId: null,
          requestedModel: dependency.config.OPENAI_MODEL,
          returnedModel: null,
          openaiRequestId: null,
          modelCalls: 0,
          toolCalls: 0,
          iterations: 0,
          inputTokens: 0,
          outputTokens: 0,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
    }
  });
  return preparedFrom(
    workflow.correlationId,
    source,
    runId,
    inputObjectKey,
    inputDigest,
    resultObjectKey,
    reportRevision,
    false,
  );
}

interface PreparedSource {
  readonly candidateId: string;
  readonly organisationId: string;
  readonly repositoryId: string;
  readonly repositorySnapshotId: string;
  readonly commitSha: string;
  readonly snapshotObjectKey: string;
  readonly snapshotDigest: string;
  readonly migrationSpecificationId: string;
}

function preparedFrom(
  correlationId: string,
  source: PreparedSource,
  runId: string,
  inputObjectKey: string,
  inputDigest: string,
  resultObjectKey: string,
  reportRevision: number,
  alreadySucceeded: boolean,
): ImpactAnalysisPreparedInput {
  return impactAnalysisPreparedInputSchema.parse({
    schemaVersion: '1.0',
    candidateId: source.candidateId,
    impactAnalysisRunId: runId,
    correlationId,
    organisationId: source.organisationId,
    repositoryId: source.repositoryId,
    repositorySnapshotId: source.repositorySnapshotId,
    commitSha: source.commitSha,
    snapshotObjectKey: source.snapshotObjectKey,
    snapshotDigest: source.snapshotDigest,
    migrationSpecificationId: source.migrationSpecificationId,
    inputObjectKey,
    inputDigest,
    resultObjectKey,
    reportRevision,
    alreadySucceeded,
  });
}

async function readResult(
  dependency: Dependencies,
  workflow: ImpactAnalysisPreparedInput,
): Promise<{ result: ImpactAnalysisResult; digest: string }> {
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: workflow.resultObjectKey,
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > MAX_RESULT_BYTES
  ) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_RESULT_SIZE_INVALID');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_RESULT_READ_FAILED');
  }
  let result: ImpactAnalysisResult;
  try {
    result = impactAnalysisResultSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
  } catch {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_RESULT_INVALID');
  }
  if (
    result.candidateId !== workflow.candidateId ||
    result.impactAnalysisRunId !== workflow.impactAnalysisRunId ||
    result.repositorySnapshotId !== workflow.repositorySnapshotId ||
    result.snapshotDigest !== workflow.snapshotDigest
  ) {
    throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_RESULT_OWNERSHIP_INVALID');
  }
  return { result, digest: digest(bytes) };
}

async function finalize(
  dependency: Dependencies,
  workflow: ImpactAnalysisPreparedInput,
  result: ImpactAnalysisResult,
  resultDigest: string,
): Promise<'succeeded' | 'failed'> {
  const now = dependency.now();
  return dependency.database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('impactAnalysisRuns')
      .select(['status', 'impactReportId'])
      .where('id', '=', workflow.impactAnalysisRunId)
      .where('candidateId', '=', workflow.candidateId)
      .where('repositorySnapshotId', '=', workflow.repositorySnapshotId)
      .where('snapshotDigest', '=', workflow.snapshotDigest)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status !== 'running') {
      throw new ImpactAnalysisControlError('IMPACT_ANALYSIS_STATE_INVALID');
    }
    if (result.status === 'failed' || !result.report) {
      await updateTerminal(
        transaction,
        workflow.impactAnalysisRunId,
        result,
        null,
        result.safeErrorCode ?? 'IMPACT_ANALYSIS_AGENT_FAILED',
        now,
      );
      return 'failed';
    }
    const reportId = dependency.id();
    await transaction
      .insertInto('impactReports')
      .values({
        id: reportId,
        candidateId: workflow.candidateId,
        repositoryId: workflow.repositoryId,
        repositorySnapshotId: workflow.repositorySnapshotId,
        impactAgentRunId: workflow.impactAnalysisRunId,
        schemaVersion: '1.0',
        outcome: result.report.outcome,
        affectedSummary: serializeJsonColumn({
          affectedFiles: result.report.affectedFiles,
          unaffectedFiles: result.report.unaffectedFiles,
        }),
        riskCategory: result.report.risk,
        verificationAvailability: serializeJsonColumn(result.report.verification),
        uncertainty: serializeJsonColumn(result.report.uncertainties),
        artifactObjectKey: workflow.resultObjectKey,
        artifactDigest: resultDigest,
        revision: workflow.reportRevision,
        createdAt: now,
      })
      .executeTakeFirstOrThrow();
    await updateTerminal(
      transaction,
      workflow.impactAnalysisRunId,
      result,
      reportId,
      null,
      now,
    );
    return 'succeeded';
  });
}

async function updateTerminal(
  transaction: Transaction<Database>,
  runId: string,
  result: ImpactAnalysisResult,
  reportId: string | null,
  safeErrorCode: string | null,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable('impactAnalysisRuns')
    .set({
      status: reportId ? 'succeeded' : 'failed',
      safeErrorCode,
      impactReportId: reportId,
      returnedModel: result.model.returnedModel,
      openaiRequestId: result.model.requestId,
      modelCalls: result.usage.modelCalls,
      toolCalls: result.usage.toolCalls,
      iterations: result.usage.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      completedAt: now,
      updatedAt: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .executeTakeFirstOrThrow();
}

async function markFailed(
  database: AppDatabase,
  runId: string,
  safeErrorCode: string,
  now: Date,
): Promise<void> {
  await database
    .updateTable('impactAnalysisRuns')
    .set({
      status: 'failed',
      safeErrorCode,
      completedAt: now,
      updatedAt: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .executeTakeFirst();
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function serializeJsonColumn(value: object): string {
  return JSON.stringify(value);
}

export class ImpactAnalysisControlError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The impact-analysis operation could not be completed.');
    this.name = 'ImpactAnalysisControlError';
  }
}
