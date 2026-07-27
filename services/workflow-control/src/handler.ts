import { createHash, randomUUID } from 'node:crypto';

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Context } from 'aws-lambda';
import { z } from 'zod';

import {
  agentResultEnvelopeSchema,
  githubPublicationAccessResultSchema,
  migrationAgentInputArtifactSchema,
  migrationAgentPreparedInputSchema,
  migrationAgentResultSchema,
  migrationApprovalPatchPolicySchema,
  migrationApprovalVerificationProfileSchema,
  migrationAcquisitionResultSchema,
  migrationSpecificationSchema,
  migrationVerificationPreparedInputSchema,
  migrationVerificationDispatchSchema,
  migrationVerificationResultSchema,
  migrationVerificationWorkItemSchema,
  publicationAttemptBindingSchema,
  migrationWorkflowInputSchema,
  workflowInputSchema,
  type AgentResultEnvelope,
  type MigrationAgentInputArtifact,
  type MigrationAgentPreparedInput,
  type MigrationAgentResult,
  type MigrationVerificationPreparedInput,
  type MigrationVerificationDispatch,
  type MigrationWorkflowInput,
  type GithubPublicationAccess,
  type GithubPublicationAccessResult,
} from '@migration/contracts';
import {
  parseConfig,
  workflowControlConfigSchema,
  type WorkflowControlConfig,
} from '@migration/config';
import {
  createDatabase,
  type AppDatabase,
  type Database,
  type MigrationRunTable,
} from '@migration/database';
import { sql, type Selectable, type Transaction } from 'kysely';
import type { TerminalCode } from '@migration/domain';
import { writeLog } from '@migration/observability';

