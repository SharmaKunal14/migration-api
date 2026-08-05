import { randomUUID } from 'node:crypto';

import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { ScheduledEvent } from 'aws-lambda';

import {
  migrationWorkflowInputSchema,
  repositoryScanWorkflowInputSchema,
  vendorIngestionWorkflowInputSchema,
  workflowInputSchema,
  type MigrationWorkflowInput,
  type RepositoryScanWorkflowInput,
  type VendorIngestionWorkflowInput,
  type WorkflowInput,
} from '@migration/contracts';
import {
  dispatcherConfigSchema,
  parseConfig,
  type DispatcherConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import { writeLog } from '@migration/observability';

const PER_KIND_BATCH_SIZE = 2;
const LEASE_MILLISECONDS = 60_000;
const MAX_ATTEMPTS = 10;

interface DispatcherDependencies {
  readonly config: DispatcherConfig;
  readonly database: AppDatabase;
  readonly stepFunctions: WorkflowStarter;
}

export interface WorkflowStarter {
  send(command: StartExecutionCommand): Promise<unknown>;
}

export type ClaimedEvent =
  | {
      readonly kind: 'agent';
      readonly id: string;
      readonly payload: WorkflowInput;
      readonly attempts: number;
    }
  | {
      readonly kind: 'repository_scan';
      readonly id: string;
      readonly payload: RepositoryScanWorkflowInput;
      readonly attempts: number;
    }
  | {
      readonly kind: 'migration';
      readonly id: string;
      readonly payload: MigrationWorkflowInput;
      readonly attempts: number;
    }
  | {
      readonly kind: 'release_intelligence';
      readonly id: string;
      readonly payload: VendorIngestionWorkflowInput;
      readonly attempts: number;
    }
  | {
      readonly kind: 'publication_notification';
      readonly id: string;
      readonly organisationId: string;
      readonly migrationRunId: string;
      readonly publicationId: string;
      readonly attempts: number;
    };

let cachedDependencies: DispatcherDependencies | undefined;

async function dependencies(): Promise<DispatcherDependencies> {
  if (cachedDependencies) {
    return cachedDependencies;
  }
  const config = parseConfig(dispatcherConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    stepFunctions: new SFNClient({ region: config.AWS_REGION }),
  };
  return cachedDependencies;
}

export async function handler(_event: ScheduledEvent): Promise<void> {
  await dispatchOutbox(await dependencies(), randomUUID());
}

export async function dispatchOutbox(
  dependency: DispatcherDependencies,
  leaseOwner: string,
): Promise<void> {
  const claimed = await claimEvents(dependency.database, leaseOwner);
  for (const event of claimed) {
    try {
      if (event.kind === 'publication_notification') {
        await markDelivered(dependency.database, event, leaseOwner);
        writeLog('info', {
          event: 'publication_notification_delivered',
          organisationId: event.organisationId,
          migrationRunId: event.migrationRunId,
          outcome: 'in_app',
        });
        continue;
      }
      const executionArn = await startWorkflowExecution(
        dependency.stepFunctions,
        event,
        dependency.config,
      );
      await markDelivered(dependency.database, event, leaseOwner, executionArn);
      writeLog('info', {
        event: 'outbox_event_delivered',
        correlationId: event.payload.correlationId,
        ...(event.kind === 'release_intelligence'
          ? { vendorReleaseId: event.payload.vendorReleaseId }
          : { organisationId: event.payload.organisationId }),
        ...(event.kind === 'agent'
          ? { agentRunId: event.payload.agentRunId }
          : event.kind === 'repository_scan'
            ? { repositoryScanId: event.payload.repositoryScanId }
            : event.kind === 'migration'
              ? { migrationRunId: event.payload.migrationRunId }
              : {}),
      });
    } catch {
      const terminal = event.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = retryBackoffSeconds(event.attempts);
      await markRetry(dependency.database, event, leaseOwner, backoffSeconds, terminal);
      writeLog(terminal ? 'error' : 'warn', {
        event: terminal ? 'outbox_event_failed' : 'outbox_event_retry_scheduled',
        ...(event.kind === 'publication_notification'
          ? {
              organisationId: event.organisationId,
              migrationRunId: event.migrationRunId,
            }
          : {
              correlationId: event.payload.correlationId,
              ...(event.kind === 'release_intelligence'
                ? { vendorReleaseId: event.payload.vendorReleaseId }
                : { organisationId: event.payload.organisationId }),
              ...(event.kind === 'agent'
                ? { agentRunId: event.payload.agentRunId }
                : event.kind === 'repository_scan'
                  ? { repositoryScanId: event.payload.repositoryScanId }
                  : event.kind === 'migration'
                    ? { migrationRunId: event.payload.migrationRunId }
                    : {}),
            }),
        safeErrorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_RETRY_PENDING',
      });
    }
  }
}

export async function startWorkflowExecution(
  stepFunctions: WorkflowStarter,
  event: ClaimedEvent,
  config: DispatcherConfig,
): Promise<string> {
  if (event.kind === 'publication_notification') {
    throw new Error('In-app notifications do not start workflow executions.');
  }
  const executionName = workflowExecutionName(event);
  const stateMachineArn = workflowStateMachineArn(event, config);
  const executionArn = deterministicExecutionArn(stateMachineArn, executionName);
  try {
    await stepFunctions.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: executionName,
        input: JSON.stringify(event.payload),
      }),
    );
  } catch (error) {
    if (!(error instanceof ExecutionAlreadyExists)) throw error;
  }
  return executionArn;
}

