import { createHash, randomUUID } from 'node:crypto';

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Transaction } from 'kysely';
import { z } from 'zod';

import {
  githubInstallationInventorySchema,
  githubWebhookEnvelopeSchema,
  type GithubInstallationInventory,
  type GithubWebhookEnvelope,
} from '@migration/contracts';
import {
  githubReconcilerConfigSchema,
  parseConfig,
  type GithubReconcilerConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase, type Database } from '@migration/database';
import { safeErrorCode, writeLog } from '@migration/observability';

const MAX_QUEUE_MESSAGE_BYTES = 256 * 1024;
const MAX_BROKER_RESPONSE_BYTES = 1024 * 1024;
const githubNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const webhookPayloadSchema = z
  .object({
    action: z.string().min(1).max(100).optional(),
    installation: z
      .object({
        id: githubNumberSchema,
      })
      .loose()
      .optional(),
    repository: z
      .object({
        id: githubNumberSchema,
      })
      .loose()
      .optional(),
    pull_request: z
      .object({
        number: githubNumberSchema,
        node_id: z.string().min(1).max(255),
        html_url: z
          .url()
          .regex(
            /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u,
          ),
        state: z.enum(['open', 'closed']),
        merged: z.boolean(),
        draft: z.boolean(),
        head: z.object({ ref: z.string().min(1).max(255) }).loose(),
        base: z.object({ ref: z.string().min(1).max(255) }).loose(),
      })
      .loose()
      .optional(),
  })
  .loose();

interface LinkedInstallation {
  readonly id: string;
  readonly organisationId: string;
}

interface BeginDeliveryInput {
  readonly action: string | null;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly payloadDigest: string;
  readonly receivedAt: Date;
}

interface PullRequestLifecycle {
  readonly githubRepositoryId: string;
  readonly pullRequestNumber: number;
  readonly pullRequestNodeId: string;
  readonly pullRequestUrl: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly isDraft: boolean;
}

export interface GithubReconciliationRepository {
  beginDelivery(input: BeginDeliveryInput): Promise<'process' | 'duplicate'>;
  resolveInstallation(
    githubInstallationId: string,
  ): Promise<LinkedInstallation | undefined>;
  completeInventory(
    deliveryId: string,
    linkedInstallation: LinkedInstallation,
    inventory: GithubInstallationInventory,
  ): Promise<void>;
  completeLifecycle(
    deliveryId: string,
    githubInstallationId: string,
    status: 'removed' | 'suspended',
  ): Promise<void>;
  completePullRequest(
    deliveryId: string,
    linkedInstallation: LinkedInstallation,
    lifecycle: PullRequestLifecycle,
  ): Promise<'reconciled' | 'ignored'>;
  completeWithoutReconciliation(deliveryId: string): Promise<void>;
  markDeliveryFailed(deliveryId: string, code: string): Promise<void>;
}

export interface GithubInventoryProvider {
  getInventory(linkedInstallationId: string): Promise<GithubInstallationInventory>;
}

interface ReconcilerDependencies {
  readonly config: GithubReconcilerConfig;
  readonly repository: GithubReconciliationRepository;
  readonly inventoryProvider: GithubInventoryProvider;
}

let cachedDependencies: ReconcilerDependencies | undefined;

async function dependencies(): Promise<ReconcilerDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(githubReconcilerConfigSchema);
  const database = await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN);
  const lambda = new LambdaClient({ region: config.AWS_REGION });
  cachedDependencies = {
    config,
    repository: new ReconciliationRepository(database),
    inventoryProvider: createGithubInventoryProvider(
      lambda,
      config.GITHUB_TOKEN_BROKER_FUNCTION_NAME,
    ),
  };
  return cachedDependencies;
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  return handleReconciliationBatch(event, await dependencies());
}

export async function handleReconciliationBatch(
  event: SQSEvent,
  dependency: ReconcilerDependencies,
): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse['batchItemFailures'] = [];
  for (const record of event.Records) {
    try {
      await processRecord(record, dependency);
    } catch (error) {
      failures.push({ itemIdentifier: record.messageId });
      writeLog('error', {
        event: 'github_reconciliation_failed',
        requestId: record.messageId,
        safeErrorCode: safeErrorCode(error),
      });
    }
  }
  return { batchItemFailures: failures };
}