const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_MIGRATION_AGENT_RESULT_BYTES = 2 * 1024 * 1024;

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
      operation: z.literal('prepare_migration_agent'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_migration_plan'),
      workflow: migrationWorkflowInputSchema,
      prepared: migrationAgentPreparedInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_migration_patch'),
      workflow: migrationWorkflowInputSchema,
      prepared: migrationAgentPreparedInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('prepare_migration_verification'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('prepare_migration_repair'),
      workflow: migrationWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_migration_verification'),
      workflow: migrationWorkflowInputSchema,
      prepared: migrationVerificationDispatchSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('prepare_migration_publication'),
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
  readonly lambda: LambdaClient;
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
    lambda: new LambdaClient({ region: config.AWS_REGION }),
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
): Promise<
  | {
      readonly status: string;
      readonly stage?: MigrationExecutionStage;
    }
  | MigrationAgentPreparedInput
  | MigrationVerificationPreparedInput
> {
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
  if (command.operation === 'prepare_migration_agent') {
    const prepared = await prepareMigrationAgent(dependency, command.workflow);
    writeLog('info', {
      event: 'migration_agent_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: prepared.status,
    });
    return prepared;
  }
  if (command.operation === 'ingest_migration_plan') {
    const status = await ingestMigrationPlan(
      dependency,
      command.workflow,
      command.prepared,
    );
    writeLog(status === 'completed' ? 'info' : 'warn', {
      event: 'migration_plan_ingested',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status, stage: 'planning' };
  }
  if (command.operation === 'ingest_migration_patch') {
    const status = await ingestMigrationPatch(
      dependency,
      command.workflow,
      command.prepared,
    );
    writeLog(status === 'completed' ? 'info' : 'warn', {
      event: 'migration_patch_ingested',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status, stage: 'patching' };
  }
  if (command.operation === 'prepare_migration_verification') {
    const prepared = await prepareMigrationVerification(dependency, command.workflow);
    writeLog('info', {
      event: 'migration_verification_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: prepared.status,
      ...(prepared.status === 'ready'
        ? { verificationAttemptId: prepared.verificationAttemptId }
        : {}),
    });
    return prepared;
  }
  if (command.operation === 'prepare_migration_repair') {
    const prepared = await prepareMigrationRepair(dependency, command.workflow);
    writeLog('info', {
      event: 'migration_repair_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: prepared.status,
      ...(prepared.status === 'ready' ? { repairAttempt: prepared.attemptNumber } : {}),
    });
    return prepared;
  }
  if (command.operation === 'ingest_migration_verification') {
    const status = await ingestMigrationVerification(
      dependency,
      command.workflow,
      command.prepared,
    );
    writeLog(status === 'completed' ? 'info' : 'warn', {
      event: 'migration_verification_ingested',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: status,
    });
    return { status, stage: 'verifying' };
  }
  if (command.operation === 'prepare_migration_publication') {
    const prepared = await prepareMigrationPublication(dependency, command.workflow);
    writeLog(prepared.status === 'completed' ? 'info' : 'warn', {
      event: 'migration_publication_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      migrationRunId: command.workflow.migrationRunId,
      outcome: prepared.status,
      ...(prepared.status === 'completed'
        ? { publicationAttemptId: prepared.publicationAttemptId }
        : {}),
    });
    return prepared;
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

const storedImpactSummarySchema = z
  .object({
    affectedFiles: z
      .array(
        z
          .object({
            path: z.string(),
            classification: z.enum([
              'dependency_manifest',
              'lockfile',
              'direct_usage',
              'indirect_usage',
              'test',
            ]),
            symbols: z.array(z.string()),
            expectedChanges: z.array(z.string()),
          })
          .loose(),
      )
      .min(1)
      .max(500),
  })
  .loose();

const storedUncertaintiesSchema = z
  .array(
    z
      .object({
        code: z.string(),
        summary: z.string(),
      })
      .loose(),
  )
  .max(50);

async function prepareMigrationAgent(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<MigrationAgentPreparedInput | { readonly status: 'cancelled' | 'stale' }> {
  const preparation = await dependency.database
    .transaction()
    .execute(async transaction => {
      const run = await transaction
        .selectFrom('migrationRuns as run')
        .innerJoin('migrationApprovals as approval', join =>
          join
            .onRef('approval.id', '=', 'run.approvalId')
            .onRef('approval.organisationId', '=', 'run.organisationId'),
        )
        .innerJoin(
          'migrationSpecifications as specification',
          'specification.id',
          'approval.migrationSpecificationId',
        )
        .innerJoin('impactReports as report', 'report.id', 'approval.impactReportId')
        .innerJoin('migrationArtifacts as snapshot', join =>
          join
            .onRef('snapshot.migrationRunId', '=', 'run.id')
            .onRef('snapshot.organisationId', '=', 'run.organisationId')
            .on('snapshot.artifactType', '=', 'source_snapshot'),
        )
        .select([
          'run.status',
          'run.currentStage',
          'run.attempt',
          'run.version',
          'run.cancellationRequestedAt',
          'approval.baseCommitSha',
          'approval.snapshotDigest',
          'approval.migrationSpecificationId',
          'approval.migrationSpecificationRevision',
          'approval.migrationSpecificationDigest',
          'approval.impactReportId',
          'approval.impactReportRevision',
          'approval.impactReportDigest',
          'approval.agentPolicyVersion',
          'approval.toolRegistryVersion',
          'approval.patchPolicyVersion',
          'approval.patchPolicy',
          'approval.patchPolicyDigest',
          'specification.specification',
          'report.outcome',
          'report.affectedSummary',
          'report.riskCategory',
          'report.uncertainty',
          'snapshot.objectKey as snapshotObjectKey',
          'snapshot.digest as acquiredSnapshotDigest',
        ])
        .where('run.id', '=', workflow.migrationRunId)
        .where('run.organisationId', '=', workflow.organisationId)
        .where('run.candidateId', '=', workflow.candidateId)
        .where('run.approvalId', '=', workflow.approvalId)
        .where('run.repositoryId', '=', workflow.repositoryId)
        .forUpdate('run')
        .executeTakeFirstOrThrow();
      if (run.status === 'cancelled') {
        return { status: 'cancelled' as const, source: null };
      }
      if (run.cancellationRequestedAt !== null) {
        await markMigrationCancelled(transaction, workflow, run.version);
        return { status: 'cancelled' as const, source: null };
      }
      if (
        run.status !== 'running' ||
        run.currentStage !== 'planning' ||
        run.attempt !== workflow.expectedAttempt
      ) {
        throw new Error('The migration run cannot prepare the migration agent.');
      }
      const approval = await loadMigrationApprovalState(transaction, workflow);
      if (isMigrationApprovalStale(approval, new Date())) {
        await markMigrationStale(transaction, workflow, run.version);
        return { status: 'stale' as const, source: null };
      }
      return { status: 'ready' as const, source: run };
    });
  if (preparation.source === null) return { status: preparation.status };
  const source = preparation.source;
  if (
    source.outcome !== 'affected' ||
    source.snapshotDigest !== source.acquiredSnapshotDigest
  ) {
    throw new Error('The migration-agent evidence binding is invalid.');
  }
  const specification = migrationSpecificationSchema.parse(source.specification);
  const affected = storedImpactSummarySchema.parse(source.affectedSummary);
  const uncertainties = storedUncertaintiesSchema.parse(source.uncertainty);
  const patchPolicy = migrationApprovalPatchPolicySchema.parse(source.patchPolicy);
  const prefix = migrationAgentAttemptPrefix(
    dependency.config.APP_ENVIRONMENT,
    workflow.organisationId,
    workflow.migrationRunId,
    source.attempt,
  );
  const inputObjectKey = `${prefix}/context.json`;
  const resultObjectKey = `${prefix}/result.json`;
  const input = migrationAgentInputArtifactSchema.parse({
    schemaVersion: '1.0',
    organisationId: workflow.organisationId,
    repositoryId: workflow.repositoryId,
    binding: {
      migrationRunId: workflow.migrationRunId,
      approvalId: workflow.approvalId,
      baseCommitSha: source.baseCommitSha,
      snapshotDigest: source.snapshotDigest,
      migrationSpecification: {
        id: source.migrationSpecificationId,
        revision: source.migrationSpecificationRevision,
        digest: source.migrationSpecificationDigest,
      },
      impactReport: {
        id: source.impactReportId,
        revision: source.impactReportRevision,
        digest: source.impactReportDigest,
      },
    },
    attemptNumber: source.attempt,
    snapshot: {
      objectKey: source.snapshotObjectKey,
      digest: source.acquiredSnapshotDigest,
    },
    migrationSpecification: specification,
    impact: {
      outcome: 'affected',
      affectedFiles: affected.affectedFiles.map(file => ({
        path: file.path,
        classification: file.classification,
        symbols: file.symbols,
        expectedChanges: file.expectedChanges,
      })),
      risk: source.riskCategory,
      uncertainties: uncertainties.map(item => ({
        code: item.code,
        summary: item.summary,
      })),
    },
    authority: {
      agentPolicyVersion: source.agentPolicyVersion,
      toolRegistryVersion: source.toolRegistryVersion,
      patchPolicyVersion: source.patchPolicyVersion,
      patchPolicy,
      patchPolicyDigest: source.patchPolicyDigest,
    },
  });
  const body = Buffer.from(JSON.stringify(input), 'utf8');
  const inputDigest = sha256(body);
  await putImmutableObject(
    dependency,
    inputObjectKey,
    body,
    'application/json',
    inputDigest,
    workflow.migrationRunId,
  );
  return migrationAgentPreparedInputSchema.parse({
    status: 'ready',
    organisationId: workflow.organisationId,
    repositoryId: workflow.repositoryId,
    migrationRunId: workflow.migrationRunId,
    attemptNumber: source.attempt,
    inputObjectKey,
    inputDigest,
    resultObjectKey,
  });
}

async function prepareMigrationRepair(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<MigrationAgentPreparedInput | { readonly status: 'cancelled' | 'stale' }> {
  const source = await dependency.database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return { status: 'cancelled' as const };
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return { status: 'cancelled' as const };
    }
    if (run.status !== 'running' || run.currentStage !== 'repairing') {
      throw new Error('The migration run cannot prepare a repair.');
    }
    const approval = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approval, new Date())) {
      await markMigrationStale(transaction, workflow, run.version);
      return { status: 'stale' as const };
    }
    const previous = await transaction
      .selectFrom('patchAttempts as patch')
      .innerJoin('migrationArtifacts as patchArtifact', join =>
        join
          .onRef('patchArtifact.id', '=', 'patch.patchArtifactId')
          .onRef('patchArtifact.organisationId', '=', 'patch.organisationId')
          .onRef('patchArtifact.migrationRunId', '=', 'patch.migrationRunId'),
      )
      .innerJoin(
        'verificationAttempts as verification',
        'verification.patchAttemptId',
        'patch.id',
      )
      .innerJoin(
        'verificationAttemptResults as verificationResult',
        'verificationResult.verificationAttemptId',
        'verification.id',
      )
      .innerJoin('migrationArtifacts as resultArtifact', join =>
        join
          .onRef('resultArtifact.id', '=', 'verificationResult.resultArtifactId')
          .onRef('resultArtifact.organisationId', '=', 'patch.organisationId')
          .onRef('resultArtifact.migrationRunId', '=', 'patch.migrationRunId'),
      )
      .select([
        'patch.id as patchAttemptId',
        'patch.attemptNumber',
        'patch.patchDigest',
        'patchArtifact.objectKey as patchObjectKey',
        'patchArtifact.digest as patchArtifactDigest',
        'patchArtifact.bytes as patchBytes',
        'verificationResult.outcome',
        'resultArtifact.objectKey as resultObjectKey',
        'resultArtifact.digest as resultDigest',
        'resultArtifact.bytes as resultBytes',
      ])
      .where('patch.organisationId', '=', workflow.organisationId)
      .where('patch.migrationRunId', '=', workflow.migrationRunId)
      .where('patch.status', '=', 'accepted')
      .where('verificationResult.outcome', '=', 'failed')
      .orderBy('patch.attemptNumber', 'desc')
      .executeTakeFirstOrThrow();
    const basePrefix = migrationAgentPrefix(
      dependency.config.APP_ENVIRONMENT,
      workflow.organisationId,
      workflow.migrationRunId,
    );
    const context = await transaction
      .selectFrom('migrationArtifacts')
      .select(['objectKey', 'digest', 'bytes'])
      .where('organisationId', '=', workflow.organisationId)
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('artifactType', '=', 'context_manifest')
      .where('objectKey', '=', `${basePrefix}/context.json`)
      .executeTakeFirstOrThrow();
    const attemptNumber = previous.attemptNumber + 1;
    if (attemptNumber > 3) {
      throw new Error('The migration repair budget has been exhausted.');
    }
    return {
      status: 'ready' as const,
      previous,
      context,
      attemptNumber,
    };
  });
  if (source.status !== 'ready') return source;
  const [contextBytes, patchBytes, resultBytes] = await Promise.all([
    readBoundedArtifact(dependency, source.context.objectKey, 4 * 1024 * 1024),
    readBoundedArtifact(dependency, source.previous.patchObjectKey, 1024 * 1024),
    readBoundedArtifact(dependency, source.previous.resultObjectKey, MAX_RESULT_BYTES),
  ]);
  if (
    contextBytes.byteLength !== Number(source.context.bytes) ||
    sha256(contextBytes) !== source.context.digest ||
    patchBytes.byteLength !== Number(source.previous.patchBytes) ||
    sha256(patchBytes) !== source.previous.patchArtifactDigest ||
    source.previous.patchDigest !== source.previous.patchArtifactDigest ||
    resultBytes.byteLength !== Number(source.previous.resultBytes) ||
    sha256(resultBytes) !== source.previous.resultDigest
  ) {
    throw new Error('The migration repair evidence digest is invalid.');
  }
  const original = migrationAgentInputArtifactSchema.parse(
    JSON.parse(contextBytes.toString('utf8')),
  );
  const verification = migrationVerificationResultSchema.parse(
    JSON.parse(resultBytes.toString('utf8')),
  );
  if (
    original.organisationId !== workflow.organisationId ||
    original.repositoryId !== workflow.repositoryId ||
    original.binding.migrationRunId !== workflow.migrationRunId ||
    verification.migrationRunId !== workflow.migrationRunId ||
    verification.patchAttemptId !== source.previous.patchAttemptId ||
    verification.patchDigest !== source.previous.patchDigest ||
    verification.outcome !== 'failed' ||
    verification.safeErrorCode === null
  ) {
    throw new Error('The migration repair evidence binding is invalid.');
  }
  const input = migrationAgentInputArtifactSchema.parse({
    ...original,
    attemptNumber: source.attemptNumber,
    repair: {
      previousPatchAttemptId: source.previous.patchAttemptId,
      previousPatchDigest: source.previous.patchDigest,
      previousPatch: new TextDecoder('utf-8', { fatal: true }).decode(patchBytes),
      verification: {
        outcome: 'failed',
        safeErrorCode: verification.safeErrorCode,
        commands: verification.commands,
      },
    },
  });
  const prefix = migrationAgentAttemptPrefix(
    dependency.config.APP_ENVIRONMENT,
    workflow.organisationId,
    workflow.migrationRunId,
    source.attemptNumber,
  );
  const inputObjectKey = `${prefix}/context.json`;
  const resultObjectKey = `${prefix}/result.json`;
  const body = Buffer.from(JSON.stringify(input), 'utf8');
  const inputDigest = sha256(body);
  await putImmutableObject(
    dependency,
    inputObjectKey,
    body,
    'application/json',
    inputDigest,
    workflow.migrationRunId,
  );
  return migrationAgentPreparedInputSchema.parse({
    status: 'ready',
    organisationId: workflow.organisationId,
    repositoryId: workflow.repositoryId,
    migrationRunId: workflow.migrationRunId,
    attemptNumber: source.attemptNumber,
    inputObjectKey,
    inputDigest,
    resultObjectKey,
  });
}

async function ingestMigrationPlan(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
  prepared: MigrationAgentPreparedInput,
): Promise<'completed' | 'failed' | 'cancelled' | 'stale'> {
  const repair = prepared.attemptNumber > workflow.expectedAttempt;
  const planStage: MigrationExecutionStage = repair ? 'repairing' : 'planning';
  const { input, inputBytes, result } = await readMigrationAgentArtifacts(
    dependency,
    workflow,
    prepared,
  );
  if (result.status === 'failed' || result.plan === null) {
    return markMigrationAgentFailed(
      dependency.database,
      workflow,
      planStage,
      'MIGRATION_AGENT_FAILED',
    );
  }
  const planBody = Buffer.from(JSON.stringify(result.plan), 'utf8');
  const planDigest = sha256(planBody);
  if (
    result.manifest?.planDigest !== planDigest ||
    !sameJson(result.plan.binding, input.binding)
  ) {
    throw new Error('The migration plan binding or digest is invalid.');
  }
  const prefix = migrationAgentAttemptPrefix(
    dependency.config.APP_ENVIRONMENT,
    workflow.organisationId,
    workflow.migrationRunId,
    prepared.attemptNumber,
  );
  const planKey = `${prefix}/plan.json`;
  await putImmutableObject(
    dependency,
    planKey,
    planBody,
    'application/json',
    planDigest,
    workflow.migrationRunId,
  );
  const planningCheckpoints = result.checkpoints.filter(
    checkpoint => checkpoint.phase !== 'patching',
  );
  const checkpointArtifacts = await Promise.all(
    planningCheckpoints.map(async checkpoint => {
      const body = Buffer.from(JSON.stringify(checkpoint), 'utf8');
      const digest = sha256(body);
      const key = `${prefix}/checkpoint-${String(checkpoint.sequence)}.json`;
      await putImmutableObject(
        dependency,
        key,
        body,
        'application/json',
        digest,
        workflow.migrationRunId,
      );
      return { checkpoint, body, digest, key };
    }),
  );

  return dependency.database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    const approval = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approval, new Date())) {
      await markMigrationStale(transaction, workflow, run.version);
      return 'stale';
    }
    const existing = await transaction
      .selectFrom('migrationPlans')
      .select(['id', 'artifactDigest'])
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('attemptNumber', '=', prepared.attemptNumber)
      .executeTakeFirst();
    if (existing) {
      if (existing.artifactDigest !== planDigest) {
        throw new Error('An immutable migration plan cannot be replaced.');
      }
      return 'completed';
    }
    if (run.status !== 'running' || run.currentStage !== planStage) {
      throw new Error('The migration run cannot ingest a plan.');
    }
    const now = new Date();
    const contextArtifactId = randomUUID();
    await insertMigrationArtifact(transaction, {
      id: contextArtifactId,
      workflow,
      artifactType: 'context_manifest',
      objectKey: prepared.inputObjectKey,
      digest: prepared.inputDigest,
      bytes: inputBytes.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    for (const artifact of checkpointArtifacts) {
      const artifactId = randomUUID();
      await insertMigrationArtifact(transaction, {
        id: artifactId,
        workflow,
        artifactType: 'agent_checkpoint',
        objectKey: artifact.key,
        digest: artifact.digest,
        bytes: artifact.body.byteLength,
        mediaType: 'application/json',
        createdAt: now,
      });
      await transaction
        .insertInto('migrationAgentCheckpoints')
        .values({
          id: randomUUID(),
          organisationId: workflow.organisationId,
          migrationRunId: workflow.migrationRunId,
          attemptNumber: prepared.attemptNumber,
          sequence: artifact.checkpoint.sequence,
          phase: artifact.checkpoint.phase,
          artifactId,
          artifactDigest: artifact.digest,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
    }
    const planArtifactId = randomUUID();
    await insertMigrationArtifact(transaction, {
      id: planArtifactId,
      workflow,
      artifactType: 'migration_plan',
      objectKey: planKey,
      digest: planDigest,
      bytes: planBody.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    await transaction
      .insertInto('migrationPlans')
      .values({
        id: randomUUID(),
        organisationId: workflow.organisationId,
        migrationRunId: workflow.migrationRunId,
        approvalId: workflow.approvalId,
        attemptNumber: prepared.attemptNumber,
        artifactId: planArtifactId,
        artifactDigest: planDigest,
        schemaVersion: '1.0',
        trustState: 'proposed',
        baseCommitSha: input.binding.baseCommitSha,
        snapshotDigest: input.binding.snapshotDigest,
        migrationSpecificationId: input.binding.migrationSpecification.id,
        migrationSpecificationRevision: input.binding.migrationSpecification.revision,
        migrationSpecificationDigest: input.binding.migrationSpecification.digest,
        impactReportId: input.binding.impactReport.id,
        impactReportRevision: input.binding.impactReport.revision,
        impactReportDigest: input.binding.impactReport.digest,
        createdAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('migrationRuns')
      .set({
        currentStage: 'patching',
        updatedAt: now,
        version: run.version + 1,
      })
      .where('id', '=', workflow.migrationRunId)
      .where('version', '=', run.version)
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:plan-created:${String(
        prepared.attemptNumber,
      )}`,
      eventType: 'plan_created',
      status: 'running',
      stage: planStage,
      safeErrorCode: null,
      createdAt: now,
    });
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:stage:patching:${String(
        prepared.attemptNumber,
      )}`,
      eventType: 'stage_entered',
      status: 'running',
      stage: 'patching',
      safeErrorCode: null,
      createdAt: now,
    });
    return 'completed';
  });
}

async function ingestMigrationPatch(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
  prepared: MigrationAgentPreparedInput,
): Promise<'completed' | 'failed' | 'cancelled' | 'stale'> {
  const { input, result } = await readMigrationAgentArtifacts(
    dependency,
    workflow,
    prepared,
  );
  if (
    result.status === 'failed' ||
    result.plan === null ||
    result.patch === null ||
    result.manifest === null ||
    result.validation === null
  ) {
    return markMigrationAgentFailed(
      dependency.database,
      workflow,
      'patching',
      'MIGRATION_AGENT_FAILED',
    );
  }
  if (
    !sameJson(result.manifest.binding, input.binding) ||
    !sameJson(result.validation.binding, input.binding) ||
    result.validation.policyDigest !== input.authority.patchPolicyDigest ||
    result.validation.policyVersion !== input.authority.patchPolicyVersion
  ) {
    throw new Error('The migration patch authority binding is invalid.');
  }
  const patchBody = Buffer.from(result.patch, 'utf8');
  const manifest = result.manifest;
  const validation = result.validation;
  const manifestBody = Buffer.from(JSON.stringify(manifest), 'utf8');
  const validationBody = Buffer.from(JSON.stringify(validation), 'utf8');
  const patchDigest = sha256(patchBody);
  const manifestDigest = sha256(manifestBody);
  const validationDigest = sha256(validationBody);
  if (manifest.patchDigest !== patchDigest || validation.patchDigest !== patchDigest) {
    throw new Error('The migration patch digest is invalid.');
  }
  const prefix = migrationAgentAttemptPrefix(
    dependency.config.APP_ENVIRONMENT,
    workflow.organisationId,
    workflow.migrationRunId,
    prepared.attemptNumber,
  );
  const patchKey = `${prefix}/proposal.diff`;
  const manifestKey = `${prefix}/patch-manifest.json`;
  const validationKey = `${prefix}/patch-validation.json`;
  await Promise.all([
    putImmutableObject(
      dependency,
      patchKey,
      patchBody,
      'text/x-diff',
      patchDigest,
      workflow.migrationRunId,
    ),
    putImmutableObject(
      dependency,
      manifestKey,
      manifestBody,
      'application/json',
      manifestDigest,
      workflow.migrationRunId,
    ),
    putImmutableObject(
      dependency,
      validationKey,
      validationBody,
      'application/json',
      validationDigest,
      workflow.migrationRunId,
    ),
  ]);
  const patchCheckpoint = result.checkpoints.find(
    checkpoint => checkpoint.phase === 'patching',
  );
  if (!patchCheckpoint) {
    throw new Error('The migration patch checkpoint is missing.');
  }
  const checkpointBody = Buffer.from(JSON.stringify(patchCheckpoint), 'utf8');
  const checkpointDigest = sha256(checkpointBody);
  const checkpointKey = `${prefix}/checkpoint-${String(patchCheckpoint.sequence)}.json`;
  await putImmutableObject(
    dependency,
    checkpointKey,
    checkpointBody,
    'application/json',
    checkpointDigest,
    workflow.migrationRunId,
  );

  return dependency.database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    const approval = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approval, new Date())) {
      await markMigrationStale(transaction, workflow, run.version);
      return 'stale';
    }
    const existing = await transaction
      .selectFrom('patchAttempts')
      .select(['status', 'patchDigest'])
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('attemptNumber', '=', prepared.attemptNumber)
      .executeTakeFirst();
    if (existing) {
      if (existing.patchDigest !== patchDigest) {
        throw new Error('An immutable patch attempt cannot be replaced.');
      }
      return existing.status === 'accepted' ? 'completed' : 'failed';
    }
    if (run.status !== 'running' || run.currentStage !== 'patching') {
      throw new Error('The migration run cannot ingest a patch.');
    }
    const plan = await transaction
      .selectFrom('migrationPlans')
      .select(['id', 'artifactDigest'])
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('attemptNumber', '=', prepared.attemptNumber)
      .executeTakeFirstOrThrow();
    if (plan.artifactDigest !== manifest.planDigest) {
      throw new Error('The patch is not bound to the stored migration plan.');
    }
    const now = new Date();
    const patchArtifactId = randomUUID();
    const manifestArtifactId = randomUUID();
    const validationArtifactId = randomUUID();
    const checkpointArtifactId = randomUUID();
    await insertMigrationArtifact(transaction, {
      id: patchArtifactId,
      workflow,
      artifactType: 'patch_proposal',
      objectKey: patchKey,
      digest: patchDigest,
      bytes: patchBody.byteLength,
      mediaType: 'text/x-diff',
      createdAt: now,
    });
    await insertMigrationArtifact(transaction, {
      id: manifestArtifactId,
      workflow,
      artifactType: 'patch_manifest',
      objectKey: manifestKey,
      digest: manifestDigest,
      bytes: manifestBody.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    await insertMigrationArtifact(transaction, {
      id: validationArtifactId,
      workflow,
      artifactType: 'patch_validation',
      objectKey: validationKey,
      digest: validationDigest,
      bytes: validationBody.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    await insertMigrationArtifact(transaction, {
      id: checkpointArtifactId,
      workflow,
      artifactType: 'agent_checkpoint',
      objectKey: checkpointKey,
      digest: checkpointDigest,
      bytes: checkpointBody.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    await transaction
      .insertInto('migrationAgentCheckpoints')
      .values({
        id: randomUUID(),
        organisationId: workflow.organisationId,
        migrationRunId: workflow.migrationRunId,
        attemptNumber: prepared.attemptNumber,
        sequence: patchCheckpoint.sequence,
        phase: patchCheckpoint.phase,
        artifactId: checkpointArtifactId,
        artifactDigest: checkpointDigest,
        createdAt: now,
      })
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto('patchAttempts')
      .values({
        id: randomUUID(),
        organisationId: workflow.organisationId,
        migrationRunId: workflow.migrationRunId,
        attemptNumber: prepared.attemptNumber,
        parentPatchAttemptId:
          prepared.attemptNumber === 1
            ? null
            : (
                await transaction
                  .selectFrom('patchAttempts')
                  .select('id')
                  .where('organisationId', '=', workflow.organisationId)
                  .where('migrationRunId', '=', workflow.migrationRunId)
                  .where('attemptNumber', '=', prepared.attemptNumber - 1)
                  .executeTakeFirstOrThrow()
              ).id,
        migrationPlanId: plan.id,
        patchArtifactId,
        patchDigest,
        validationArtifactId,
        validationDigest,
        policyVersion: validation.policyVersion,
        policyDigest: validation.policyDigest,
        status: validation.status === 'accepted' ? 'accepted' : 'rejected',
        safeErrorCode: validation.safeErrorCode,
        summaryCode:
          validation.status === 'accepted' ? 'PATCH_ACCEPTED' : 'PATCH_REJECTED',
        changedFiles: manifest.changedFiles,
        addedLines: manifest.addedLines,
        deletedLines: manifest.deletedLines,
        patchBytes: manifest.patchBytes,
        createdAt: now,
      })
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:patch-proposed:${String(
        prepared.attemptNumber,
      )}`,
      eventType: 'patch_proposed',
      status: 'running',
      stage: 'patching',
      safeErrorCode: null,
      createdAt: now,
    });
    if (validation.status === 'rejected') {
      await markMigrationFailedInTransaction(
        transaction,
        workflow,
        run.version,
        'MIGRATION_PATCH_REJECTED',
        'patching',
      );
      return 'failed';
    }
    await transaction
      .updateTable('migrationRuns')
      .set({
        currentStage: 'verifying',
        updatedAt: now,
        version: run.version + 1,
      })
      .where('id', '=', workflow.migrationRunId)
      .where('version', '=', run.version)
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:patch-validated:${String(
        prepared.attemptNumber,
      )}`,
      eventType: 'patch_validated',
      status: 'running',
      stage: 'patching',
      safeErrorCode: null,
      createdAt: now,
    });
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:stage:verifying:${String(
        prepared.attemptNumber,
      )}`,
      eventType: 'stage_entered',
      status: 'running',
      stage: 'verifying',
      safeErrorCode: null,
      createdAt: now,
    });
    return 'completed';
  });
}

async function prepareMigrationVerification(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<MigrationVerificationDispatch | { readonly status: 'cancelled' | 'stale' }> {
  const prepared = await prepareMigrationVerificationRecord(
    dependency.database,
    workflow,
  );
  if (prepared.status !== 'ready') return prepared;
  return createVerificationWorkItem(dependency, prepared);
}

async function prepareMigrationVerificationRecord(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
): Promise<
  MigrationVerificationPreparedInput | { readonly status: 'cancelled' | 'stale' }
> {
  return database.transaction().execute(async transaction => {
    const source = await transaction
      .selectFrom('migrationRuns as run')
      .innerJoin('migrationApprovals as approval', join =>
        join
          .onRef('approval.id', '=', 'run.approvalId')
          .onRef('approval.organisationId', '=', 'run.organisationId'),
      )
      .innerJoin('migrationArtifacts as snapshot', join =>
        join
          .onRef('snapshot.migrationRunId', '=', 'run.id')
          .onRef('snapshot.organisationId', '=', 'run.organisationId')
          .on('snapshot.artifactType', '=', 'source_snapshot'),
      )
      .innerJoin('patchAttempts as patch', join =>
        join
          .onRef('patch.migrationRunId', '=', 'run.id')
          .onRef('patch.organisationId', '=', 'run.organisationId')
          .on('patch.status', '=', 'accepted'),
      )
      .innerJoin('migrationArtifacts as patchArtifact', join =>
        join
          .onRef('patchArtifact.id', '=', 'patch.patchArtifactId')
          .onRef('patchArtifact.organisationId', '=', 'patch.organisationId')
          .onRef('patchArtifact.migrationRunId', '=', 'patch.migrationRunId')
          .onRef('patchArtifact.digest', '=', 'patch.patchDigest'),
      )
      .innerJoin('migrationArtifacts as patchValidation', join =>
        join
          .onRef('patchValidation.id', '=', 'patch.validationArtifactId')
          .onRef('patchValidation.organisationId', '=', 'patch.organisationId')
          .onRef('patchValidation.migrationRunId', '=', 'patch.migrationRunId')
          .onRef('patchValidation.digest', '=', 'patch.validationDigest'),
      )
      .select([
        'run.status',
        'run.currentStage',
        'run.attempt',
        'run.version',
        'run.baseCommitSha',
        'run.cancellationRequestedAt',
        'approval.verificationPolicyVersion',
        'approval.verificationProfile',
        'approval.verificationProfileDigest',
        'snapshot.id as snapshotArtifactId',
        'snapshot.objectKey as snapshotObjectKey',
        'snapshot.digest as snapshotDigest',
        'snapshot.bytes as snapshotBytes',
        'patch.id as patchAttemptId',
        'patch.attemptNumber as patchAttemptNumber',
        'patch.patchArtifactId',
        'patchArtifact.objectKey as patchObjectKey',
        'patchArtifact.bytes as patchBytes',
        'patch.patchDigest',
        'patch.validationArtifactId as patchValidationArtifactId',
        'patchValidation.objectKey as patchValidationObjectKey',
        'patch.validationDigest as patchValidationDigest',
      ])
      .where('run.id', '=', workflow.migrationRunId)
      .where('run.organisationId', '=', workflow.organisationId)
      .where('run.candidateId', '=', workflow.candidateId)
      .where('run.approvalId', '=', workflow.approvalId)
      .where('run.repositoryId', '=', workflow.repositoryId)
      .orderBy('patch.attemptNumber', 'desc')
      .forUpdate('run')
      .executeTakeFirstOrThrow();
    if (source.attempt !== workflow.expectedAttempt) {
      throw new Error('The verification workflow attempt does not match its run.');
    }
    if (source.status === 'cancelled') return { status: 'cancelled' };
    if (source.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, source.version);
      return { status: 'cancelled' };
    }
    if (source.status !== 'running' || source.currentStage !== 'verifying') {
      throw new Error('The migration run cannot prepare verification.');
    }
    const approval = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approval, new Date())) {
      await markMigrationStale(transaction, workflow, source.version);
      return { status: 'stale' };
    }
    if (
      source.patchArtifactId === null ||
      source.patchDigest === null ||
      source.patchValidationArtifactId === null ||
      source.patchValidationDigest === null
    ) {
      throw new Error('The accepted patch has incomplete verification evidence.');
    }
    const verificationProfile = migrationApprovalVerificationProfileSchema.parse(
      source.verificationProfile,
    );
    const existing = await transaction
      .selectFrom('verificationAttempts')
      .select(['id', 'attemptNumber'])
      .where('organisationId', '=', workflow.organisationId)
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('patchAttemptId', '=', source.patchAttemptId)
      .executeTakeFirst();
    const verificationAttemptId = existing?.id ?? randomUUID();
    const attemptNumber = existing?.attemptNumber ?? source.patchAttemptNumber;
    if (!existing) {
      const now = new Date();
      await transaction
        .insertInto('verificationAttempts')
        .values({
          id: verificationAttemptId,
          organisationId: workflow.organisationId,
          migrationRunId: workflow.migrationRunId,
          approvalId: workflow.approvalId,
          attemptNumber,
          patchAttemptId: source.patchAttemptId,
          baseCommitSha: source.baseCommitSha,
          snapshotArtifactId: source.snapshotArtifactId,
          snapshotDigest: source.snapshotDigest,
          patchArtifactId: source.patchArtifactId,
          patchDigest: source.patchDigest,
          patchValidationArtifactId: source.patchValidationArtifactId,
          patchValidationDigest: source.patchValidationDigest,
          verificationPolicyVersion: source.verificationPolicyVersion,
          verificationProfile,
          verificationProfileDigest: source.verificationProfileDigest,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${workflow.migrationRunId}:verification-prepared:${String(
          attemptNumber,
        )}`,
        eventType: 'verification_prepared',
        status: 'running',
        stage: 'verifying',
        safeErrorCode: null,
        createdAt: now,
      });
    }
    return migrationVerificationPreparedInputSchema.parse({
      status: 'ready',
      schemaVersion: '1.0',
      organisationId: workflow.organisationId,
      repositoryId: workflow.repositoryId,
      migrationRunId: workflow.migrationRunId,
      approvalId: workflow.approvalId,
      verificationAttemptId,
      attemptNumber,
      patchAttemptId: source.patchAttemptId,
      baseCommitSha: source.baseCommitSha,
      snapshot: {
        artifactId: source.snapshotArtifactId,
        objectKey: source.snapshotObjectKey,
        digest: source.snapshotDigest,
        bytes: Number(source.snapshotBytes),
      },
      patch: {
        artifactId: source.patchArtifactId,
        objectKey: source.patchObjectKey,
        digest: source.patchDigest,
        bytes: Number(source.patchBytes),
        validationArtifactId: source.patchValidationArtifactId,
        validationObjectKey: source.patchValidationObjectKey,
        validationDigest: source.patchValidationDigest,
      },
      authority: {
        verificationPolicyVersion: source.verificationPolicyVersion,
        verificationProfile,
        verificationProfileDigest: source.verificationProfileDigest,
      },
    });
  });
}

async function createVerificationWorkItem(
  dependency: WorkflowDependencies,
  prepared: MigrationVerificationPreparedInput,
): Promise<MigrationVerificationDispatch> {
  const prefix = `env/${dependency.config.APP_ENVIRONMENT}/org/${prepared.organisationId}/run/${prepared.migrationRunId}/verification/attempt-${String(prepared.attemptNumber)}`;
  const resultObjectKey = `${prefix}/result.json`;
  const stdoutObjectKey = `${prefix}/stdout.log`;
  const stderrObjectKey = `${prefix}/stderr.log`;
  const expiresIn = 15 * 60;
  const [
    snapshotDownloadUrl,
    patchDownloadUrl,
    resultUploadUrl,
    stdoutUploadUrl,
    stderrUploadUrl,
  ] = await Promise.all([
    getSignedUrl(
      dependency.s3,
      new GetObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: prepared.snapshot.objectKey,
      }),
      { expiresIn },
    ),
    getSignedUrl(
      dependency.s3,
      new GetObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: prepared.patch.objectKey,
      }),
      { expiresIn },
    ),
    ...[resultObjectKey, stdoutObjectKey, stderrObjectKey].map(key =>
      getSignedUrl(
        dependency.s3,
        new PutObjectCommand({
          Bucket: dependency.config.ARTIFACT_BUCKET,
          Key: key,
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
          IfNoneMatch: '*',
        }),
        { expiresIn },
      ),
    ),
  ]);
  const workItem = migrationVerificationWorkItemSchema.parse({
    ...prepared,
    transfers: {
      snapshotDownloadUrl,
      patchDownloadUrl,
      resultUploadUrl,
      stdoutUploadUrl,
      stderrUploadUrl,
      resultObjectKey,
      stdoutObjectKey,
      stderrObjectKey,
      artifactBucket: dependency.config.ARTIFACT_BUCKET,
      artifactKmsKeyArn: dependency.config.ARTIFACT_KMS_KEY_ARN,
      awsRegion: dependency.config.AWS_REGION,
      approvedRegistryUrl: dependency.config.VERIFIER_REGISTRY_URL,
    },
  });
  const workItemBytes = Buffer.from(JSON.stringify(workItem), 'utf8');
  const workItemDigest = sha256(workItemBytes);
  const workItemObjectKey = `${prefix}/work-items/${workItemDigest}.json`;
  await putImmutableObject(
    dependency,
    workItemObjectKey,
    workItemBytes,
    'application/json',
    workItemDigest,
    prepared.migrationRunId,
  );
  const workItemDownloadUrl = await getSignedUrl(
    dependency.s3,
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: workItemObjectKey,
    }),
    { expiresIn },
  );
  return migrationVerificationDispatchSchema.parse({
    ...workItem,
    dispatch: {
      downloadUrl: workItemDownloadUrl,
      digest: workItemDigest,
      bytes: workItemBytes.byteLength,
      artifactBucket: dependency.config.ARTIFACT_BUCKET,
      awsRegion: dependency.config.AWS_REGION,
    },
  });
}