export function retryBackoffSeconds(attempt: number, random = Math.random()): number {
  const ceiling = Math.min(300, 2 ** attempt);
  return Math.max(1, Math.ceil(ceiling * (0.5 + Math.min(1, Math.max(0, random)) / 2)));
}

export function workflowExecutionName(event: ClaimedEvent): string {
  if (event.kind === 'publication_notification') {
    throw new Error('In-app notifications do not have workflow execution names.');
  }
  if (event.kind === 'agent') return `agent-${event.payload.agentRunId}`;
  if (event.kind === 'release_intelligence') {
    return `release-intelligence-${event.payload.correlationId}`;
  }
  if (event.kind === 'repository_scan') {
    return `repository-scan-${event.payload.repositoryScanId}`;
  }
  return `migration-${event.payload.migrationRunId}`;
}

function workflowStateMachineArn(
  event: ClaimedEvent,
  config: DispatcherConfig,
): string {
  if (event.kind === 'publication_notification') {
    throw new Error('In-app notifications do not use a state machine.');
  }
  if (event.kind === 'agent') return config.STATE_MACHINE_ARN;
  if (event.kind === 'release_intelligence') {
    return config.RELEASE_INTELLIGENCE_STATE_MACHINE_ARN;
  }
  if (event.kind === 'repository_scan') {
    return config.REPOSITORY_SCAN_STATE_MACHINE_ARN;
  }
  return config.MIGRATION_STATE_MACHINE_ARN;
}

export function deterministicExecutionArn(
  stateMachineArn: string,
  executionName: string,
): string {
  const match =
    /^(arn:[^:]+:states:[^:]+:[0-9]{12}):stateMachine:([A-Za-z0-9+=,.@_-]+)$/u.exec(
      stateMachineArn,
    );
  if (!match?.[1] || !match[2] || !/^[A-Za-z0-9+=,.@_-]{1,80}$/u.test(executionName)) {
    throw new Error('The workflow execution identity is invalid.');
  }
  return `${match[1]}:execution:${match[2]}:${executionName}`;
}

