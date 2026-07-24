import { randomUUID } from 'node:crypto';

import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { ScheduledEvent } from 'aws-lambda';

import { workflowInputSchema, type WorkflowInput } from '@migration/contracts';
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

interface ClaimedEvent {
  readonly id: string;
  readonly payload: WorkflowInput;
  readonly attempts: number;
}

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
          stateMachineArn: dependency.config.STATE_MACHINE_ARN,
          name: `agent-${event.payload.agentRunId}`,
          input: JSON.stringify(event.payload),
        }),
      );
      await dependency.database
        .updateTable('workflowOutbox')
        .set({
          deliveredAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          safeErrorCode: null,
        })
        .where('id', '=', event.id)
        .where('leaseOwner', '=', leaseOwner)
        .executeTakeFirstOrThrow();
      writeLog('info', {
        event: 'outbox_event_delivered',
        correlationId: event.payload.correlationId,
        organisationId: event.payload.organisationId,
        agentRunId: event.payload.agentRunId,
      });
    } catch (error) {
      if (error instanceof ExecutionAlreadyExists) {
        await dependency.database
          .updateTable('workflowOutbox')
          .set({
            deliveredAt: new Date(),
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: null,
          })
          .where('id', '=', event.id)
          .executeTakeFirstOrThrow();
        continue;
      }
      const terminal = event.attempts >= MAX_ATTEMPTS;
      const backoffSeconds = Math.min(300, 2 ** event.attempts);
      await dependency.database
        .updateTable('workflowOutbox')
        .set({
          availableAt: new Date(Date.now() + backoffSeconds * 1000),
          leaseOwner: null,
          leaseExpiresAt: null,
          safeErrorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_RETRY_PENDING',
        })
        .where('id', '=', event.id)
        .where('leaseOwner', '=', leaseOwner)
        .executeTakeFirstOrThrow();
      writeLog(terminal ? 'error' : 'warn', {
        event: terminal ? 'outbox_event_failed' : 'outbox_event_retry_scheduled',
        correlationId: event.payload.correlationId,
        organisationId: event.payload.organisationId,
        agentRunId: event.payload.agentRunId,
        safeErrorCode: terminal ? 'OUTBOX_DELIVERY_FAILED' : 'OUTBOX_RETRY_PENDING',
      });
    }
  }
}

async function claimEvents(
  database: AppDatabase,
  leaseOwner: string,
): Promise<ClaimedEvent[]> {
  return database.transaction().execute(async transaction => {
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
      claimed.push({ id: candidate.id, payload, attempts: candidate.attempts + 1 });
    }
    return claimed;
  });
}