async function ingestMigrationVerification(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
  prepared: MigrationVerificationDispatch,
): Promise<'completed' | 'failed' | 'repair_required' | 'cancelled'> {
  if (
    prepared.organisationId !== workflow.organisationId ||
    prepared.repositoryId !== workflow.repositoryId ||
    prepared.migrationRunId !== workflow.migrationRunId ||
    prepared.attemptNumber < workflow.expectedAttempt ||
    prepared.attemptNumber > workflow.expectedAttempt + 2
  ) {
    throw new Error('The verification result has invalid ownership.');
  }
  const resultBytes = await readBoundedArtifact(
    dependency,
    prepared.transfers.resultObjectKey,
    MAX_RESULT_BYTES,
  );
  const result = migrationVerificationResultSchema.parse(
    JSON.parse(resultBytes.toString('utf8')),
  );
  if (
    result.organisationId !== prepared.organisationId ||
    result.repositoryId !== prepared.repositoryId ||
    result.migrationRunId !== prepared.migrationRunId ||
    result.approvalId !== prepared.approvalId ||
    result.verificationAttemptId !== prepared.verificationAttemptId ||
    result.patchAttemptId !== prepared.patchAttemptId ||
    result.baseCommitSha !== prepared.baseCommitSha ||
    result.snapshotDigest !== prepared.snapshot.digest ||
    result.patchDigest !== prepared.patch.digest ||
    result.patchValidationDigest !== prepared.patch.validationDigest ||
    result.verificationPolicyVersion !== prepared.authority.verificationPolicyVersion ||
    result.verificationProfileDigest !== prepared.authority.verificationProfileDigest
  ) {
    throw new Error('The verification result binding is invalid.');
  }
  for (const [reference, expectedKey] of [
    [result.artifacts.stdout, prepared.transfers.stdoutObjectKey],
    [result.artifacts.stderr, prepared.transfers.stderrObjectKey],
  ] as const) {
    if (reference !== null && reference.objectKey !== expectedKey) {
      throw new Error('The verification log artifact binding is invalid.');
    }
  }
  await Promise.all(
    [result.artifacts.stdout, result.artifacts.stderr]
      .filter(reference => reference !== null)
      .map(async reference => {
        const bytes = await readBoundedArtifact(
          dependency,
          reference.objectKey,
          1024 * 1024,
        );
        if (
          bytes.byteLength !== reference.bytes ||
          sha256(bytes) !== reference.digest
        ) {
          throw new Error('The verification log artifact digest is invalid.');
        }
      }),
  );
  return dependency.database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    const existing = await transaction
      .selectFrom('verificationAttemptResults')
      .select(['outcome'])
      .where('verificationAttemptId', '=', prepared.verificationAttemptId)
      .where('organisationId', '=', workflow.organisationId)
      .where('migrationRunId', '=', workflow.migrationRunId)
      .executeTakeFirst();
    if (existing !== undefined) {
      if (existing.outcome === 'passed') return 'completed';
      return existing.outcome === 'failed' ? 'repair_required' : 'failed';
    }
    if (run.status !== 'running' || run.currentStage !== 'verifying') {
      throw new Error('The migration run cannot ingest verification.');
    }
    const now = new Date();
    const resultArtifactId = randomUUID();
    const resultDigest = sha256(resultBytes);
    await insertMigrationArtifact(transaction, {
      id: resultArtifactId,
      workflow,
      artifactType: 'verification_result',
      objectKey: prepared.transfers.resultObjectKey,
      digest: resultDigest,
      bytes: resultBytes.byteLength,
      mediaType: 'application/json',
      createdAt: now,
    });
    const stdoutArtifactId = result.artifacts.stdout === null ? null : randomUUID();
    const stderrArtifactId = result.artifacts.stderr === null ? null : randomUUID();
    if (result.artifacts.stdout !== null && stdoutArtifactId !== null) {
      await insertMigrationArtifact(transaction, {
        id: stdoutArtifactId,
        workflow,
        artifactType: 'verification_stdout',
        objectKey: result.artifacts.stdout.objectKey,
        digest: result.artifacts.stdout.digest,
        bytes: result.artifacts.stdout.bytes,
        mediaType: 'text/plain',
        createdAt: now,
      });
    }
    if (result.artifacts.stderr !== null && stderrArtifactId !== null) {
      await insertMigrationArtifact(transaction, {
        id: stderrArtifactId,
        workflow,
        artifactType: 'verification_stderr',
        objectKey: result.artifacts.stderr.objectKey,
        digest: result.artifacts.stderr.digest,
        bytes: result.artifacts.stderr.bytes,
        mediaType: 'text/plain',
        createdAt: now,
      });
    }
    await transaction
      .insertInto('verificationAttemptResults')
      .values({
        id: randomUUID(),
        organisationId: workflow.organisationId,
        migrationRunId: workflow.migrationRunId,
        verificationAttemptId: prepared.verificationAttemptId,
        outcome: result.outcome,
        safeErrorCode: result.safeErrorCode,
        commands: sql`${JSON.stringify(result.commands)}::jsonb`,
        resultArtifactId,
        resultDigest,
        stdoutArtifactId,
        stdoutDigest: result.artifacts.stdout?.digest ?? null,
        stderrArtifactId,
        stderrDigest: result.artifacts.stderr?.digest ?? null,
        startedAt: new Date(result.startedAt),
        completedAt: new Date(result.completedAt),
        createdAt: now,
      })
      .executeTakeFirstOrThrow();
    if (result.outcome === 'passed') {
      await transaction
        .updateTable('migrationRuns')
        .set({
          currentStage: 'publishing',
          version: run.version + 1,
          updatedAt: now,
        })
        .where('id', '=', workflow.migrationRunId)
        .where('organisationId', '=', workflow.organisationId)
        .where('version', '=', run.version)
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${workflow.migrationRunId}:verification-completed:${String(prepared.attemptNumber)}`,
        eventType: 'verification_completed',
        status: 'running',
        stage: 'verifying',
        safeErrorCode: null,
        createdAt: now,
      });
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${workflow.migrationRunId}:stage:publishing:${String(prepared.attemptNumber)}`,
        eventType: 'stage_entered',
        status: 'running',
        stage: 'publishing',
        safeErrorCode: null,
        createdAt: now,
      });
      return 'completed';
    }
    if (result.outcome === 'failed') {
      await transaction
        .updateTable('migrationRuns')
        .set({
          currentStage: 'repairing',
          version: run.version + 1,
          updatedAt: now,
        })
        .where('id', '=', workflow.migrationRunId)
        .where('organisationId', '=', workflow.organisationId)
        .where('version', '=', run.version)
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${workflow.migrationRunId}:verification-completed:${String(prepared.attemptNumber)}`,
        eventType: 'verification_completed',
        status: 'running',
        stage: 'verifying',
        safeErrorCode: result.safeErrorCode,
        createdAt: now,
      });
      await appendMigrationRunEvent(transaction, {
        workflow,
        eventKey: `run:${workflow.migrationRunId}:repair-requested:${String(prepared.attemptNumber)}`,
        eventType: 'repair_requested',
        status: 'running',
        stage: 'repairing',
        safeErrorCode: result.safeErrorCode,
        createdAt: now,
      });
      return 'repair_required';
    }
    await transaction
      .updateTable('migrationRuns')
      .set({
        status: 'failed',
        currentStage: 'failed',
        terminalResult: 'failed',
        safeErrorCode: 'MIGRATION_VERIFICATION_FAILED',
        completedAt: now,
        version: run.version + 1,
        updatedAt: now,
      })
      .where('id', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .where('version', '=', run.version)
      .executeTakeFirstOrThrow();
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:failed:verification:${String(prepared.attemptNumber)}`,
      eventType: 'run_failed',
      status: 'failed',
      stage: 'failed',
      safeErrorCode: 'MIGRATION_VERIFICATION_FAILED',
      createdAt: now,
    });
    return 'failed';
  });
}