async function claimEvents(
  database: AppDatabase,
  leaseOwner: string,
): Promise<ClaimedEvent[]> {
  const agentEvents = await database.transaction().execute(async transaction => {
    const candidates = await transaction
      .selectFrom('workflowOutbox')
      .select(['id', 'payload', 'attempts'])
      .where('deliveredAt', 'is', null)
      .where('availableAt', '<=', new Date())
      .where(builder =>
        builder.or([
          builder('leaseExpiresAt', 'is', null),
          builder('leaseExpiresAt', '<', new Date()),
        ]),
      )
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('createdAt', 'asc')
      .limit(PER_KIND_BATCH_SIZE)
      .forUpdate()
      .skipLocked()
      .execute();
    const claimed: ClaimedEvent[] = [];
    for (const candidate of candidates) {
      const payload = workflowInputSchema.parse(candidate.payload);
      await transaction
        .updateTable('workflowOutbox')
        .set({
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MILLISECONDS),
          attempts: candidate.attempts + 1,
        })
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      claimed.push({
        kind: 'agent',
        id: candidate.id,
        payload,
        attempts: candidate.attempts + 1,
      });
    }
    return claimed;
  });
  const scanEvents = await database.transaction().execute(async transaction => {
    const candidates = await transaction
      .selectFrom('repositoryScanOutbox')
      .select(['id', 'payload', 'attempts'])
      .where('deliveredAt', 'is', null)
      .where('availableAt', '<=', new Date())
      .where(builder =>
        builder.or([
          builder('leaseExpiresAt', 'is', null),
          builder('leaseExpiresAt', '<', new Date()),
        ]),
      )
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('createdAt', 'asc')
      .limit(PER_KIND_BATCH_SIZE)
      .forUpdate()
      .skipLocked()
      .execute();
    const claimed: ClaimedEvent[] = [];
    for (const candidate of candidates) {
      const payload = repositoryScanWorkflowInputSchema.parse(candidate.payload);
      await transaction
        .updateTable('repositoryScanOutbox')
        .set({
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MILLISECONDS),
          attempts: candidate.attempts + 1,
        })
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      claimed.push({
        kind: 'repository_scan',
        id: candidate.id,
        payload,
        attempts: candidate.attempts + 1,
      });
    }
    return claimed;
  });
  const migrationEvents = await database.transaction().execute(async transaction => {
    const candidates = await transaction
      .selectFrom('migrationRunOutbox')
      .select(['id', 'payload', 'attempts'])
      .where('deliveredAt', 'is', null)
      .where('availableAt', '<=', new Date())
      .where(builder =>
        builder.or([
          builder('leaseExpiresAt', 'is', null),
          builder('leaseExpiresAt', '<', new Date()),
        ]),
      )
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('createdAt', 'asc')
      .limit(PER_KIND_BATCH_SIZE)
      .forUpdate()
      .skipLocked()
      .execute();
    const claimed: ClaimedEvent[] = [];
    for (const candidate of candidates) {
      const payload = migrationWorkflowInputSchema.parse(candidate.payload);
      await transaction
        .updateTable('migrationRunOutbox')
        .set({
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MILLISECONDS),
          attempts: candidate.attempts + 1,
        })
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      claimed.push({
        kind: 'migration',
        id: candidate.id,
        payload,
        attempts: candidate.attempts + 1,
      });
    }
    return claimed;
  });
  const releaseIntelligenceEvents = await database
    .transaction()
    .execute(async transaction => {
      const candidates = await transaction
        .selectFrom('releaseIntelligenceOutbox')
        .select(['id', 'payload', 'attempts'])
        .where('deliveredAt', 'is', null)
        .where('availableAt', '<=', new Date())
        .where(builder =>
          builder.or([
            builder('leaseExpiresAt', 'is', null),
            builder('leaseExpiresAt', '<', new Date()),
          ]),
        )
        .where('attempts', '<', MAX_ATTEMPTS)
        .orderBy('createdAt', 'asc')
        .limit(PER_KIND_BATCH_SIZE)
        .forUpdate()
        .skipLocked()
        .execute();
      const claimed: ClaimedEvent[] = [];
      for (const candidate of candidates) {
        const payload = vendorIngestionWorkflowInputSchema.parse(candidate.payload);
        await transaction
          .updateTable('releaseIntelligenceOutbox')
          .set({
            leaseOwner,
            leaseExpiresAt: new Date(Date.now() + LEASE_MILLISECONDS),
            attempts: candidate.attempts + 1,
            safeErrorCode: null,
          })
          .where('id', '=', candidate.id)
          .executeTakeFirstOrThrow();
        claimed.push({
          kind: 'release_intelligence',
          id: candidate.id,
          payload,
          attempts: candidate.attempts + 1,
        });
      }
      return claimed;
    });
  const notificationEvents = await database.transaction().execute(async transaction => {
    const candidates = await transaction
      .selectFrom('publicationNotificationOutbox')
      .select(['id', 'organisationId', 'migrationRunId', 'publicationId', 'attempts'])
      .where('channel', '=', 'in_app')
      .where('deliveredAt', 'is', null)
      .where('availableAt', '<=', new Date())
      .where(builder =>
        builder.or([
          builder('leaseExpiresAt', 'is', null),
          builder('leaseExpiresAt', '<', new Date()),
        ]),
      )
      .where('attempts', '<', MAX_ATTEMPTS)
      .orderBy('createdAt', 'asc')
      .limit(PER_KIND_BATCH_SIZE)
      .forUpdate()
      .skipLocked()
      .execute();
    const claimed: ClaimedEvent[] = [];
    for (const candidate of candidates) {
      await transaction
        .updateTable('publicationNotificationOutbox')
        .set({
          leaseOwner,
          leaseExpiresAt: new Date(Date.now() + LEASE_MILLISECONDS),
          attempts: candidate.attempts + 1,
          safeErrorCode: null,
        })
        .where('id', '=', candidate.id)
        .executeTakeFirstOrThrow();
      claimed.push({
        kind: 'publication_notification',
        id: candidate.id,
        organisationId: candidate.organisationId,
        migrationRunId: candidate.migrationRunId,
        publicationId: candidate.publicationId,
        attempts: candidate.attempts + 1,
      });
    }
    return claimed;
  });
  return [
    ...releaseIntelligenceEvents,
    ...migrationEvents,
    ...agentEvents,
    ...scanEvents,
    ...notificationEvents,
  ];
}