async function processRecord(
  record: SQSRecord,
  dependency: ReconcilerDependencies,
): Promise<void> {
  const envelope = parseEnvelope(record.body);
  const payload = parseAndVerifyPayload(envelope);
  const action = payload.action ?? null;
  const disposition = await dependency.repository.beginDelivery({
    action,
    deliveryId: envelope.deliveryId,
    eventName: envelope.eventName,
    payloadDigest: envelope.payloadDigest,
    receivedAt: new Date(envelope.receivedAt),
  });
  if (disposition === 'duplicate') {
    writeLog('info', {
      event: 'github_reconciliation_duplicate',
      requestId: record.messageId,
      upstreamRequestId: envelope.deliveryId,
      outcome: 'processed',
    });
    return;
  }

  try {
    if (envelope.eventName === 'push') {
      await dependency.repository.completeWithoutReconciliation(envelope.deliveryId);
      return;
    }

    const installationId = requiredInstallationId(payload);
    const linkedInstallation =
      await dependency.repository.resolveInstallation(installationId);
    if (envelope.eventName === 'pull_request') {
      if (!linkedInstallation) {
        await dependency.repository.completeWithoutReconciliation(envelope.deliveryId);
        return;
      }
      const outcome = await dependency.repository.completePullRequest(
        envelope.deliveryId,
        linkedInstallation,
        requiredPullRequestLifecycle(payload),
      );
      writeLog('info', {
        event: 'github_pull_request_reconciled',
        requestId: record.messageId,
        upstreamRequestId: envelope.deliveryId,
        organisationId: linkedInstallation.organisationId,
        outcome,
      });
      return;
    }
    if (!linkedInstallation) {
      throw new ReconciliationError('GITHUB_INSTALLATION_NOT_LINKED');
    }
    const inventory = await dependency.inventoryProvider.getInventory(
      linkedInstallation.id,
    );
    if (inventory.installation.installationId !== installationId) {
      throw new ReconciliationError('GITHUB_INSTALLATION_MISMATCH');
    }
    if (inventory.installation.status !== 'active') {
      await dependency.repository.completeLifecycle(
        envelope.deliveryId,
        installationId,
        inventory.installation.status,
      );
      return;
    }
    await dependency.repository.completeInventory(
      envelope.deliveryId,
      linkedInstallation,
      inventory,
    );
    writeLog('info', {
      event: 'github_reconciliation_completed',
      requestId: record.messageId,
      upstreamRequestId: envelope.deliveryId,
      outcome: String(inventory.repositories.length),
    });
  } catch (error) {
    await dependency.repository.markDeliveryFailed(
      envelope.deliveryId,
      safeErrorCode(error),
    );
    throw error;
  }
}

function parseEnvelope(body: string): GithubWebhookEnvelope {
  if (Buffer.byteLength(body, 'utf8') > MAX_QUEUE_MESSAGE_BYTES) {
    throw new ReconciliationError('GITHUB_WEBHOOK_MESSAGE_INVALID');
  }
  try {
    return githubWebhookEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    throw new ReconciliationError('GITHUB_WEBHOOK_MESSAGE_INVALID');
  }
}

function parseAndVerifyPayload(
  envelope: GithubWebhookEnvelope,
): z.infer<typeof webhookPayloadSchema> {
  if (!isCanonicalBase64(envelope.bodyBase64)) {
    throw new ReconciliationError('GITHUB_WEBHOOK_PAYLOAD_INVALID');
  }
  const bytes = Buffer.from(envelope.bodyBase64, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== envelope.payloadDigest) {
    throw new ReconciliationError('GITHUB_WEBHOOK_DIGEST_MISMATCH');
  }
  try {
    return webhookPayloadSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    throw new ReconciliationError('GITHUB_WEBHOOK_PAYLOAD_INVALID');
  }
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value) &&
    Buffer.from(value, 'base64').toString('base64') === value
  );
}