async function readMigrationAgentArtifacts(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
  prepared: MigrationAgentPreparedInput,
): Promise<{
  readonly input: MigrationAgentInputArtifact;
  readonly inputBytes: Buffer;
  readonly result: MigrationAgentResult;
}> {
  if (
    prepared.organisationId !== workflow.organisationId ||
    prepared.repositoryId !== workflow.repositoryId ||
    prepared.migrationRunId !== workflow.migrationRunId ||
    prepared.attemptNumber !== workflow.expectedAttempt
  ) {
    throw new Error('The prepared migration-agent input has invalid ownership.');
  }
  const [inputBytes, resultBytes] = await Promise.all([
    readBoundedArtifact(dependency, prepared.inputObjectKey, 4 * 1024 * 1024),
    readBoundedArtifact(
      dependency,
      prepared.resultObjectKey,
      MAX_MIGRATION_AGENT_RESULT_BYTES,
    ),
  ]);
  if (sha256(inputBytes) !== prepared.inputDigest) {
    throw new Error('The prepared migration-agent input digest is invalid.');
  }
  const input = migrationAgentInputArtifactSchema.parse(
    JSON.parse(inputBytes.toString('utf8')),
  );
  const result = migrationAgentResultSchema.parse(
    JSON.parse(resultBytes.toString('utf8')),
  );
  if (
    input.binding.migrationRunId !== workflow.migrationRunId ||
    result.organisationId !== workflow.organisationId ||
    result.repositoryId !== workflow.repositoryId ||
    result.migrationRunId !== workflow.migrationRunId ||
    input.attemptNumber !== prepared.attemptNumber ||
    result.attemptNumber !== prepared.attemptNumber ||
    result.inputDigest !== prepared.inputDigest
  ) {
    throw new Error('The migration-agent result has invalid ownership.');
  }
  return { input, inputBytes, result };
}