async function markDelivered(
  database: AppDatabase,
  event: ClaimedEvent,
  leaseOwner: string,
  executionArn?: string,
): Promise<void> {
  const values = {
    deliveredAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: null,
  };
  if (event.kind === 'publication_notification') {
    await database
      .updateTable('publicationNotificationOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('organisationId', '=', event.organisationId)
      .where('migrationRunId', '=', event.migrationRunId)
      .where('publicationId', '=', event.publicationId)
      .where('leaseOwner', '=', leaseOwner)
      .where('deliveredAt', 'is', null)
      .executeTakeFirstOrThrow();
    return;
  }
  if (event.kind === 'agent') {
    await database
      .updateTable('workflowOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .executeTakeFirstOrThrow();
    return;
  }
  if (event.kind === 'repository_scan') {
    await database
      .updateTable('repositoryScanOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .executeTakeFirstOrThrow();
    return;
  }
  if (event.kind === 'release_intelligence') {
    if (!executionArn) {
      throw new Error('Release intelligence delivery requires an execution ARN.');
    }
    await database
      .updateTable('releaseIntelligenceOutbox')
      .set({ ...values, workflowExecutionArn: executionArn })
      .where('id', '=', event.id)
      .where('aggregateId', '=', event.payload.vendorReleaseId)
      .where('leaseOwner', '=', leaseOwner)
      .where('deliveredAt', 'is', null)
      .executeTakeFirstOrThrow();
    return;
  }
  await database.transaction().execute(async transaction => {
    if (!executionArn) {
      throw new Error('Migration delivery requires a workflow execution ARN.');
    }
    const outbox = await transaction
      .updateTable('migrationRunOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .where('deliveredAt', 'is', null)
      .executeTakeFirst();
    if (outbox.numUpdatedRows !== 1n) {
      throw new Error('The migration outbox lease was lost before delivery.');
    }
    const run = await transaction
      .selectFrom('migrationRuns')
      .select('workflowExecutionArn')
      .where('id', '=', event.payload.migrationRunId)
      .where('organisationId', '=', event.payload.organisationId)
      .where('candidateId', '=', event.payload.candidateId)
      .where('approvalId', '=', event.payload.approvalId)
      .where('repositoryId', '=', event.payload.repositoryId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (run.workflowExecutionArn && run.workflowExecutionArn !== executionArn) {
      throw new Error('The migration run is bound to another workflow execution.');
    }
    if (!run.workflowExecutionArn) {
      await transaction
        .updateTable('migrationRuns')
        .set({
          workflowExecutionArn: executionArn,
          updatedAt: new Date(),
        })
        .where('id', '=', event.payload.migrationRunId)
        .executeTakeFirstOrThrow();
    }
  });
}

async function markRetry(
  database: AppDatabase,
  event: ClaimedEvent,
  leaseOwner: string,
  backoffSeconds: number,
  terminal: boolean,
): Promise<void> {
  const values = {
    availableAt: new Date(Date.now() + backoffSeconds * 1000),
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_RETRY_PENDING',
  };
  if (event.kind === 'publication_notification') {
    await database
      .updateTable('publicationNotificationOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('organisationId', '=', event.organisationId)
      .where('migrationRunId', '=', event.migrationRunId)
      .where('leaseOwner', '=', leaseOwner)
      .where('deliveredAt', 'is', null)
      .executeTakeFirstOrThrow();
    return;
  }
  if (event.kind === 'agent') {
    await database
      .updateTable('workflowOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .executeTakeFirstOrThrow();
    return;
  }
  if (event.kind === 'release_intelligence') {
    await database
      .updateTable('releaseIntelligenceOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('aggregateId', '=', event.payload.vendorReleaseId)
      .where('leaseOwner', '=', leaseOwner)
      .where('deliveredAt', 'is', null)
      .executeTakeFirstOrThrow();
    return;
  }
  const table =
    event.kind === 'repository_scan' ? 'repositoryScanOutbox' : 'migrationRunOutbox';
  await database
    .updateTable(table)
    .set(values)
    .where('id', '=', event.id)
    .where('leaseOwner', '=', leaseOwner)
    .executeTakeFirstOrThrow();
}