function requiredInstallationId(payload: z.infer<typeof webhookPayloadSchema>): string {
  if (!payload.installation) {
    throw new ReconciliationError('GITHUB_WEBHOOK_PAYLOAD_INVALID');
  }
  return String(payload.installation.id);
}

function requiredPullRequestLifecycle(
  payload: z.infer<typeof webhookPayloadSchema>,
): PullRequestLifecycle {
  if (!payload.repository || !payload.pull_request) {
    throw new ReconciliationError('GITHUB_PULL_REQUEST_PAYLOAD_INVALID');
  }
  const pullRequest = payload.pull_request;
  if (pullRequest.merged && pullRequest.state !== 'closed') {
    throw new ReconciliationError('GITHUB_PULL_REQUEST_PAYLOAD_INVALID');
  }
  return {
    githubRepositoryId: String(payload.repository.id),
    pullRequestNumber: pullRequest.number,
    pullRequestNodeId: pullRequest.node_id,
    pullRequestUrl: pullRequest.html_url,
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state: pullRequest.merged ? 'merged' : pullRequest.state,
    isDraft: pullRequest.merged ? false : pullRequest.draft,
  };
}

interface LambdaInvoker {
  send(command: InvokeCommand): Promise<{
    readonly FunctionError?: string;
    readonly Payload?: Uint8Array;
  }>;
}

export function createGithubInventoryProvider(
  lambda: LambdaInvoker,
  functionName: string,
): GithubInventoryProvider {
  return {
    async getInventory(linkedInstallationId): Promise<GithubInstallationInventory> {
      let response;
      try {
        response = await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(
              JSON.stringify({
                operation: 'get_installation_inventory',
                linkedInstallationId,
              }),
            ),
          }),
        );
      } catch {
        throw new ReconciliationError('GITHUB_INVENTORY_REQUEST_FAILED');
      }
      if (
        response.FunctionError ||
        !response.Payload ||
        response.Payload.byteLength > MAX_BROKER_RESPONSE_BYTES
      ) {
        throw new ReconciliationError('GITHUB_INVENTORY_REQUEST_FAILED');
      }
      try {
        return githubInstallationInventorySchema.parse(
          JSON.parse(Buffer.from(response.Payload).toString('utf8')),
        );
      } catch {
        throw new ReconciliationError('GITHUB_INVENTORY_RESPONSE_INVALID');
      }
    },
  };
}

export class ReconciliationRepository implements GithubReconciliationRepository {
  public constructor(private readonly database: AppDatabase) {}