async function lockedMigrationRun(
  transaction: Transaction<Database>,
  workflow: MigrationWorkflowInput,
): Promise<
  Pick<
    Selectable<MigrationRunTable>,
    'status' | 'currentStage' | 'attempt' | 'version' | 'cancellationRequestedAt'
  >
> {
  const run = await transaction
    .selectFrom('migrationRuns')
    .select(['status', 'currentStage', 'attempt', 'version', 'cancellationRequestedAt'])
    .where('id', '=', workflow.migrationRunId)
    .where('organisationId', '=', workflow.organisationId)
    .where('candidateId', '=', workflow.candidateId)
    .where('approvalId', '=', workflow.approvalId)
    .where('repositoryId', '=', workflow.repositoryId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (run.attempt !== workflow.expectedAttempt) {
    throw new Error('The migration-agent attempt does not match its run.');
  }
  return run;
}

async function markMigrationAgentFailed(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
  stage: Extract<MigrationExecutionStage, 'planning' | 'patching' | 'repairing'>,
  safeErrorCode: 'MIGRATION_AGENT_FAILED',
): Promise<'failed' | 'cancelled'> {
  return markMigrationFailed(database, workflow, safeErrorCode, stage);
}

interface NewMigrationArtifact {
  readonly id: string;
  readonly workflow: MigrationWorkflowInput;
  readonly artifactType:
    | 'context_manifest'
    | 'agent_checkpoint'
    | 'migration_plan'
    | 'patch_proposal'
    | 'patch_manifest'
    | 'patch_validation'
    | 'verification_result'
    | 'verification_stdout'
    | 'verification_stderr';
  readonly objectKey: string;
  readonly digest: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly createdAt: Date;
}

async function insertMigrationArtifact(
  transaction: Transaction<Database>,
  artifact: NewMigrationArtifact,
): Promise<void> {
  await transaction
    .insertInto('migrationArtifacts')
    .values({
      id: artifact.id,
      organisationId: artifact.workflow.organisationId,
      migrationRunId: artifact.workflow.migrationRunId,
      artifactType: artifact.artifactType,
      objectKey: artifact.objectKey,
      digest: artifact.digest,
      bytes: artifact.bytes,
      mediaType: artifact.mediaType,
      retentionClass: 'audit',
      createdAt: artifact.createdAt,
      expiresAt: null,
    })
    .executeTakeFirstOrThrow();
}

async function putImmutableObject(
  dependency: WorkflowDependencies,
  key: string,
  body: Buffer,
  contentType: string,
  digest: string,
  migrationRunId: string,
): Promise<void> {
  try {
    await dependency.s3.send(
      new PutObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
        Metadata: {
          digest,
          'migration-run-id': migrationRunId,
        },
        IfNoneMatch: '*',
      }),
    );
    return;
  } catch (error) {
    if (!(
      error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412
    )) {
      throw error;
    }
  }
  const existing = await dependency.s3.send(
    new HeadObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: key,
    }),
  );
  assertImmutableObject(existing, body, contentType, digest, migrationRunId);
}

