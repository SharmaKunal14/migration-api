import { createHash, randomUUID } from 'node:crypto';

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { z } from 'zod';

import {
  agentResultEnvelopeSchema,
  migrationAcquisitionResultSchema,
  migrationWorkflowInputSchema,
  workflowInputSchema,
  type AgentResultEnvelope,
  type MigrationWorkflowInput,
} from '@migration/contracts';
import {
  parseConfig,
  workflowControlConfigSchema,
  type WorkflowControlConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase, type Database } from '@migration/database';
import type { Transaction } from 'kysely';
import type { TerminalCode } from '@migration/domain';
import { writeLog } from '@migration/observability';

const MAX_RESULT_BYTES = 1024 * 1024;

export const migrationExecutionStageSchema = z.enum([
  'acquiring',
  'planning',
  'patching',
  'verifying',
  'repairing',
  'publishing',
]);
type MigrationExecutionStage = z.infer<typeof migrationExecutionStageSchema>;
export const migrationStageCapabilityStatusSchema = z.enum([
  'unavailable',
  'cancelled',
]);

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
  z
    .object({
      operation: z.literal('validate_migration_approval'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_migration_stage_unavailable'),
      workflow: migrationWorkflowInputSchema,
      stage: migrationExecutionStageSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('evaluate_migration_stage_capability'),
      workflow: migrationWorkflowInputSchema,
      stage: migrationExecutionStageSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('enter_migration_acquisition'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_migration_acquisition'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_migration_infrastructure_failed'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_migration_repair_budget_exhausted'),
      workflow: migrationWorkflowInputSchema,
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
): Promise<{
  readonly status: string;
  readonly stage?: MigrationExecutionStage;
}> {
  const command = workflowCommandSchema.parse(event);
  if (command.operation === 'validate_migration_approval') {
    const status = await validateMigrationApproval(
      dependency.database,
      command.workflow,
    );
    writeLog(status === 'running' ? 'info' : 'warn', {
      event: 'migration_approval_revalidated',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status };
  }
  if (command.operation === 'enter_migration_acquisition') {
    const status = await enterMigrationAcquisition(
      dependency.database,
      command.workflow,
    );
    writeLog(status === 'running' ? 'info' : 'warn', {
      event:
        status === 'running'
          ? 'migration_stage_entered'
          : 'migration_cancelled_at_safe_boundary',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status };
  }
  if (command.operation === 'ingest_migration_acquisition') {
    const status = await ingestMigrationAcquisition(dependency, command.workflow);
    writeLog(status === 'completed' ? 'info' : 'warn', {
      event: 'migration_acquisition_ingested',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status, stage: 'acquiring' };
  }
  if (command.operation === 'evaluate_migration_stage_capability') {
    const status = await evaluateMigrationStageCapability(
      dependency.database,
      command.workflow,
      command.stage,
    );
    writeLog(status === 'unavailable' ? 'info' : 'warn', {
      event:
        status === 'unavailable'
          ? 'migration_stage_capability_unavailable'
          : 'migration_cancelled_at_safe_boundary',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
      stage: command.stage,
    });
    return { status, stage: command.stage };
  }
  if (command.operation === 'mark_migration_stage_unavailable') {
    const safeErrorCode = stageUnavailableSafeErrorCode(command.stage);
    const status = await markMigrationFailed(
      dependency.database,
      command.workflow,
      safeErrorCode,
      command.stage,
    );
    writeLog(status === 'failed' ? 'info' : 'warn', {
      event:
        status === 'failed'
          ? 'migration_stopped_at_unavailable_stage'
          : 'migration_cancelled_at_safe_boundary',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      ...(status === 'failed' ? { safeErrorCode } : {}),
      outcome: status,
      stage: command.stage,
    });
    return { status };
  }
  if (command.operation === 'mark_migration_infrastructure_failed') {
    const status = await markMigrationFailed(
      dependency.database,
      command.workflow,
      'MIGRATION_CONTROL_INFRASTRUCTURE_FAILED',
    );
    writeLog(status === 'failed' ? 'error' : 'warn', {
      event:
        status === 'failed'
          ? 'migration_control_failed'
          : 'migration_cancelled_at_safe_boundary',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      ...(status === 'failed'
        ? { safeErrorCode: 'MIGRATION_CONTROL_INFRASTRUCTURE_FAILED' }
        : {}),
      outcome: status,
    });
    return { status };
  }
  if (command.operation === 'mark_migration_repair_budget_exhausted') {
    const status = await markMigrationFailed(
      dependency.database,
      command.workflow,
      'MIGRATION_REPAIR_BUDGET_EXHAUSTED',
      'verifying',
    );
    writeLog(status === 'failed' ? 'warn' : 'info', {
      event:
        status === 'failed'
          ? 'migration_repair_budget_exhausted'
          : 'migration_cancelled_at_safe_boundary',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      ...(status === 'failed'
        ? { safeErrorCode: 'MIGRATION_REPAIR_BUDGET_EXHAUSTED' }
        : {}),
      outcome: status,
      stage: 'verifying',
    });
    return { status };
  }
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

interface MigrationApprovalState {
  readonly expiresAt: Date | null;
  readonly approvedBaseBranch: string;
  readonly baseCommitSha: string;
  readonly approvedGithubRepositoryId: string;
  readonly approvedSnapshotDigest: string;
  readonly migrationSpecificationRevision: number;
  readonly migrationSpecificationDigest: string;
  readonly impactReportRevision: number;
  readonly impactReportDigest: string;
  readonly candidateStatus: 'open' | 'dismissed' | 'superseded' | 'resolved';
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly currentBaseBranch: string;
  readonly currentGithubRepositoryId: string;
  readonly installationStatus: 'active' | 'suspended' | 'removed';
  readonly snapshotStatus: 'available' | 'expired' | 'deleted';
  readonly commitSha: string;
  readonly currentSnapshotDigest: string;
  readonly snapshotExpiresAt: Date;
  readonly trustState: 'draft' | 'reviewed' | 'vendor_verified';
  readonly specificationRevision: number;
  readonly evidenceDigest: string;
  readonly reportRevision: number;
  readonly artifactDigest: string;
  readonly revokedApprovalId: string | null;
}

export function isMigrationApprovalStale(
  approval: MigrationApprovalState | undefined,
  now: Date,
): boolean {
  return (
    approval?.revokedApprovalId !== null ||
    (approval.expiresAt !== null && approval.expiresAt <= now) ||
    approval.approvedBaseBranch !== approval.currentBaseBranch ||
    approval.approvedGithubRepositoryId !== approval.currentGithubRepositoryId ||
    approval.candidateStatus !== 'open' ||
    !approval.selected ||
    !approval.enabled ||
    approval.archived ||
    approval.installationStatus !== 'active' ||
    approval.snapshotStatus !== 'available' ||
    approval.snapshotExpiresAt <= now ||
    approval.baseCommitSha !== approval.commitSha ||
    approval.approvedSnapshotDigest !== approval.currentSnapshotDigest ||
    approval.trustState === 'draft' ||
    approval.migrationSpecificationRevision !== approval.specificationRevision ||
    approval.migrationSpecificationDigest !== approval.evidenceDigest ||
    approval.impactReportRevision !== approval.reportRevision ||
    approval.impactReportDigest !== approval.artifactDigest
  );
}

async function validateMigrationApproval(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
): Promise<'running' | 'stale' | 'cancelled'> {
  return database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('migrationRuns')
      .select([
        'id',
        'organisationId',
        'candidateId',
        'approvalId',
        'repositoryId',
        'status',
        'currentStage',
        'attempt',
        'version',
        'cancellationRequestedAt',
      ])
      .where('id', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirst();
    if (
      run?.candidateId !== workflow.candidateId ||
      run.approvalId !== workflow.approvalId ||
      run.repositoryId !== workflow.repositoryId ||
      run.attempt !== workflow.expectedAttempt
    ) {
      throw new Error('The migration workflow identity does not match its run.');
    }
    if (run.status === 'cancelled') return 'cancelled';
    if (
      run.cancellationRequestedAt !== null &&
      ['queued', 'running'].includes(run.status)
    ) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    const alreadyRunning =
      run.status === 'running' &&
      run.currentStage === 'revalidating' &&
      run.version === workflow.expectedVersion + 1;
    if (run.status === 'stale') return 'stale';
    if (
      !alreadyRunning &&
      (run.status !== 'queued' || run.version !== workflow.expectedVersion)
    ) {
      throw new Error('The migration run is not in the expected queued state.');
    }

    const approval = await loadMigrationApprovalState(transaction, workflow);
    const now = new Date();
    const stale = isMigrationApprovalStale(approval, now);
    if (stale) {
      await transaction
        .updateTable('migrationRuns')
        .set({
          status: 'stale',
          currentStage: 'stale',
          terminalResult: 'stale',
          safeErrorCode: 'MIGRATION_APPROVAL_STALE',
          completedAt: now,
          updatedAt: now,
          version: run.version + 1,
        })
        .where('id', '=', run.id)
        .where('version', '=', run.version)
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${run.id}:stale`,
        eventType: 'run_stale',
        status: 'stale',
        stage: 'stale',
        safeErrorCode: 'MIGRATION_APPROVAL_STALE',
        createdAt: now,
      });
      return 'stale';
    }
    if (alreadyRunning) return 'running';
    const updated = await transaction
      .updateTable('migrationRuns')
      .set({
        status: 'running',
        currentStage: 'revalidating',
        startedAt: now,
        updatedAt: now,
        version: run.version + 1,
      })
      .where('id', '=', run.id)
      .where('status', '=', 'queued')
      .where('version', '=', run.version)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new Error('The migration run changed during approval validation.');
    }
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${run.id}:approval-validated:${String(run.attempt)}`,
      eventType: 'approval_validated',
      status: 'running',
      stage: 'revalidating',
      safeErrorCode: null,
      createdAt: now,
    });
    return 'running';
  });
}

async function loadMigrationApprovalState(
  transaction: Transaction<Database>,
  workflow: MigrationWorkflowInput,
): Promise<MigrationApprovalState | undefined> {
  return transaction
    .selectFrom('migrationApprovals as approval')
    .innerJoin('migrationCandidates as candidate', join =>
      join
        .onRef('candidate.id', '=', 'approval.candidateId')
        .onRef('candidate.organisationId', '=', 'approval.organisationId')
        .onRef('candidate.repositoryId', '=', 'approval.repositoryId'),
    )
    .innerJoin('repositories as repository', join =>
      join
        .onRef('repository.id', '=', 'approval.repositoryId')
        .onRef('repository.organisationId', '=', 'approval.organisationId')
        .onRef('repository.installationId', '=', 'approval.installationId'),
    )
    .innerJoin(
      'githubInstallations as installation',
      'installation.id',
      'approval.installationId',
    )
    .innerJoin(
      'repositorySnapshots as snapshot',
      'snapshot.id',
      'approval.repositorySnapshotId',
    )
    .innerJoin(
      'migrationSpecifications as specification',
      'specification.id',
      'approval.migrationSpecificationId',
    )
    .innerJoin('impactReports as report', 'report.id', 'approval.impactReportId')
    .leftJoin(
      'migrationApprovalRevocations as revocation',
      'revocation.approvalId',
      'approval.id',
    )
    .select([
      'approval.expiresAt',
      'approval.baseBranch as approvedBaseBranch',
      'approval.baseCommitSha',
      'approval.githubRepositoryId as approvedGithubRepositoryId',
      'approval.snapshotDigest as approvedSnapshotDigest',
      'approval.migrationSpecificationRevision',
      'approval.migrationSpecificationDigest',
      'approval.impactReportRevision',
      'approval.impactReportDigest',
      'candidate.status as candidateStatus',
      'repository.selected',
      'repository.enabled',
      'repository.archived',
      'repository.defaultBranch as currentBaseBranch',
      'repository.githubRepositoryId as currentGithubRepositoryId',
      'installation.status as installationStatus',
      'snapshot.status as snapshotStatus',
      'snapshot.commitSha',
      'snapshot.digest as currentSnapshotDigest',
      'snapshot.expiresAt as snapshotExpiresAt',
      'specification.trustState',
      'specification.revision as specificationRevision',
      'specification.evidenceDigest',
      'report.revision as reportRevision',
      'report.artifactDigest',
      'revocation.approvalId as revokedApprovalId',
    ])
    .where('approval.id', '=', workflow.approvalId)
    .where('approval.organisationId', '=', workflow.organisationId)
    .where('approval.candidateId', '=', workflow.candidateId)
    .where('approval.repositoryId', '=', workflow.repositoryId)
    .executeTakeFirst();
}

async function enterMigrationAcquisition(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
): Promise<'running' | 'cancelled'> {
  return database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('migrationRuns')
      .select([
        'candidateId',
        'approvalId',
        'repositoryId',
        'status',
        'currentStage',
        'attempt',
        'version',
        'cancellationRequestedAt',
      ])
      .where('id', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      run.candidateId !== workflow.candidateId ||
      run.approvalId !== workflow.approvalId ||
      run.repositoryId !== workflow.repositoryId ||
      run.attempt !== workflow.expectedAttempt
    ) {
      throw new Error('The migration workflow identity does not match its run.');
    }
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    if (run.status === 'running' && run.currentStage === 'acquiring') {
      return 'running';
    }
    if (run.status !== 'running' || run.currentStage !== 'revalidating') {
      throw new Error('The migration run cannot enter acquisition.');
    }
    const now = new Date();
    await transaction
      .updateTable('migrationRuns')
      .set({
        currentStage: 'acquiring',
        updatedAt: now,
        version: run.version + 1,
      })
      .where('id', '=', workflow.migrationRunId)
      .where('version', '=', run.version)
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:stage:acquiring:${String(run.attempt)}`,
      eventType: 'stage_entered',
      status: 'running',
      stage: 'acquiring',
      safeErrorCode: null,
      createdAt: now,
    });
    return 'running';
  });
}

async function ingestMigrationAcquisition(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<'completed' | 'failed' | 'stale' | 'cancelled'> {
  const key = migrationAcquisitionResultKey(
    dependency.config.APP_ENVIRONMENT,
    workflow.organisationId,
    workflow.migrationRunId,
  );
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: key,
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > MAX_RESULT_BYTES
  ) {
    throw new Error('The migration acquisition result has an invalid size.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new Error('The migration acquisition result could not be read completely.');
  }
  const result = migrationAcquisitionResultSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8')),
  );
  if (
    result.organisationId !== workflow.organisationId ||
    result.repositoryId !== workflow.repositoryId ||
    result.migrationRunId !== workflow.migrationRunId ||
    result.approvalId !== workflow.approvalId
  ) {
    throw new Error('The migration acquisition result has invalid ownership.');
  }
  if (result.status === 'succeeded' && result.snapshot !== null) {
    const expectedKey = migrationSourceSnapshotKey(
      dependency.config.APP_ENVIRONMENT,
      workflow.organisationId,
      workflow.migrationRunId,
      result.snapshot.commitSha,
    );
    if (result.snapshot.objectKey !== expectedKey) {
      throw new Error('The migration source snapshot has an invalid object key.');
    }
    const head = await dependency.s3.send(
      new HeadObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: expectedKey,
      }),
    );
    const metadata = head.Metadata;
    if (metadata === undefined) {
      throw new Error('The migration source snapshot metadata is missing.');
    }
    if (
      head.ContentLength !== result.snapshot.bytes ||
      head.ContentType !== 'application/gzip' ||
      metadata.digest !== result.snapshot.digest ||
      metadata['migration-run-id'] !== workflow.migrationRunId ||
      metadata['approval-id'] !== workflow.approvalId ||
      metadata['commit-sha'] !== result.snapshot.commitSha
    ) {
      throw new Error('The migration source snapshot metadata is invalid.');
    }
  }

  return dependency.database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('migrationRuns as run')
      .innerJoin('migrationApprovals as approval', join =>
        join
          .onRef('approval.id', '=', 'run.approvalId')
          .onRef('approval.organisationId', '=', 'run.organisationId')
          .onRef('approval.repositoryId', '=', 'run.repositoryId'),
      )
      .select([
        'run.status',
        'run.currentStage',
        'run.attempt',
        'run.version',
        'run.baseCommitSha',
        'run.cancellationRequestedAt',
        'approval.snapshotDigest',
      ])
      .where('run.id', '=', workflow.migrationRunId)
      .where('run.organisationId', '=', workflow.organisationId)
      .where('run.candidateId', '=', workflow.candidateId)
      .where('run.approvalId', '=', workflow.approvalId)
      .where('run.repositoryId', '=', workflow.repositoryId)
      .forUpdate('run')
      .executeTakeFirstOrThrow();
    if (run.attempt !== workflow.expectedAttempt) {
      throw new Error('The migration acquisition attempt does not match its run.');
    }
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    const approval = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approval, new Date())) {
      await markMigrationStale(
        transaction,
        workflow,
        run.version,
        'MIGRATION_APPROVAL_STALE',
      );
      return 'stale';
    }
    const existing = await transaction
      .selectFrom('migrationArtifacts')
      .select(['digest', 'objectKey'])
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .where('artifactType', '=', 'source_snapshot')
      .executeTakeFirst();
    if (existing) {
      const snapshot = result.snapshot;
      if (
        existing.digest !== snapshot?.digest ||
        existing.objectKey !== snapshot.objectKey
      ) {
        throw new Error('A migration source snapshot cannot be replaced.');
      }
      return 'completed';
    }
    if (run.status !== 'running' || run.currentStage !== 'acquiring') {
      throw new Error('The migration run cannot ingest source acquisition.');
    }
    if (
      result.status === 'stale' ||
      (result.snapshot !== null &&
        (result.snapshot.commitSha !== run.baseCommitSha ||
          result.snapshot.digest !== run.snapshotDigest))
    ) {
      await markMigrationStale(transaction, workflow, run.version);
      return 'stale';
    }
    if (result.status !== 'succeeded' || result.snapshot === null) {
      await markMigrationFailedInTransaction(
        transaction,
        workflow,
        run.version,
        result.status === 'unsupported'
          ? 'MIGRATION_SOURCE_UNSUPPORTED'
          : 'MIGRATION_SOURCE_ACQUISITION_FAILED',
        'acquiring',
      );
      return 'failed';
    }
    const now = new Date();
    await transaction
      .insertInto('migrationArtifacts')
      .values({
        id: randomUUID(),
        organisationId: workflow.organisationId,
        migrationRunId: workflow.migrationRunId,
        artifactType: 'source_snapshot',
        objectKey: result.snapshot.objectKey,
        digest: result.snapshot.digest,
        bytes: result.snapshot.bytes,
        mediaType: 'application/gzip',
        retentionClass: 'workflow_ephemeral',
        createdAt: now,
        expiresAt: new Date(result.snapshot.expiresAt),
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('migrationRuns')
      .set({
        currentStage: 'planning',
        updatedAt: now,
        version: run.version + 1,
      })
      .where('id', '=', workflow.migrationRunId)
      .where('version', '=', run.version)
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:source-acquired:${String(run.attempt)}`,
      eventType: 'source_acquired',
      status: 'running',
      stage: 'acquiring',
      safeErrorCode: null,
      createdAt: now,
    });
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:stage:planning:${String(run.attempt)}`,
      eventType: 'stage_entered',
      status: 'running',
      stage: 'planning',
      safeErrorCode: null,
      createdAt: now,
    });
    return 'completed';
  });
}

async function evaluateMigrationStageCapability(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
  stage: MigrationExecutionStage,
): Promise<z.infer<typeof migrationStageCapabilityStatusSchema>> {
  return database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('migrationRuns')
      .select([
        'candidateId',
        'approvalId',
        'repositoryId',
        'status',
        'currentStage',
        'attempt',
        'version',
        'cancellationRequestedAt',
      ])
      .where('id', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      run.candidateId !== workflow.candidateId ||
      run.approvalId !== workflow.approvalId ||
      run.repositoryId !== workflow.repositoryId ||
      run.attempt !== workflow.expectedAttempt
    ) {
      throw new Error('The migration workflow identity does not match its run.');
    }
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    if (run.status !== 'running' || run.currentStage !== stage) {
      throw new Error('The migration stage capability check is out of sequence.');
    }
    return 'unavailable';
  });
}

type StageUnavailableSafeErrorCode =
  | 'MIGRATION_ACQUISITION_NOT_IMPLEMENTED'
  | 'MIGRATION_AGENT_NOT_IMPLEMENTED'
  | 'MIGRATION_VERIFICATION_NOT_IMPLEMENTED'
  | 'MIGRATION_PUBLICATION_NOT_IMPLEMENTED';

export function stageUnavailableSafeErrorCode(
  stage: MigrationExecutionStage,
): StageUnavailableSafeErrorCode {
  if (stage === 'acquiring') return 'MIGRATION_ACQUISITION_NOT_IMPLEMENTED';
  if (stage === 'planning' || stage === 'patching') {
    return 'MIGRATION_AGENT_NOT_IMPLEMENTED';
  }
  if (stage === 'verifying' || stage === 'repairing') {
    return 'MIGRATION_VERIFICATION_NOT_IMPLEMENTED';
  }
  return 'MIGRATION_PUBLICATION_NOT_IMPLEMENTED';
}

async function markMigrationFailed(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
  safeErrorCode:
    | StageUnavailableSafeErrorCode
    | 'MIGRATION_REPAIR_BUDGET_EXHAUSTED'
    | 'MIGRATION_CONTROL_INFRASTRUCTURE_FAILED',
  expectedStage?: MigrationExecutionStage,
): Promise<'failed' | 'cancelled'> {
  return database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('migrationRuns')
      .select([
        'status',
        'currentStage',
        'safeErrorCode',
        'version',
        'cancellationRequestedAt',
      ])
      .where('id', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .where('candidateId', '=', workflow.candidateId)
      .where('approvalId', '=', workflow.approvalId)
      .where('repositoryId', '=', workflow.repositoryId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (run.status === 'failed' && run.safeErrorCode === safeErrorCode) {
      return 'failed';
    }
    if (run.status === 'cancelled') return 'cancelled';
    if (!['queued', 'running'].includes(run.status)) return 'failed';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    if (expectedStage !== undefined && run.currentStage !== expectedStage) {
      throw new Error('The migration stage failure is out of sequence.');
    }
    await markMigrationFailedInTransaction(
      transaction,
      workflow,
      run.version,
      safeErrorCode,
      expectedStage,
    );
    return 'failed';
  });
}

async function markMigrationFailedInTransaction(
  transaction: Transaction<Database>,
  workflow: MigrationWorkflowInput,
  version: number,
  safeErrorCode: string,
  expectedStage?: MigrationExecutionStage,
): Promise<void> {
  const now = new Date();
  let update = transaction
    .updateTable('migrationRuns')
    .set({
      status: 'failed',
      currentStage: 'failed',
      terminalResult: 'failed',
      safeErrorCode,
      completedAt: now,
      updatedAt: now,
      version: version + 1,
    })
    .where('id', '=', workflow.migrationRunId)
    .where('organisationId', '=', workflow.organisationId)
    .where('version', '=', version);
  if (expectedStage !== undefined) {
    update = update.where('currentStage', '=', expectedStage);
  }
  await update.executeTakeFirstOrThrow();
  await appendMigrationRunEvent(transaction, {
    workflow,
    eventKey: `run:${workflow.migrationRunId}:failed:${safeErrorCode}`,
    eventType: 'run_failed',
    status: 'failed',
    stage: 'failed',
    safeErrorCode,
    createdAt: now,
  });
}

async function markMigrationStale(
  transaction: Transaction<Database>,
  workflow: MigrationWorkflowInput,
  version: number,
  safeErrorCode = 'MIGRATION_SNAPSHOT_DIGEST_MISMATCH',
): Promise<void> {
  const now = new Date();
  await transaction
    .updateTable('migrationRuns')
    .set({
      status: 'stale',
      currentStage: 'stale',
      terminalResult: 'stale',
      safeErrorCode,
      completedAt: now,
      updatedAt: now,
      version: version + 1,
    })
    .where('id', '=', workflow.migrationRunId)
    .where('organisationId', '=', workflow.organisationId)
    .where('version', '=', version)
    .executeTakeFirstOrThrow();
  await appendMigrationRunEvent(transaction, {
    workflow,
    eventKey: `run:${workflow.migrationRunId}:stale:${safeErrorCode}`,
    eventType: 'run_stale',
    status: 'stale',
    stage: 'stale',
    safeErrorCode,
    createdAt: now,
  });
}

async function markMigrationCancelled(
  transaction: Transaction<Database>,
  workflow: MigrationWorkflowInput,
  version: number,
): Promise<void> {
  const now = new Date();
  await transaction
    .updateTable('migrationRuns')
    .set({
      status: 'cancelled',
      currentStage: 'cancelled',
      terminalResult: 'cancelled',
      safeErrorCode: null,
      completedAt: now,
      updatedAt: now,
      version: version + 1,
    })
    .where('id', '=', workflow.migrationRunId)
    .where('organisationId', '=', workflow.organisationId)
    .where('version', '=', version)
    .executeTakeFirstOrThrow();
  await appendMigrationRunEvent(transaction, {
    workflow,
    eventKey: `run:${workflow.migrationRunId}:cancelled`,
    eventType: 'run_cancelled',
    status: 'cancelled',
    stage: 'cancelled',
    safeErrorCode: null,
    createdAt: now,
  });
}

interface SystemMigrationRunEvent {
  readonly workflow: MigrationWorkflowInput;
  readonly eventKey: string;
  readonly eventType:
    | 'approval_validated'
    | 'stage_entered'
    | 'source_acquired'
    | 'run_cancelled'
    | 'run_failed'
    | 'run_stale';
  readonly status: 'running' | 'failed' | 'cancelled' | 'stale';
  readonly stage:
    'revalidating' | 'acquiring' | 'planning' | 'failed' | 'cancelled' | 'stale';
  readonly safeErrorCode: string | null;
  readonly createdAt: Date;
}

async function appendMigrationRunEvent(
  transaction: Transaction<Database>,
  input: SystemMigrationRunEvent,
): Promise<void> {
  const existing = await transaction
    .selectFrom('migrationRunEvents')
    .select('id')
    .where('migrationRunId', '=', input.workflow.migrationRunId)
    .where('eventKey', '=', input.eventKey)
    .executeTakeFirst();
  if (existing) return;
  const latest = await transaction
    .selectFrom('migrationRunEvents')
    .select('sequence')
    .where('migrationRunId', '=', input.workflow.migrationRunId)
    .orderBy('sequence', 'desc')
    .executeTakeFirst();
  await transaction
    .insertInto('migrationRunEvents')
    .values({
      id: randomUUID(),
      organisationId: input.workflow.organisationId,
      migrationRunId: input.workflow.migrationRunId,
      sequence: (latest?.sequence ?? 0) + 1,
      eventKey: input.eventKey,
      eventType: input.eventType,
      status: input.status,
      stage: input.stage,
      safeErrorCode: input.safeErrorCode,
      actorType: 'system',
      actorUserId: null,
      requestId: input.workflow.correlationId,
      createdAt: input.createdAt,
    })
    .executeTakeFirstOrThrow();
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

function migrationAcquisitionResultKey(
  environment: string,
  organisationId: string,
  migrationRunId: string,
): string {
  return `env/${environment}/org/${organisationId}/run/${migrationRunId}/input/acquisition-result.json`;
}

function migrationSourceSnapshotKey(
  environment: string,
  organisationId: string,
  migrationRunId: string,
  commitSha: string,
): string {
  return `env/${environment}/org/${organisationId}/run/${migrationRunId}/input/source/${commitSha}.tar.gz`;
}
