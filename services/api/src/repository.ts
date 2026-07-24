import { createHash, randomUUID } from 'node:crypto';

import type { Transaction } from 'kysely';

import type { AppDatabase, Database } from '@migration/database';
import type { Actor, Membership } from '@migration/domain';
import { DomainError, requireAction, type OrganisationRole } from '@migration/domain';

export interface OrganisationRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: OrganisationRole;
}

export interface AgentRunRecord {
  readonly id: string;
  readonly organisationId: string;
  readonly scenarioId: 'orbitchat-typescript-v1-v2';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly terminalCode: string | null;
  readonly safeErrorCode: string | null;
  readonly resultArtifactId: string | null;
  readonly resultObjectKey: string | null;
  readonly resultDigest: string | null;
  readonly resultBytes: number | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface CreateOrganisationInput {
  readonly name: string;
  readonly slug: string;
  readonly requestId: string;
}

export interface CreateDemoRunInput {
  readonly organisationId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly scenarioId: 'orbitchat-typescript-v1-v2';
  readonly requestedModel: string;
}

export interface ApiRepositoryPort {
  ensureUser(actor: Actor): Promise<string>;
  listOrganisations(userId: string): Promise<OrganisationRecord[]>;
  createOrganisation(
    userId: string,
    input: CreateOrganisationInput,
  ): Promise<OrganisationRecord>;
  createDemoRun(userId: string, input: CreateDemoRunInput): Promise<AgentRunRecord>;
  getRun(
    userId: string,
    organisationId: string,
    runId: string,
  ): Promise<AgentRunRecord>;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ApiRepository implements ApiRepositoryPort {
  public constructor(private readonly database: AppDatabase) {}

  public async ensureUser(actor: Actor): Promise<string> {
    const existing = await this.database
      .selectFrom('appUsers')
      .select('id')
      .where('authSubject', '=', actor.subject)
      .executeTakeFirst();
    if (existing) {
      return existing.id;
    }
    const inserted = await this.database
      .insertInto('appUsers')
      .values({
        id: randomUUID(),
        authSubject: actor.subject,
        displayName: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflict(conflict => conflict.column('authSubject').doNothing())
      .returning('id')
      .executeTakeFirst();
    if (inserted) {
      return inserted.id;
    }
    const raced = await this.database
      .selectFrom('appUsers')
      .select('id')
      .where('authSubject', '=', actor.subject)
      .executeTakeFirstOrThrow();
    return raced.id;
  }

  public async listOrganisations(userId: string): Promise<OrganisationRecord[]> {
    return this.database
      .selectFrom('organisationMemberships as membership')
      .innerJoin(
        'organisations as organisation',
        'organisation.id',
        'membership.organisationId',
      )
      .select([
        'organisation.id',
        'organisation.name',
        'organisation.slug',
        'membership.role',
      ])
      .where('membership.userId', '=', userId)
      .where('organisation.status', '=', 'active')
      .orderBy('organisation.createdAt', 'asc')
      .execute();
  }

  public async createOrganisation(
    userId: string,
    input: CreateOrganisationInput,
  ): Promise<OrganisationRecord> {
    return this.database.transaction().execute(async transaction => {
      const id = randomUUID();
      const now = new Date();
      try {
        await transaction
          .insertInto('organisations')
          .values({
            id,
            name: input.name,
            slug: input.slug,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          })
          .executeTakeFirstOrThrow();
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new DomainError(
            'ORGANISATION_SLUG_CONFLICT',
            'That organisation slug is already in use.',
            409,
          );
        }
        throw error;
      }
      await transaction
        .insertInto('organisationMemberships')
        .values({
          organisationId: id,
          userId,
          role: 'owner',
          createdAt: now,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await writeAudit(transaction, {
        organisationId: id,
        actorId: userId,
        action: 'organisation.created',
        resourceType: 'organisation',
        resourceId: id,
        requestId: input.requestId,
      });
      return { id, name: input.name, slug: input.slug, role: 'owner' };
    });
  }

  public async membership(
    organisationId: string,
    userId: string,
  ): Promise<Membership | undefined> {
    return this.database
      .selectFrom('organisationMemberships as membership')
      .innerJoin(
        'organisations as organisation',
        'organisation.id',
        'membership.organisationId',
      )
      .select(['membership.organisationId', 'membership.userId', 'membership.role'])
      .where('membership.organisationId', '=', organisationId)
      .where('membership.userId', '=', userId)
      .where('organisation.status', '=', 'active')
      .executeTakeFirst();
  }

  public async createDemoRun(
    userId: string,
    input: CreateDemoRunInput,
  ): Promise<AgentRunRecord> {
    const requestDigest = digestJson({
      organisationId: input.organisationId,
      scenarioId: input.scenarioId,
    });
    return this.database.transaction().execute(async transaction => {
      const membership = await transaction
        .selectFrom('organisationMemberships as membership')
        .innerJoin(
          'organisations as organisation',
          'organisation.id',
          'membership.organisationId',
        )
        .select(['membership.organisationId', 'membership.userId', 'membership.role'])
        .where('membership.organisationId', '=', input.organisationId)
        .where('membership.userId', '=', userId)
        .where('organisation.status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      requireAction(membership, 'demo_run:create');

      const previous = await transaction
        .selectFrom('apiIdempotencyKeys')
        .select(['requestDigest', 'resultResourceId'])
        .where('actorId', '=', userId)
        .where('action', '=', 'demo_run:create')
        .where('idempotencyKey', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.requestDigest !== requestDigest) {
          throw new DomainError(
            'IDEMPOTENCY_KEY_REUSED',
            'The idempotency key was already used for a different request.',
            409,
          );
        }
        return loadRun(transaction, input.organisationId, previous.resultResourceId);
      }

      const id = randomUUID();
      const eventId = randomUUID();
      const now = new Date();
      await transaction
        .insertInto('agentRuns')
        .values({
          id,
          organisationId: input.organisationId,
          requestedByUserId: userId,
          scenarioId: input.scenarioId,
          status: 'queued',
          terminalCode: null,
          safeErrorCode: null,
          resultArtifactId: null,
          requestedModel: input.requestedModel,
          returnedModel: null,
          openaiRequestId: null,
          inputTokens: 0,
          outputTokens: 0,
          modelCalls: 0,
          toolCalls: 0,
          iterations: 0,
          version: 1,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('workflowOutbox')
        .values({
          id: eventId,
          eventType: 'agent_run.requested',
          aggregateId: id,
          aggregateVersion: 1,
          idempotencyKey: `agent-run:${id}`,
          payload: {
            schemaVersion: '1.0',
            organisationId: input.organisationId,
            agentRunId: id,
            correlationId: input.requestId,
            expectedVersion: 1,
          },
          availableAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          attempts: 0,
          deliveredAt: null,
          safeErrorCode: null,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('apiIdempotencyKeys')
        .values({
          actorId: userId,
          action: 'demo_run:create',
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          resultResourceId: id,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })
        .executeTakeFirstOrThrow();
      await writeAudit(transaction, {
        organisationId: input.organisationId,
        actorId: userId,
        action: 'demo_run.created',
        resourceType: 'agent_run',
        resourceId: id,
        requestId: input.requestId,
      });
      return loadRun(transaction, input.organisationId, id);
    });
  }

  public async getRun(
    userId: string,
    organisationId: string,
    runId: string,
  ): Promise<AgentRunRecord> {
    requireAction(await this.membership(organisationId, userId), 'demo_run:read');
    return loadRun(this.database, organisationId, runId);
  }
}

async function loadRun(
  database: AppDatabase | Transaction<Database>,
  organisationId: string,
  runId: string,
): Promise<AgentRunRecord> {
  const run = await database
    .selectFrom('agentRuns as run')
    .leftJoin('artifacts as artifact', 'artifact.id', 'run.resultArtifactId')
    .select([
      'run.id',
      'run.organisationId',
      'run.scenarioId',
      'run.status',
      'run.terminalCode',
      'run.safeErrorCode',
      'run.resultArtifactId',
      'artifact.objectKey as resultObjectKey',
      'artifact.digest as resultDigest',
      'artifact.bytes as resultBytes',
      'run.version',
      'run.createdAt',
      'run.startedAt',
      'run.completedAt',
    ])
    .where('run.organisationId', '=', organisationId)
    .where('run.id', '=', runId)
    .executeTakeFirst();
  if (!run) {
    throw new DomainError('RUN_NOT_FOUND', 'The requested run was not found.', 404);
  }
  return run;
}

interface AuditInput {
  readonly organisationId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly requestId: string;
}

async function writeAudit(
  transaction: Transaction<Database>,
  input: AuditInput,
): Promise<void> {
  await transaction
    .insertInto('auditEvents')
    .values({
      id: randomUUID(),
      organisationId: input.organisationId,
      actorType: 'user',
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      metadata: {},
      createdAt: new Date(),
    })
    .executeTakeFirstOrThrow();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}