function assertImmutableObject(
  existing: {
    readonly ContentLength?: number;
    readonly ContentType?: string;
    readonly Metadata?: Record<string, string>;
  },
  body: Buffer,
  contentType: string,
  digest: string,
  migrationRunId: string,
): void {
  const metadata = existing.Metadata;
  if (
    existing.ContentLength !== body.byteLength ||
    existing.ContentType !== contentType ||
    metadata?.digest !== digest ||
    metadata['migration-run-id'] !== migrationRunId
  ) {
    throw new Error('An immutable migration artifact cannot be replaced.');
  }
}

async function readBoundedArtifact(
  dependency: WorkflowDependencies,
  key: string,
  maximumBytes: number,
): Promise<Buffer> {
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: key,
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > maximumBytes
  ) {
    throw new Error('The migration artifact size is invalid.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new Error('The migration artifact could not be read completely.');
  }
  return Buffer.from(bytes);
}

function migrationAgentPrefix(
  environment: string,
  organisationId: string,
  migrationRunId: string,
): string {
  return `env/${environment}/org/${organisationId}/run/${migrationRunId}/agent`;
}

function migrationAgentAttemptPrefix(
  environment: string,
  organisationId: string,
  migrationRunId: string,
  attemptNumber: number,
): string {
  const prefix = migrationAgentPrefix(environment, organisationId, migrationRunId);
  return attemptNumber === 1
    ? prefix
    : `${prefix}/repair-attempt-${String(attemptNumber)}`;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function prepareMigrationPublication(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<
  | { readonly status: 'completed'; readonly publicationAttemptId: string }
  | { readonly status: 'cancelled' | 'failed' | 'stale' }
> {
  const boundary = await revalidatePublicationBoundary(dependency.database, workflow);
  if (boundary !== 'ready') return { status: boundary };
  const access = await verifyGithubPublicationAccess(dependency, workflow);
  if (access.status === 'denied') {
    const status = await markMigrationFailed(
      dependency.database,
      workflow,
      'GITHUB_PUBLICATION_ACCESS_DENIED',
      'publishing',
    );
    return { status };
  }
  return persistPublicationAttempt(dependency.database, workflow, access);
}

async function revalidatePublicationBoundary(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
): Promise<'ready' | 'cancelled' | 'stale'> {
  return database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return 'cancelled';
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return 'cancelled';
    }
    if (run.status !== 'running' || run.currentStage !== 'publishing') {
      throw new Error('The migration run cannot prepare publication.');
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
    return 'ready';
  });
}