  public async beginDelivery(
    input: BeginDeliveryInput,
  ): Promise<'process' | 'duplicate'> {
    return this.database.transaction().execute(async transaction => {
      const existing = await transaction
        .selectFrom('githubWebhookDeliveries')
        .select(['processingState', 'attempts'])
        .where('deliveryId', '=', input.deliveryId)
        .forUpdate()
        .executeTakeFirst();
      if (existing?.processingState === 'processed') return 'duplicate';

      const now = new Date();
      if (existing) {
        await transaction
          .updateTable('githubWebhookDeliveries')
          .set({
            processingState: 'processing',
            attempts: Math.min(existing.attempts + 1, 20),
            safeErrorCode: null,
            updatedAt: now,
          })
          .where('deliveryId', '=', input.deliveryId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto('githubWebhookDeliveries')
          .values({
            deliveryId: input.deliveryId,
            eventName: input.eventName,
            action: input.action,
            payloadDigest: input.payloadDigest,
            processingState: 'processing',
            attempts: 1,
            safeErrorCode: null,
            receivedAt: input.receivedAt,
            processedAt: null,
            createdAt: now,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      }
      return 'process';
    });
  }

  public resolveInstallation(
    githubInstallationId: string,
  ): Promise<LinkedInstallation | undefined> {
    return this.database
      .selectFrom('githubInstallations')
      .select(['id', 'organisationId'])
      .where('githubInstallationId', '=', githubInstallationId)
      .executeTakeFirst();
  }

  public async completeInventory(
    deliveryId: string,
    linkedInstallation: LinkedInstallation,
    inventory: GithubInstallationInventory,
  ): Promise<void> {
    await this.database.transaction().execute(async transaction => {
      const installation = await transaction
        .selectFrom('githubInstallations')
        .select(['id', 'organisationId', 'githubInstallationId'])
        .where('id', '=', linkedInstallation.id)
        .where('organisationId', '=', linkedInstallation.organisationId)
        .forUpdate()
        .executeTakeFirst();
      if (
        installation?.githubInstallationId !== inventory.installation.installationId
      ) {
        throw new ReconciliationError('GITHUB_INSTALLATION_MISMATCH');
      }

      const repositoryIds = inventory.repositories.map(
        repository => repository.githubRepositoryId,
      );
      if (repositoryIds.length > 0) {
        const conflicting = await transaction
          .selectFrom('repositories')
          .select(['githubRepositoryId', 'organisationId'])
          .where('githubRepositoryId', 'in', repositoryIds)
          .where('organisationId', '!=', installation.organisationId)
          .executeTakeFirst();
        requireRepositoryOrganisation(
          conflicting?.organisationId,
          installation.organisationId,
        );
        const now = new Date();
        await transaction
          .insertInto('repositories')
          .values(
            inventory.repositories.map(repository => ({
              id: randomUUID(),
              organisationId: installation.organisationId,
              installationId: installation.id,
              githubRepositoryId: repository.githubRepositoryId,
              owner: repository.owner,
              name: repository.name,
              fullName: repository.fullName,
              defaultBranch: repository.defaultBranch,
              visibility: repository.visibility,
              selected: true,
              archived: repository.archived,
              enabled: !repository.archived,
              createdAt: now,
              updatedAt: now,
            })),
          )
          .onConflict(conflict =>
            conflict.column('githubRepositoryId').doUpdateSet(expression => ({
              installationId: expression.ref('excluded.installationId'),
              owner: expression.ref('excluded.owner'),
              name: expression.ref('excluded.name'),
              fullName: expression.ref('excluded.fullName'),
              defaultBranch: expression.ref('excluded.defaultBranch'),
              visibility: expression.ref('excluded.visibility'),
              selected: true,
              archived: expression.ref('excluded.archived'),
              enabled: expression.ref('excluded.enabled'),
              updatedAt: expression.ref('excluded.updatedAt'),
            })),
          )
          .execute();
      }

      let removedRepositories = transaction
        .updateTable('repositories')
        .set({ selected: false, enabled: false, updatedAt: new Date() })
        .where('installationId', '=', installation.id);
      if (repositoryIds.length > 0) {
        removedRepositories = removedRepositories.where(
          'githubRepositoryId',
          'not in',
          repositoryIds,
        );
      }
      await removedRepositories.execute();

      const now = new Date();
      await transaction
        .updateTable('githubInstallations')
        .set({
          githubAccountId: inventory.installation.accountId,
          accountLogin: inventory.installation.accountLogin,
          accountType: inventory.installation.accountType,
          status: 'active',
          suspendedAt: null,
          removedAt: null,
          lastReconciledAt: now,
          updatedAt: now,
        })
        .where('id', '=', installation.id)
        .executeTakeFirstOrThrow();
      await completeDelivery(transaction, deliveryId, now);
    });
  }

  public async completeLifecycle(
    deliveryId: string,
    githubInstallationId: string,
    status: 'removed' | 'suspended',
  ): Promise<void> {
    await this.database.transaction().execute(async transaction => {
      const now = new Date();
      const installation = await transaction
        .selectFrom('githubInstallations')
        .select('id')
        .where('githubInstallationId', '=', githubInstallationId)
        .forUpdate()
        .executeTakeFirst();
      if (installation) {
        await transaction
          .updateTable('githubInstallations')
          .set({
            status,
            suspendedAt: status === 'suspended' ? now : null,
            removedAt: status === 'removed' ? now : null,
            updatedAt: now,
          })
          .where('id', '=', installation.id)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('repositories')
          .set({ enabled: false, updatedAt: now })
          .where('installationId', '=', installation.id)
          .execute();
      }
      await completeDelivery(transaction, deliveryId, now);
    });
  }

  public async completePullRequest(
    deliveryId: string,
    linkedInstallation: LinkedInstallation,
    lifecycle: PullRequestLifecycle,
  ): Promise<'reconciled' | 'ignored'> {
    return this.database.transaction().execute(async transaction => {
      const publication = await transaction
        .selectFrom('githubPublications as publication')
        .innerJoin('repositories as repository', join =>
          join
            .onRef('repository.id', '=', 'publication.repositoryId')
            .onRef('repository.organisationId', '=', 'publication.organisationId'),
        )
        .select([
          'publication.id',
          'publication.pullRequestNodeId',
          'publication.pullRequestUrl',
          'publication.headBranch',
          'publication.baseBranch',
          'publication.state',
          'repository.installationId',
        ])
        .where('publication.organisationId', '=', linkedInstallation.organisationId)
        .where('publication.githubRepositoryId', '=', lifecycle.githubRepositoryId)
        .where('publication.pullRequestNumber', '=', lifecycle.pullRequestNumber)
        .forUpdate('publication')
        .executeTakeFirst();
      if (!publication) {
        await completeDelivery(transaction, deliveryId, new Date());
        return 'ignored';
      }
      if (
        publication.installationId !== linkedInstallation.id ||
        publication.pullRequestNodeId !== lifecycle.pullRequestNodeId ||
        publication.pullRequestUrl !== lifecycle.pullRequestUrl ||
        publication.headBranch !== lifecycle.headBranch ||
        publication.baseBranch !== lifecycle.baseBranch
      ) {
        throw new ReconciliationError('GITHUB_PULL_REQUEST_IDENTITY_MISMATCH');
      }
      const now = new Date();
      await transaction
        .updateTable('githubPublications')
        .set({
          state: publication.state === 'merged' ? 'merged' : lifecycle.state,
          isDraft: publication.state === 'merged' ? false : lifecycle.isDraft,
          lastReconciledAt: now,
        })
        .where('id', '=', publication.id)
        .executeTakeFirstOrThrow();
      await completeDelivery(transaction, deliveryId, now);
      return 'reconciled';
    });
  }

  public completeWithoutReconciliation(deliveryId: string): Promise<void> {
    return this.database
      .transaction()
      .execute(transaction => completeDelivery(transaction, deliveryId, new Date()));
  }

  public async markDeliveryFailed(deliveryId: string, code: string): Promise<void> {
    await this.database
      .updateTable('githubWebhookDeliveries')
      .set({
        processingState: 'failed',
        safeErrorCode: normalizeSafeCode(code),
        updatedAt: new Date(),
      })
      .where('deliveryId', '=', deliveryId)
      .where('processingState', '!=', 'processed')
      .execute();
  }
}

async function completeDelivery(
  transaction: Transaction<Database>,
  deliveryId: string,
  now: Date,
): Promise<void> {
  await transaction
    .updateTable('githubWebhookDeliveries')
    .set({
      processingState: 'processed',
      processedAt: now,
      safeErrorCode: null,
      updatedAt: now,
    })
    .where('deliveryId', '=', deliveryId)
    .executeTakeFirstOrThrow();
}

function normalizeSafeCode(code: string): string {
  return /^[A-Z][A-Z0-9_]{2,63}$/u.test(code) ? code : 'INTERNAL_ERROR';
}

export function requireRepositoryOrganisation(
  existingOrganisationId: string | undefined,
  requestedOrganisationId: string,
): void {
  if (
    existingOrganisationId !== undefined &&
    existingOrganisationId !== requestedOrganisationId
  ) {
    throw new ReconciliationError('GITHUB_REPOSITORY_ALREADY_LINKED');
  }
}

class ReconciliationError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The GitHub reconciliation could not be completed.');
    this.name = 'ReconciliationError';
  }
}
