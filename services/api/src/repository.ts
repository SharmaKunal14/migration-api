import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql, type Transaction } from 'kysely';

import {
  CandidateMatchingError,
  reconcileCandidatesForSpecification,
} from '@migration/candidate-matching';
import type { AppDatabase, Database } from '@migration/database';
import { impactReportSchema, migrationSpecificationSchema } from '@migration/contracts';
import type {
  GithubInstallationVerification,
  MigrationSpecification,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationCandidateImpactReport,
  PublicImpactReportSummary,
  PublicMigrationSpecification,
  PublicMigrationSpecificationDetail,
  PublicMigrationSpecificationReview,
  PublicRepository,
  PublicRepositoryScan,
} from '@migration/contracts';
import type { Actor, Membership } from '@migration/domain';
import {
  DomainError,
  isRepositoryScannable,
  requireAction,
  type OrganisationRole,
} from '@migration/domain';

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
  readonly resultBytes: string | null;
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

export interface CreateRepositoryScanInput {
  readonly organisationId: string;
  readonly repositoryId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface ReviewMigrationSpecificationInput {
  readonly specificationId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface InstallationLinkRecord {
  readonly state: string;
  readonly expiresAt: Date;
}

export interface CompleteGithubInstallationInput {
  readonly installationId: string;
  readonly requestId: string;
  readonly state: string;
  readonly verified: GithubInstallationVerification;
}

export interface CompletedGithubInstallation {
  readonly organisationId: string;
  readonly installation: PublicGithubInstallation;
}

export interface InstallationLinkStateRecord {
  readonly organisationId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export const GITHUB_INSTALL_RETURN_PATH = '/settings/github';

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
  listGithubInstallations(
    userId: string,
    organisationId: string,
  ): Promise<PublicGithubInstallation[]>;
  listRepositories(userId: string, organisationId: string): Promise<PublicRepository[]>;
  listDependencies(
    userId: string,
    organisationId: string,
    repositoryId: string,
  ): Promise<PublicDependencyObservation[]>;
  createRepositoryScan(
    userId: string,
    input: CreateRepositoryScanInput,
  ): Promise<PublicRepositoryScan>;
  createGithubInstallLink(
    userId: string,
    organisationId: string,
  ): Promise<InstallationLinkRecord>;
  validateGithubInstallState(userId: string, state: string): Promise<void>;
  completeGithubInstallation(
    userId: string,
    input: CompleteGithubInstallationInput,
  ): Promise<CompletedGithubInstallation>;
  listMigrationSpecifications(
    userId: string,
    trustState: 'draft' | 'reviewed' | 'vendor_verified',
  ): Promise<PublicMigrationSpecification[]>;
  getMigrationSpecification(
    userId: string,
    specificationId: string,
  ): Promise<PublicMigrationSpecificationDetail>;
  reviewMigrationSpecification(
    userId: string,
    input: ReviewMigrationSpecificationInput,
  ): Promise<PublicMigrationSpecificationReview>;
  listMigrationCandidates(
    userId: string,
    organisationId: string,
  ): Promise<PublicMigrationCandidate[]>;
  getMigrationCandidate(
    userId: string,
    organisationId: string,
    candidateId: string,
  ): Promise<PublicMigrationCandidateDetail>;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface StoredImpactReport {
  readonly id: string;
  readonly candidateId: string;
  readonly repositoryId: string;
  readonly repositorySnapshotId: string;
  readonly outcome: 'affected' | 'not_affected' | 'inconclusive';
  readonly affectedSummary: unknown;
  readonly riskCategory: 'low' | 'medium' | 'high' | 'unknown';
  readonly verificationAvailability: unknown;
  readonly uncertainty: unknown;
  readonly artifactDigest: string;
  readonly revision: number;
  readonly createdAt: Date;
  readonly commitSha: string;
  readonly snapshotDigest: string;
}

function publicImpactReport(
  row: StoredImpactReport,
  currentSnapshotId: string,
): PublicMigrationCandidateImpactReport {
  const report = impactReportSchema.safeParse({
    schemaVersion: '1.0',
    candidateId: row.candidateId,
    repository: {
      repositoryId: row.repositoryId,
      snapshotId: row.repositorySnapshotId,
      commitSha: row.commitSha,
      snapshotDigest: row.snapshotDigest,
    },
    outcome: row.outcome,
    affectedFiles: readObjectProperty(row.affectedSummary, 'affectedFiles'),
    unaffectedFiles: readObjectProperty(row.affectedSummary, 'unaffectedFiles'),
    verification: row.verificationAvailability,
    risk: row.riskCategory,
    uncertainties: row.uncertainty,
    revision: row.revision,
    generatedAt: row.createdAt.toISOString(),
  });
  if (!report.success) {
    throw new DomainError(
      'IMPACT_REPORT_INVALID',
      'The impact report could not be loaded.',
      500,
    );
  }
  return {
    id: row.id,
    outcome: report.data.outcome,
    riskCategory: report.data.risk,
    freshness: row.repositorySnapshotId === currentSnapshotId ? 'current' : 'stale',
    affectedFileCount: report.data.affectedFiles.length,
    uncertaintyCount: report.data.uncertainties.length,
    analysedCommit: report.data.repository.commitSha,
    snapshotDigest: report.data.repository.snapshotDigest,
    artifactDigest: row.artifactDigest,
    revision: report.data.revision,
    affectedFiles: report.data.affectedFiles,
    unaffectedFiles: report.data.unaffectedFiles,
    verification: report.data.verification,
    uncertainties: report.data.uncertainties,
    createdAt: row.createdAt.toISOString(),
  };
}

function readObjectProperty(value: unknown, property: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Reflect.get(value, property) as unknown;
}

function publicImpactReportSummary(
  report: PublicMigrationCandidateImpactReport,
): PublicImpactReportSummary {
  return {
    id: report.id,
    outcome: report.outcome,
    riskCategory: report.riskCategory,
    freshness: report.freshness,
    affectedFileCount: report.affectedFileCount,
    uncertaintyCount: report.uncertaintyCount,
    analysedCommit: report.analysedCommit,
    createdAt: report.createdAt,
  };
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
    database: AppDatabase | Transaction<Database> = this.database,
  ): Promise<Membership | undefined> {
    return database
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

  public async listGithubInstallations(
    userId: string,
    organisationId: string,
  ): Promise<PublicGithubInstallation[]> {
    requireAction(await this.membership(organisationId, userId), 'organisation:read');
    const rows = await this.database
      .selectFrom('githubInstallations')
      .select(['id', 'accountLogin', 'accountType', 'status', 'lastReconciledAt'])
      .where('organisationId', '=', organisationId)
      .orderBy('createdAt', 'asc')
      .limit(100)
      .execute();
    return rows.map(row => ({
      ...row,
      lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    }));
  }

  public async createGithubInstallLink(
    userId: string,
    organisationId: string,
  ): Promise<InstallationLinkRecord> {
    return this.database.transaction().execute(async transaction => {
      const membership = await transaction
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
        .forUpdate()
        .executeTakeFirst();
      requireAction(membership, 'github_installation:manage');

      const state = randomBytes(32).toString('base64url');
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1_000);
      await transaction
        .insertInto('installationLinkStates')
        .values({
          stateDigest: createHash('sha256').update(state).digest('hex'),
          organisationId,
          userId,
          expiresAt,
          consumedAt: null,
          returnPath: GITHUB_INSTALL_RETURN_PATH,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
      return { state, expiresAt };
    });
  }

  public async completeGithubInstallation(
    userId: string,
    input: CompleteGithubInstallationInput,
  ): Promise<CompletedGithubInstallation> {
    if (input.verified.installationId !== input.installationId) {
      throw new DomainError(
        'GITHUB_INSTALLATION_MISMATCH',
        'The GitHub installation could not be linked.',
        409,
      );
    }
    const stateDigest = createHash('sha256').update(input.state).digest('hex');
    return this.database.transaction().execute(async transaction => {
      const now = new Date();
      const linkState = await transaction
        .selectFrom('installationLinkStates')
        .select(['organisationId', 'userId', 'expiresAt', 'consumedAt'])
        .where('stateDigest', '=', stateDigest)
        .forUpdate()
        .executeTakeFirst();
      const validLinkState = validateInstallationLinkState(linkState, userId, now);

      const membership = await transaction
        .selectFrom('organisationMemberships as membership')
        .innerJoin(
          'organisations as organisation',
          'organisation.id',
          'membership.organisationId',
        )
        .select(['membership.organisationId', 'membership.userId', 'membership.role'])
        .where('membership.organisationId', '=', validLinkState.organisationId)
        .where('membership.userId', '=', userId)
        .where('organisation.status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();
      requireAction(membership, 'github_installation:manage');

      const existing = await transaction
        .selectFrom('githubInstallations')
        .select(['id', 'organisationId', 'lastReconciledAt'])
        .where('githubInstallationId', '=', input.installationId)
        .forUpdate()
        .executeTakeFirst();
      requireInstallationOrganisation(
        existing?.organisationId,
        validLinkState.organisationId,
      );

      const installationId = existing?.id ?? randomUUID();
      const values = {
        githubAccountId: input.verified.accountId,
        accountLogin: input.verified.accountLogin,
        accountType: input.verified.accountType,
        status: input.verified.status,
        suspendedAt: input.verified.status === 'suspended' ? now : null,
        removedAt: null,
        updatedAt: now,
      } as const;
      if (existing) {
        await transaction
          .updateTable('githubInstallations')
          .set(values)
          .where('id', '=', installationId)
          .where('organisationId', '=', validLinkState.organisationId)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto('githubInstallations')
          .values({
            id: installationId,
            organisationId: validLinkState.organisationId,
            githubInstallationId: input.installationId,
            ...values,
            lastReconciledAt: null,
            createdAt: now,
          })
          .executeTakeFirstOrThrow();
      }

      await transaction
        .updateTable('installationLinkStates')
        .set({ consumedAt: now })
        .where('stateDigest', '=', stateDigest)
        .where('consumedAt', 'is', null)
        .executeTakeFirstOrThrow();
      await writeAudit(transaction, {
        organisationId: validLinkState.organisationId,
        actorId: userId,
        action: 'github_installation.linked',
        resourceType: 'github_installation',
        resourceId: installationId,
        requestId: input.requestId,
      });
      return {
        organisationId: validLinkState.organisationId,
        installation: {
          id: installationId,
          accountLogin: input.verified.accountLogin,
          accountType: input.verified.accountType,
          status: input.verified.status,
          lastReconciledAt: existing?.lastReconciledAt?.toISOString() ?? null,
        },
      };
    });
  }

  public async validateGithubInstallState(
    userId: string,
    state: string,
  ): Promise<void> {
    const stateDigest = createHash('sha256').update(state).digest('hex');
    const linkState = await this.database
      .selectFrom('installationLinkStates')
      .select(['organisationId', 'userId', 'expiresAt', 'consumedAt'])
      .where('stateDigest', '=', stateDigest)
      .executeTakeFirst();
    const validLinkState = validateInstallationLinkState(linkState, userId, new Date());
    requireAction(
      await this.membership(validLinkState.organisationId, userId),
      'github_installation:manage',
    );
  }

  public async listRepositories(
    userId: string,
    organisationId: string,
  ): Promise<PublicRepository[]> {
    requireAction(await this.membership(organisationId, userId), 'repository:read');
    const rows = await this.database
      .selectFrom('repositories as repository')
      .leftJoin('repositoryScans as scan', join =>
        join
          .onRef('scan.repositoryId', '=', 'repository.id')
          .onRef('scan.organisationId', '=', 'repository.organisationId'),
      )
      .distinctOn('repository.id')
      .select([
        'repository.id',
        'repository.installationId',
        'repository.fullName',
        'repository.defaultBranch',
        'repository.visibility',
        'repository.selected',
        'repository.archived',
        'repository.enabled',
        'scan.status as latestScanStatus',
        'scan.safeErrorCode as latestScanSafeErrorCode',
        'scan.requestedCommit as latestScannedCommit',
      ])
      .where('repository.organisationId', '=', organisationId)
      .orderBy('repository.id', 'asc')
      .orderBy('scan.createdAt', 'desc')
      .limit(500)
      .execute();
    return rows.sort((left, right) => left.fullName.localeCompare(right.fullName));
  }

  public async listDependencies(
    userId: string,
    organisationId: string,
    repositoryId: string,
  ): Promise<PublicDependencyObservation[]> {
    requireAction(await this.membership(organisationId, userId), 'repository:read');
    const repository = await this.database
      .selectFrom('repositories')
      .select('id')
      .where('id', '=', repositoryId)
      .where('organisationId', '=', organisationId)
      .executeTakeFirst();
    if (!repository) {
      throw new DomainError(
        'REPOSITORY_NOT_FOUND',
        'The repository was not found.',
        404,
      );
    }
    const snapshot = await this.database
      .selectFrom('repositorySnapshots')
      .select('id')
      .where('repositoryId', '=', repositoryId)
      .where('organisationId', '=', organisationId)
      .where('status', '=', 'available')
      .orderBy('updatedAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    if (!snapshot) return [];
    return this.database
      .selectFrom('dependencyObservations')
      .select([
        'packageName',
        'dependencyKind',
        'manifestPath',
        'lockfilePath',
        'declaredRange',
        'resolvedVersion',
        'discoveryMethod',
      ])
      .where('organisationId', '=', organisationId)
      .where('repositorySnapshotId', '=', snapshot.id)
      .orderBy('manifestPath', 'asc')
      .orderBy('packageName', 'asc')
      .orderBy('dependencyKind', 'asc')
      .limit(10_000)
      .execute();
  }

  public async createRepositoryScan(
    userId: string,
    input: CreateRepositoryScanInput,
  ): Promise<PublicRepositoryScan> {
    const requestDigest = digestJson({
      organisationId: input.organisationId,
      repositoryId: input.repositoryId,
    });
    return this.database.transaction().execute(async transaction => {
      requireAction(
        await this.membership(input.organisationId, userId, transaction),
        'repository:scan',
      );
      const repository = await transaction
        .selectFrom('repositories as repository')
        .innerJoin(
          'githubInstallations as installation',
          'installation.id',
          'repository.installationId',
        )
        .select([
          'repository.id',
          'repository.selected',
          'repository.enabled',
          'repository.archived',
          'installation.status as installationStatus',
        ])
        .where('repository.id', '=', input.repositoryId)
        .where('repository.organisationId', '=', input.organisationId)
        .forUpdate()
        .executeTakeFirst();
      if (!repository) {
        throw new DomainError(
          'REPOSITORY_NOT_FOUND',
          'The repository was not found.',
          404,
        );
      }
      if (!isRepositoryScannable(repository)) {
        throw new DomainError(
          'REPOSITORY_SCAN_NOT_ALLOWED',
          'The repository is not available for scanning.',
          409,
        );
      }

      const previous = await transaction
        .selectFrom('apiIdempotencyKeys')
        .select(['requestDigest', 'resultResourceId'])
        .where('actorId', '=', userId)
        .where('action', '=', 'repository:scan')
        .where('idempotencyKey', '=', input.idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.requestDigest !== requestDigest) {
          throw new DomainError(
            'IDEMPOTENCY_CONFLICT',
            'The idempotency key was already used for another request.',
            409,
          );
        }
        return publicRepositoryScan(
          await transaction
            .selectFrom('repositoryScans')
            .selectAll()
            .where('id', '=', previous.resultResourceId)
            .where('organisationId', '=', input.organisationId)
            .executeTakeFirstOrThrow(),
        );
      }

      const active = await transaction
        .selectFrom('repositoryScans')
        .selectAll()
        .where('repositoryId', '=', input.repositoryId)
        .where('status', 'in', ['queued', 'running'])
        .executeTakeFirst();
      if (active) {
        throw new DomainError(
          'REPOSITORY_SCAN_IN_PROGRESS',
          'A repository scan is already in progress.',
          409,
        );
      }

      const scanId = randomUUID();
      const correlationId = randomUUID();
      const now = new Date();
      const scan = await transaction
        .insertInto('repositoryScans')
        .values({
          id: scanId,
          organisationId: input.organisationId,
          repositoryId: input.repositoryId,
          requestedCommit: null,
          status: 'queued',
          triggerSource: 'manual',
          attempt: 0,
          safeErrorCode: null,
          version: 1,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('repositoryScanOutbox')
        .values({
          id: randomUUID(),
          repositoryScanId: scanId,
          aggregateVersion: 1,
          idempotencyKey: `repository-scan:${scanId}`,
          payload: {
            schemaVersion: '1.0',
            organisationId: input.organisationId,
            repositoryId: input.repositoryId,
            repositoryScanId: scanId,
            correlationId,
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
          action: 'repository:scan',
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          resultResourceId: scanId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })
        .executeTakeFirstOrThrow();
      await writeAudit(transaction, {
        organisationId: input.organisationId,
        actorId: userId,
        action: 'repository.scan_requested',
        resourceType: 'repository_scan',
        resourceId: scanId,
        requestId: input.requestId,
      });
      return publicRepositoryScan(scan);
    });
  }

  public async listMigrationSpecifications(
    userId: string,
    trustState: 'draft' | 'reviewed' | 'vendor_verified',
  ): Promise<PublicMigrationSpecification[]> {
    await requirePlatformOperator(this.database, userId);
    const rows = await this.database
      .selectFrom('migrationSpecifications as specification')
      .innerJoin(
        'vendorReleases as release',
        'release.id',
        'specification.vendorReleaseId',
      )
      .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
      .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
      .select(migrationSpecificationSummarySelection)
      .where('specification.trustState', '=', trustState)
      .orderBy('specification.createdAt', 'desc')
      .limit(100)
      .execute();
    return rows.map(publicMigrationSpecification);
  }

  public async getMigrationSpecification(
    userId: string,
    specificationId: string,
  ): Promise<PublicMigrationSpecificationDetail> {
    await requirePlatformOperator(this.database, userId);
    const row = await this.database
      .selectFrom('migrationSpecifications as specification')
      .innerJoin(
        'vendorReleases as release',
        'release.id',
        'specification.vendorReleaseId',
      )
      .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
      .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
      .select([
        ...migrationSpecificationSummarySelection,
        'specification.specification',
      ])
      .where('specification.id', '=', specificationId)
      .executeTakeFirst();
    if (!row) {
      throw new DomainError(
        'MIGRATION_SPECIFICATION_NOT_FOUND',
        'The migration specification was not found.',
        404,
      );
    }
    const specification = migrationSpecificationSchema.safeParse(row.specification);
    if (!specification.success) {
      throw new DomainError(
        'MIGRATION_SPECIFICATION_INVALID',
        'The migration specification could not be loaded.',
        500,
      );
    }
    return {
      ...publicMigrationSpecification(row),
      specification: specification.data,
    };
  }

  public async reviewMigrationSpecification(
    userId: string,
    input: ReviewMigrationSpecificationInput,
  ): Promise<PublicMigrationSpecificationReview> {
    const requestDigest = digestJson({
      specificationId: input.specificationId,
      expectedRevision: input.expectedRevision,
    });
    try {
      return await this.database.transaction().execute(async transaction => {
        await requirePlatformOperator(transaction, userId);
        const previous = await transaction
          .selectFrom('apiIdempotencyKeys')
          .select(['requestDigest', 'resultResourceId'])
          .where('actorId', '=', userId)
          .where('action', '=', 'migration_specification:review')
          .where('idempotencyKey', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (previous) {
          if (
            previous.requestDigest !== requestDigest ||
            previous.resultResourceId !== input.specificationId
          ) {
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              'The idempotency key was already used for another request.',
              409,
            );
          }
          return {
            specification: await loadMigrationSpecificationSummary(
              transaction,
              input.specificationId,
            ),
            matchedRepositories: await countOpenCandidates(
              transaction,
              input.specificationId,
            ),
            unmatchedRepositories: 0,
          };
        }

        const current = await transaction
          .selectFrom('migrationSpecifications')
          .select(['revision', 'trustState', 'specification', 'reviewedAt'])
          .where('id', '=', input.specificationId)
          .forUpdate()
          .executeTakeFirst();
        if (!current) {
          throw new DomainError(
            'MIGRATION_SPECIFICATION_NOT_FOUND',
            'The migration specification was not found.',
            404,
          );
        }
        if (current.revision !== input.expectedRevision) {
          throw new DomainError(
            'MIGRATION_SPECIFICATION_REVISION_CONFLICT',
            'The migration specification changed before it could be reviewed.',
            409,
          );
        }
        const parsed = migrationSpecificationSchema.safeParse(current.specification);
        if (!parsed.success) {
          throw new DomainError(
            'MIGRATION_SPECIFICATION_INVALID',
            'The migration specification could not be reviewed.',
            500,
          );
        }
        const now = new Date();
        const reviewedAt = current.reviewedAt ?? now;
        const reviewedSpecification: MigrationSpecification = {
          ...parsed.data,
          trust: {
            ...parsed.data.trust,
            status: 'reviewed',
            reviewedAt: reviewedAt.toISOString(),
          },
        };
        await sql`
          select promote_migration_specification(
            ${input.specificationId}::uuid,
            ${userId}::uuid,
            ${input.expectedRevision},
            ${JSON.stringify(reviewedSpecification)}::jsonb,
            ${reviewedAt}::timestamptz,
            ${input.requestId}::uuid
          )
        `.execute(transaction);
        const reconciliation = await reconcileCandidatesForSpecification(
          transaction,
          input.specificationId,
          now,
        );
        await transaction
          .insertInto('apiIdempotencyKeys')
          .values({
            actorId: userId,
            action: 'migration_specification:review',
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            resultResourceId: input.specificationId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          })
          .executeTakeFirstOrThrow();
        return {
          specification: await loadMigrationSpecificationSummary(
            transaction,
            input.specificationId,
          ),
          ...reconciliation,
        };
      });
    } catch (error) {
      if (error instanceof CandidateMatchingError) {
        throw new DomainError(
          error.safeCode,
          'Migration candidate matching could not be completed.',
          error.safeCode === 'SOURCE_COMPATIBILITY_INVALID' ? 409 : 503,
        );
      }
      throw error;
    }
  }

  public async listMigrationCandidates(
    userId: string,
    organisationId: string,
  ): Promise<PublicMigrationCandidate[]> {
    requireAction(await this.membership(organisationId, userId), 'repository:read');
    const rows = await this.database
      .selectFrom('migrationCandidates as candidate')
      .innerJoin(
        'repositories as repository',
        'repository.id',
        'candidate.repositoryId',
      )
      .innerJoin(
        'migrationSpecifications as specification',
        'specification.id',
        'candidate.migrationSpecificationId',
      )
      .innerJoin(
        'dependencyObservations as observation',
        'observation.id',
        'candidate.dependencyObservationId',
      )
      .select([
        'candidate.id',
        'candidate.repositoryId',
        'repository.fullName as repositoryFullName',
        'candidate.migrationSpecificationId',
        'observation.repositorySnapshotId',
        'observation.packageName',
        'observation.declaredRange',
        'observation.resolvedVersion',
        'specification.sourceCompatibility',
        'specification.targetVersion',
        'specification.trustState as specificationTrustState',
        'candidate.status',
        'candidate.firstDetectedAt',
        'candidate.lastDetectedAt',
        'candidate.version',
      ])
      .where('candidate.organisationId', '=', organisationId)
      .where('candidate.status', '=', 'open')
      .where('specification.trustState', 'in', ['reviewed', 'vendor_verified'])
      .orderBy('candidate.lastDetectedAt', 'desc')
      .limit(500)
      .execute();
    const reportRows =
      rows.length === 0
        ? []
        : await this.database
            .selectFrom('impactReports as report')
            .innerJoin(
              'repositorySnapshots as snapshot',
              'snapshot.id',
              'report.repositorySnapshotId',
            )
            .select([
              'report.id',
              'report.candidateId',
              'report.repositoryId',
              'report.repositorySnapshotId',
              'report.outcome',
              'report.affectedSummary',
              'report.riskCategory',
              'report.verificationAvailability',
              'report.uncertainty',
              'report.artifactDigest',
              'report.revision',
              'report.createdAt',
              'snapshot.commitSha',
              'snapshot.digest as snapshotDigest',
            ])
            .where(
              'report.candidateId',
              'in',
              rows.map(row => row.id),
            )
            .orderBy('report.candidateId')
            .orderBy('report.revision', 'desc')
            .execute();
    const currentSnapshots = new Map(
      rows.map(row => [row.id, row.repositorySnapshotId]),
    );
    const latestReports = new Map<string, PublicImpactReportSummary>();
    for (const report of reportRows) {
      if (!latestReports.has(report.candidateId)) {
        latestReports.set(
          report.candidateId,
          publicImpactReportSummary(
            publicImpactReport(
              report,
              currentSnapshots.get(report.candidateId) ?? report.repositorySnapshotId,
            ),
          ),
        );
      }
    }
    return rows.map(row => {
      if (row.specificationTrustState === 'draft') {
        throw new DomainError(
          'MIGRATION_CANDIDATE_TRUST_INVALID',
          'The migration candidate could not be loaded.',
          500,
        );
      }
      return {
        id: row.id,
        repositoryId: row.repositoryId,
        repositoryFullName: row.repositoryFullName,
        migrationSpecificationId: row.migrationSpecificationId,
        packageName: row.packageName,
        declaredRange: row.declaredRange,
        resolvedVersion: row.resolvedVersion,
        sourceCompatibility: row.sourceCompatibility,
        targetVersion: row.targetVersion,
        specificationTrustState: row.specificationTrustState,
        status: row.status,
        impact: latestReports.get(row.id) ?? null,
        firstDetectedAt: row.firstDetectedAt.toISOString(),
        lastDetectedAt: row.lastDetectedAt.toISOString(),
        version: row.version,
      };
    });
  }

  public async getMigrationCandidate(
    userId: string,
    organisationId: string,
    candidateId: string,
  ): Promise<PublicMigrationCandidateDetail> {
    requireAction(await this.membership(organisationId, userId), 'repository:read');
    const row = await this.database
      .selectFrom('migrationCandidates as candidate')
      .innerJoin(
        'repositories as repository',
        'repository.id',
        'candidate.repositoryId',
      )
      .innerJoin(
        'migrationSpecifications as specification',
        'specification.id',
        'candidate.migrationSpecificationId',
      )
      .innerJoin(
        'vendorReleases as release',
        'release.id',
        'specification.vendorReleaseId',
      )
      .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
      .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
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
      .select([
        'candidate.id',
        'candidate.repositoryId',
        'repository.fullName as repositoryFullName',
        'candidate.migrationSpecificationId',
        'candidate.status',
        'candidate.firstDetectedAt',
        'candidate.lastDetectedAt',
        'candidate.version',
        'observation.id as dependencyObservationId',
        'observation.packageName',
        'observation.dependencyKind',
        'observation.manifestPath',
        'observation.lockfilePath',
        'observation.declaredRange',
        'observation.resolvedVersion',
        'observation.discoveryMethod',
        'snapshot.id as repositorySnapshotId',
        'snapshot.commitSha',
        'snapshot.digest as snapshotDigest',
        'snapshot.createdAt as snapshotCreatedAt',
        'specification.vendorReleaseId',
        'specification.sourceCompatibility',
        'specification.targetVersion',
        'specification.trustState as specificationTrustState',
        'specification.revision as specificationRevision',
        'specification.evidenceDigest',
        'specification.reviewedAt',
        'specification.createdAt as specificationCreatedAt',
        'specification.specification',
        'vendor.name as vendorName',
        'product.canonicalIdentifier as productIdentifier',
      ])
      .where('candidate.organisationId', '=', organisationId)
      .where('candidate.id', '=', candidateId)
      .where('specification.trustState', 'in', ['reviewed', 'vendor_verified'])
      .executeTakeFirst();
    if (!row) {
      throw new DomainError(
        'MIGRATION_CANDIDATE_NOT_FOUND',
        'The migration candidate was not found.',
        404,
      );
    }
    if (row.specificationTrustState === 'draft') {
      throw new DomainError(
        'MIGRATION_CANDIDATE_TRUST_INVALID',
        'The migration candidate could not be loaded.',
        500,
      );
    }
    const specification = migrationSpecificationSchema.safeParse(row.specification);
    if (!specification.success) {
      throw new DomainError(
        'MIGRATION_SPECIFICATION_INVALID',
        'The migration specification could not be loaded.',
        500,
      );
    }
    const [evidenceRows, reportRow] = await Promise.all([
      this.database
        .selectFrom('vendorEvidenceItems as evidence')
        .innerJoin('vendorSources as source', 'source.id', 'evidence.vendorSourceId')
        .select([
          'source.sourceKey',
          'source.sourceKind',
          'evidence.canonicalUrl',
          'evidence.digest',
          'evidence.mediaType',
          'evidence.retrievedAt',
        ])
        .where('evidence.vendorReleaseId', '=', row.vendorReleaseId)
        .orderBy('source.sourceKey')
        .limit(100)
        .execute(),
      this.database
        .selectFrom('impactReports as report')
        .innerJoin(
          'repositorySnapshots as reportSnapshot',
          'reportSnapshot.id',
          'report.repositorySnapshotId',
        )
        .select([
          'report.id',
          'report.candidateId',
          'report.repositoryId',
          'report.repositorySnapshotId',
          'report.outcome',
          'report.affectedSummary',
          'report.riskCategory',
          'report.verificationAvailability',
          'report.uncertainty',
          'report.artifactDigest',
          'report.revision',
          'report.createdAt',
          'reportSnapshot.commitSha',
          'reportSnapshot.digest as snapshotDigest',
        ])
        .where('report.candidateId', '=', row.id)
        .orderBy('report.revision', 'desc')
        .executeTakeFirst(),
    ]);
    const impactReport = reportRow
      ? publicImpactReport(reportRow, row.repositorySnapshotId)
      : null;
    const candidate: PublicMigrationCandidate = {
      id: row.id,
      repositoryId: row.repositoryId,
      repositoryFullName: row.repositoryFullName,
      migrationSpecificationId: row.migrationSpecificationId,
      packageName: row.packageName,
      declaredRange: row.declaredRange,
      resolvedVersion: row.resolvedVersion,
      sourceCompatibility: row.sourceCompatibility,
      targetVersion: row.targetVersion,
      specificationTrustState: row.specificationTrustState,
      status: row.status,
      impact: impactReport ? publicImpactReportSummary(impactReport) : null,
      firstDetectedAt: row.firstDetectedAt.toISOString(),
      lastDetectedAt: row.lastDetectedAt.toISOString(),
      version: row.version,
    };
    return {
      candidate,
      repository: {
        id: row.repositoryId,
        fullName: row.repositoryFullName,
        commitSha: row.commitSha,
        snapshotDigest: row.snapshotDigest,
        snapshotCreatedAt: row.snapshotCreatedAt.toISOString(),
      },
      dependency: {
        id: row.dependencyObservationId,
        packageName: row.packageName,
        dependencyKind: row.dependencyKind,
        manifestPath: row.manifestPath,
        lockfilePath: row.lockfilePath,
        declaredRange: row.declaredRange,
        resolvedVersion: row.resolvedVersion,
        discoveryMethod: row.discoveryMethod,
      },
      specification: {
        id: row.migrationSpecificationId,
        vendorReleaseId: row.vendorReleaseId,
        vendorName: row.vendorName,
        productIdentifier: row.productIdentifier,
        sourceCompatibility: row.sourceCompatibility,
        targetVersion: row.targetVersion,
        trustState: row.specificationTrustState,
        revision: row.specificationRevision,
        evidenceDigest: row.evidenceDigest,
        reviewedAt: row.reviewedAt?.toISOString() ?? null,
        createdAt: row.specificationCreatedAt.toISOString(),
        specification: specification.data,
      },
      vendorEvidence: evidenceRows.map(evidence => ({
        ...evidence,
        retrievedAt: evidence.retrievedAt.toISOString(),
      })),
      impactReport,
    };
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

const migrationSpecificationSummarySelection = [
  'specification.id',
  'specification.vendorReleaseId',
  'vendor.name as vendorName',
  'product.canonicalIdentifier as productIdentifier',
  'specification.sourceCompatibility',
  'specification.targetVersion',
  'specification.trustState',
  'specification.revision',
  'specification.evidenceDigest',
  'specification.reviewedAt',
  'specification.createdAt',
] as const;

async function loadMigrationSpecificationSummary(
  database: AppDatabase | Transaction<Database>,
  specificationId: string,
): Promise<PublicMigrationSpecification> {
  const row = await database
    .selectFrom('migrationSpecifications as specification')
    .innerJoin(
      'vendorReleases as release',
      'release.id',
      'specification.vendorReleaseId',
    )
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
    .select(migrationSpecificationSummarySelection)
    .where('specification.id', '=', specificationId)
    .executeTakeFirstOrThrow();
  return publicMigrationSpecification(row);
}

function publicMigrationSpecification(row: {
  readonly id: string;
  readonly vendorReleaseId: string;
  readonly vendorName: string;
  readonly productIdentifier: string;
  readonly sourceCompatibility: string;
  readonly targetVersion: string;
  readonly trustState: PublicMigrationSpecification['trustState'];
  readonly revision: number;
  readonly evidenceDigest: string;
  readonly reviewedAt: Date | null;
  readonly createdAt: Date;
}): PublicMigrationSpecification {
  return {
    ...row,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function requirePlatformOperator(
  database: AppDatabase | Transaction<Database>,
  userId: string,
): Promise<void> {
  const result = await sql<{ isOperator: boolean }>`
    select is_platform_operator(${userId}::uuid) as "isOperator"
  `.execute(database);
  if (result.rows[0]?.isOperator !== true) {
    throw new DomainError(
      'PLATFORM_OPERATOR_REQUIRED',
      'Platform operator authorization is required.',
      403,
    );
  }
}

async function countOpenCandidates(
  database: AppDatabase | Transaction<Database>,
  specificationId: string,
): Promise<number> {
  const result = await database
    .selectFrom('migrationCandidates')
    .select(expression => expression.fn.countAll<string>().as('count'))
    .where('migrationSpecificationId', '=', specificationId)
    .where('status', '=', 'open')
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

interface AuditInput {
  readonly organisationId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly requestId: string;
}

export function validateInstallationLinkState(
  state: InstallationLinkStateRecord | undefined,
  userId: string,
  now: Date,
): InstallationLinkStateRecord {
  if (
    state?.userId !== userId ||
    state.consumedAt !== null ||
    state.expiresAt.getTime() <= now.getTime()
  ) {
    throw new DomainError(
      'GITHUB_INSTALLATION_STATE_INVALID',
      'The GitHub installation link is invalid or expired.',
      409,
    );
  }
  return state;
}

export function requireInstallationOrganisation(
  existingOrganisationId: string | undefined,
  requestedOrganisationId: string,
): void {
  if (
    existingOrganisationId !== undefined &&
    existingOrganisationId !== requestedOrganisationId
  ) {
    throw new DomainError(
      'GITHUB_INSTALLATION_ALREADY_LINKED',
      'The GitHub installation is already linked to another organisation.',
      409,
    );
  }
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

function publicRepositoryScan(scan: {
  readonly id: string;
  readonly organisationId: string;
  readonly repositoryId: string;
  readonly requestedCommit: string | null;
  readonly status: PublicRepositoryScan['status'];
  readonly safeErrorCode: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}): PublicRepositoryScan {
  return {
    ...scan,
    createdAt: scan.createdAt.toISOString(),
    startedAt: scan.startedAt?.toISOString() ?? null,
    completedAt: scan.completedAt?.toISOString() ?? null,
  };
}