async function verifyGithubPublicationAccess(
  dependency: WorkflowDependencies,
  workflow: MigrationWorkflowInput,
): Promise<GithubPublicationAccessResult> {
  const response = await dependency.lambda.send(
    new InvokeCommand({
      FunctionName: dependency.config.GITHUB_TOKEN_BROKER_FUNCTION_NAME,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(
        JSON.stringify({
          operation: 'verify_publication_access',
          migrationRunId: workflow.migrationRunId,
          repositoryId: workflow.repositoryId,
        }),
      ),
    }),
  );
  if (
    response.FunctionError !== undefined ||
    response.Payload === undefined ||
    response.Payload.byteLength > 16 * 1024
  ) {
    throw new Error('The GitHub publication access check failed.');
  }
  try {
    return githubPublicationAccessResultSchema.parse(
      JSON.parse(Buffer.from(response.Payload).toString('utf8')),
    );
  } catch {
    throw new Error('The GitHub publication access response is invalid.');
  }
}

async function persistPublicationAttempt(
  database: AppDatabase,
  workflow: MigrationWorkflowInput,
  access: GithubPublicationAccess,
): Promise<
  | { readonly status: 'completed'; readonly publicationAttemptId: string }
  | { readonly status: 'cancelled' | 'stale' }
> {
  return database.transaction().execute(async transaction => {
    const run = await lockedMigrationRun(transaction, workflow);
    if (run.status === 'cancelled') return { status: 'cancelled' };
    if (run.cancellationRequestedAt !== null) {
      await markMigrationCancelled(transaction, workflow, run.version);
      return { status: 'cancelled' };
    }
    if (run.status !== 'running' || run.currentStage !== 'publishing') {
      throw new Error('The migration run cannot persist publication evidence.');
    }
    const approvalState = await loadMigrationApprovalState(transaction, workflow);
    if (isMigrationApprovalStale(approvalState, new Date())) {
      await markMigrationStale(
        transaction,
        workflow,
        run.version,
        'MIGRATION_APPROVAL_STALE',
      );
      return { status: 'stale' };
    }
    const source = await transaction
      .selectFrom('migrationRuns as migrationRun')
      .innerJoin('migrationApprovals as approval', join =>
        join
          .onRef('approval.id', '=', 'migrationRun.approvalId')
          .onRef('approval.organisationId', '=', 'migrationRun.organisationId')
          .onRef('approval.repositoryId', '=', 'migrationRun.repositoryId'),
      )
      .innerJoin('verificationAttempts as verification', join =>
        join
          .onRef('verification.migrationRunId', '=', 'migrationRun.id')
          .onRef('verification.organisationId', '=', 'migrationRun.organisationId')
          .onRef('verification.approvalId', '=', 'migrationRun.approvalId')
          .onRef('verification.baseCommitSha', '=', 'migrationRun.baseCommitSha'),
      )
      .innerJoin('verificationAttemptResults as result', join =>
        join
          .onRef('result.verificationAttemptId', '=', 'verification.id')
          .onRef('result.migrationRunId', '=', 'migrationRun.id')
          .onRef('result.organisationId', '=', 'migrationRun.organisationId')
          .on('result.outcome', '=', 'passed'),
      )
      .innerJoin('patchAttempts as patch', join =>
        join
          .onRef('patch.id', '=', 'verification.patchAttemptId')
          .onRef('patch.migrationRunId', '=', 'migrationRun.id')
          .onRef('patch.organisationId', '=', 'migrationRun.organisationId')
          .on('patch.status', '=', 'accepted'),
      )
      .select([
        'approval.installationId',
        'approval.githubRepositoryId',
        'approval.baseBranch',
        'approval.baseCommitSha',
        'approval.publicationPolicyVersion',
        'verification.id as verificationAttemptId',
        'result.id as verificationResultId',
        'result.outcome as verificationOutcome',
        'patch.id as patchAttemptId',
        'verification.patchArtifactId',
        'verification.patchDigest',
        'verification.patchValidationArtifactId',
        'verification.patchValidationDigest',
      ])
      .where('migrationRun.id', '=', workflow.migrationRunId)
      .where('migrationRun.organisationId', '=', workflow.organisationId)
      .executeTakeFirstOrThrow();
    if (
      access.githubRepositoryId !== source.githubRepositoryId ||
      access.baseBranch !== source.baseBranch ||
      access.headCommitSha !== source.baseCommitSha
    ) {
      await markMigrationStale(
        transaction,
        workflow,
        run.version,
        'MIGRATION_PUBLICATION_BASE_STALE',
      );
      return { status: 'stale' };
    }
    const binding = publicationAttemptBindingSchema.parse({
      schemaVersion: '1.0',
      organisationId: workflow.organisationId,
      migrationRunId: workflow.migrationRunId,
      approvalId: workflow.approvalId,
      repositoryId: workflow.repositoryId,
      installationId: source.installationId,
      githubRepositoryId: source.githubRepositoryId,
      verificationAttemptId: source.verificationAttemptId,
      verificationResultId: source.verificationResultId,
      verificationOutcome: source.verificationOutcome,
      patchAttemptId: source.patchAttemptId,
      patchArtifactId: source.patchArtifactId,
      patchDigest: source.patchDigest,
      patchValidationArtifactId: source.patchValidationArtifactId,
      patchValidationDigest: source.patchValidationDigest,
      baseBranch: source.baseBranch,
      baseCommitSha: source.baseCommitSha,
      headBranch: `migration-api/run-${workflow.migrationRunId}`,
      publicationPolicyVersion: source.publicationPolicyVersion,
    });
    const existing = await transaction
      .selectFrom('publicationAttempts')
      .select(['id'])
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .executeTakeFirst();
    if (existing !== undefined) {
      return { status: 'completed', publicationAttemptId: existing.id };
    }
    const proposedPublicationAttemptId = randomUUID();
    const now = new Date();
    const inserted = await transaction
      .insertInto('publicationAttempts')
      .values({
        id: proposedPublicationAttemptId,
        organisationId: binding.organisationId,
        migrationRunId: binding.migrationRunId,
        approvalId: binding.approvalId,
        repositoryId: binding.repositoryId,
        installationId: binding.installationId,
        githubRepositoryId: binding.githubRepositoryId,
        verificationAttemptId: binding.verificationAttemptId,
        verificationResultId: binding.verificationResultId,
        verificationOutcome: binding.verificationOutcome,
        patchAttemptId: binding.patchAttemptId,
        patchArtifactId: binding.patchArtifactId,
        patchDigest: binding.patchDigest,
        patchValidationArtifactId: binding.patchValidationArtifactId,
        patchValidationDigest: binding.patchValidationDigest,
        baseBranch: binding.baseBranch,
        baseCommitSha: binding.baseCommitSha,
        headBranch: binding.headBranch,
        publicationPolicyVersion: binding.publicationPolicyVersion,
        status: 'queued',
        attemptCount: 0,
        safeErrorCode: null,
        idempotencyKey: `publication:${workflow.migrationRunId}`,
        correlationId: workflow.correlationId,
        createdAt: now,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
      })
      .onConflict(conflict => conflict.column('migrationRunId').doNothing())
      .returning('id')
      .executeTakeFirst();
    const publicationAttemptId =
      inserted?.id ??
      (
        await transaction
          .selectFrom('publicationAttempts')
          .select('id')
          .where('migrationRunId', '=', workflow.migrationRunId)
          .where('organisationId', '=', workflow.organisationId)
          .executeTakeFirstOrThrow()
      ).id;
    if (inserted === undefined) {
      return { status: 'completed', publicationAttemptId };
    }
    await appendMigrationRunEvent(transaction, {
      workflow,
      eventKey: `run:${workflow.migrationRunId}:publication-prepared`,
      eventType: 'publication_prepared',
      status: 'running',
      stage: 'publishing',
      safeErrorCode: null,
      createdAt: now,
    });
    return { status: 'completed', publicationAttemptId };
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
    | 'MIGRATION_AGENT_FAILED'
    | 'MIGRATION_PATCH_REJECTED'
    | 'GITHUB_PUBLICATION_ACCESS_DENIED'
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
  if (
    expectedStage === 'publishing' &&
    safeErrorCode === 'MIGRATION_PUBLICATION_NOT_IMPLEMENTED'
  ) {
    await transaction
      .updateTable('publicationAttempts')
      .set({
        status: 'failed',
        attemptCount: 1,
        safeErrorCode,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .where('migrationRunId', '=', workflow.migrationRunId)
      .where('organisationId', '=', workflow.organisationId)
      .where('status', '=', 'queued')
      .execute();
  }
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
    | 'plan_created'
    | 'patch_proposed'
    | 'patch_validated'
    | 'verification_prepared'
    | 'verification_completed'
    | 'repair_requested'
    | 'publication_prepared'
    | 'publication_started'
    | 'publication_reconciled'
    | 'notification_queued'
    | 'run_cancelled'
    | 'run_failed'
    | 'run_stale';
  readonly status: 'running' | 'failed' | 'cancelled' | 'stale';
  readonly stage:
    | 'revalidating'
    | 'acquiring'
    | 'planning'
    | 'patching'
    | 'verifying'
    | 'repairing'
    | 'publishing'
    | 'failed'
    | 'cancelled'
    | 'stale';
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
