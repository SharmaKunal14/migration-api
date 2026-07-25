import { randomUUID } from 'node:crypto';

import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { ScheduledEvent } from 'aws-lambda';

import {
  repositoryScanWorkflowInputSchema,
  workflowInputSchema,
  type RepositoryScanWorkflowInput,
  type WorkflowInput,
} from '@migration/contracts';
import {
  dispatcherConfigSchema,
  parseConfig,
  type DispatcherConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import { writeLog } from '@migration/observability';

const BATCH_SIZE = 5;
const LEASE_MILLISECONDS = 60_000;
const MAX_ATTEMPTS = 10;

interface DispatcherDependencies {
  readonly config: DispatcherConfig;
  readonly database: AppDatabase;
  readonly stepFunctions: SFNClient;
}

type ClaimedEvent =
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
      await dependency.stepFunctions.send(
        new StartExecutionCommand({
          stateMachineArn:
            event.kind === 'agent'
              ? dependency.config.STATE_MACHINE_ARN
              : dependency.config.REPOSITORY_SCAN_STATE_MACHINE_ARN,
          name:
            event.kind === 'agent'
              ? `agent-${event.payload.agentRunId}`
              : `repository-scan-${event.payload.repositoryScanId}`,
          input: JSON.stringify(event.payload),
        }),
      );
      await markDelivered(dependency.database, event, leaseOwner);
      writeLog('info', {
        event: 'outbox_event_delivered',
        correlationId: event.payload.correlationId,
        organisationId: event.payload.organisationId,
        ...(event.kind === 'agent'
          ? { agentRunId: event.payload.agentRunId }
          : { repositoryScanId: event.payload.repositoryScanId }),
      });
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) {
        await markDelivered(dependency.database, event, leaseOwner);
        continue;
      }
      const terminal = event.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(300, 2 ** event.attempts);
      await markRetry(dependency.database, event, leaseOwner, backoffSeconds, terminal);
      writeLog(terminal ? 'error' : 'warn', {
        event: terminal ? 'outbox_event_failed' : 'outbox_event_retry_scheduled',
        correlationId: event.payload.correlationId,
        organisationId: event.payload.organisationId,
        ...(event.kind === 'agent'
          ? { agentRunId: event.payload.agentRunId }
          : { repositoryScanId: event.payload.repositoryScanId }),
        safeErrorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_RETRY_PENDING',
      });
    }
  }
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
      .limit(BATCH_SIZE)
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
  const remaining = BATCH_SIZE - agentEvents.length;
  if (remaining === 0) return agentEvents;
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
      .limit(remaining)
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
  return [...agentEvents, ...scanEvents];
}

async function markDelivered(
  database: AppDatabase,
  event: ClaimedEvent,
  leaseOwner: string,
): Promise<void> {
  const values = {
    deliveredAt: new Date(),
    leaseOwner: null,
    leaseExpiresAt: null,
    safeErrorCode: null,
  };
  if (event.kind === 'agent') {
    await database
      .updateTable('workflowOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .executeTakeFirstOrThrow();
    return;
  }
  await database
    .updateTable('repositoryScanOutbox')
    .set(values)
    .where('id', '=', event.id)
    .where('leaseOwner', '=', leaseOwner)
    .executeTakeFirstOrThrow();
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
  if (event.kind === 'agent') {
    await database
      .updateTable('workflowOutbox')
      .set(values)
      .where('id', '=', event.id)
      .where('leaseOwner', '=', leaseOwner)
      .executeTakeFirstOrThrow();
    return;
  }
  await database
    .updateTable('repositoryScanOutbox')
    .set(values)
    .where('id', '=', event.id)
    .where('leaseOwner', '=', leaseOwner)
    .executeTakeFirstOrThrow();
}
