import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { sql, type Transaction } from 'kysely';

import {
  CandidateMatchingError,
  reconcileCandidatesForSpecification,
} from '@migration/candidate-matching';
import type { AppDatabase, Database } from '@migration/database';
import {
  impactReportSchema,
  migrationApprovalAuthoritySchema,
  migrationApprovalVerificationProfileSchema,
  migrationSpecificationSchema,
  migrationVerificationResultSchema,
} from '@migration/contracts';
import type {
  CreateMigrationApprovalRequest,
  GithubInstallationVerification,
  MigrationApprovalAuthority,
  MigrationSpecification,
  PackageSourceCandidateReviewRequest,
  PackageSourceCandidateReplacementRequest,
  PackageSourceMappingStateRequest,
  CandidateNotificationStateRequest,
  PublicCandidateNotification,
  PublicCandidateNotificationState,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationCandidateImpactReport,
  PublicMigrationApprovalPreview,
  PublicMigrationApprovalResult,
  PublicImpactAnalysisRequest,
  PublicMigrationPatchAttempt,
  PublicMigrationRunDetail,
  PublicMigrationRunSummary,
  PublicPublicationNotification,
  PublicImpactReportSummary,
  PublicMigrationSpecification,
  PublicMigrationSpecificationDetail,
  PublicMigrationSpecificationReview,
  PublicPackageSourceCandidateReview,
  PublicPackageSourceCatalogEntry,
  PublicPackageSourceMapping,
  PublicPackageSourceVendor,
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

export interface RequestImpactAnalysisInput {
  readonly organisationId: string;
  readonly candidateId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface ReviewMigrationSpecificationInput {
  readonly specificationId: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export type ReviewPackageSourceCandidateInput = PackageSourceCandidateReviewRequest & {
  readonly candidateId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
};

export type ReplacePackageSourceCandidateInput =
  PackageSourceCandidateReplacementRequest & {
    readonly candidateId: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  };

export type SetPackageSourceMappingStateInput = PackageSourceMappingStateRequest & {
  readonly mappingId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
};

export type UpdateCandidateNotificationStateInput =
  CandidateNotificationStateRequest & {
    readonly organisationId: string;
    readonly notificationId: string;
    readonly requestId: string;
  };

export interface CreateMigrationApprovalInput extends CreateMigrationApprovalRequest {
  readonly organisationId: string;
  readonly candidateId: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface CancelMigrationRunInput {
  readonly organisationId: string;
  readonly migrationRunId: string;
  readonly expectedVersion: number;
  readonly reasonCode: 'USER_REQUESTED';
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface RevokeMigrationApprovalInput {
  readonly organisationId: string;
  readonly migrationRunId: string;
  readonly expectedVersion: number;
  readonly reasonCode: 'USER_REQUESTED';
  readonly idempotencyKey: string;
  readonly requestId: string;
}

export interface PatchReviewArtifactRecord {
  readonly objectKey: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface MigrationPatchReviewRecord {
  readonly organisationId: string;
  readonly migrationRunId: string;
  readonly baseCommitSha: string;
  readonly patchPolicy: unknown;
  readonly specification: unknown;
  readonly selectedAttemptId: string;
  readonly attemptNumber: number;
  readonly policyVersion: string;
  readonly policyDigest: string;
  readonly plan: PatchReviewArtifactRecord;
  readonly patch: PatchReviewArtifactRecord;
  readonly manifest: PatchReviewArtifactRecord;
  readonly validation: PatchReviewArtifactRecord;
  readonly attempts: readonly PublicMigrationPatchAttempt[];
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
  hasPlatformOperatorAccess(userId: string): Promise<boolean>;
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
  requestImpactAnalysis(
    userId: string,
    input: RequestImpactAnalysisInput,
  ): Promise<PublicImpactAnalysisRequest>;
  createGithubInstallLink(
    userId: string,
    organisationId: string,
  ): Promise<InstallationLinkRecord>;
  validateGithubInstallState(userId: string, state: string): Promise<void>;
  completeGithubInstallation(
    userId: string,
    input: CompleteGithubInstallationInput,
  ): Promise<CompletedGithubInstallation>;
  listPackageSourceMappings(
    userId: string,
    status: 'needs_review' | 'mapped' | 'rejected' | 'disabled',
  ): Promise<PublicPackageSourceMapping[]>;
  listPackageSourceCatalog(userId: string): Promise<{
    readonly products: readonly PublicPackageSourceCatalogEntry[];
    readonly vendors: readonly PublicPackageSourceVendor[];
  }>;
  reviewPackageSourceCandidate(
    userId: string,
    input: ReviewPackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview>;
  replacePackageSourceCandidate(
    userId: string,
    input: ReplacePackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview>;
  setPackageSourceMappingState(
    userId: string,
    input: SetPackageSourceMappingStateInput,
  ): Promise<PublicPackageSourceCandidateReview>;
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
  createMigrationApproval(
    userId: string,
    input: CreateMigrationApprovalInput,
  ): Promise<PublicMigrationApprovalResult>;
  getMigrationRun(
    userId: string,
    organisationId: string,
    migrationRunId: string,
  ): Promise<PublicMigrationRunDetail>;
  getMigrationPatchReview(
    userId: string,
    organisationId: string,
    migrationRunId: string,
  ): Promise<MigrationPatchReviewRecord | null>;
  listMigrationRuns(
    userId: string,
    organisationId: string,
  ): Promise<PublicMigrationRunSummary[]>;
  listPublicationNotifications(
    userId: string,
    organisationId: string,
  ): Promise<PublicPublicationNotification[]>;
  listCandidateNotifications(
    userId: string,
    organisationId: string,
  ): Promise<PublicCandidateNotification[]>;
  updateCandidateNotificationState(
    userId: string,
    input: UpdateCandidateNotificationStateInput,
  ): Promise<PublicCandidateNotificationState>;
  cancelMigrationRun(
    userId: string,
    input: CancelMigrationRunInput,
  ): Promise<PublicMigrationRunDetail>;
  revokeMigrationApproval(
    userId: string,
    input: RevokeMigrationApprovalInput,
  ): Promise<PublicMigrationRunDetail>;
}

function digestJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const APPROVAL_POLICY_VERSIONS = {
  agentPolicyVersion: 'migration-agent-1.0',
  toolRegistryVersion: 'migration-tools-1.0',
  patchPolicyVersion: 'typescript-bounded-1.0',
  verificationPolicyVersion: 'typescript-default-1.0',
  publicationPolicyVersion: 'draft-pr-1.0',
  openaiProcessingPolicyVersion: 'default-controls-1.0',
} as const;

interface ApprovalPreviewContext {
  readonly role: OrganisationRole;
  readonly candidateStatus: 'open' | 'dismissed' | 'superseded' | 'resolved';
  readonly repositoryMutable: boolean;
  readonly manifestPath: string;
  readonly lockfilePath: string | null;
  readonly impactReport: PublicMigrationCandidateImpactReport | null;
}

export function createMigrationApprovalPreview(
  context: ApprovalPreviewContext,
): PublicMigrationApprovalPreview {
  const reportPaths = context.impactReport?.affectedFiles.map(file => file.path) ?? [];
  const requestedPaths = [
    context.manifestPath,
    ...(context.lockfilePath ? [context.lockfilePath] : []),
    ...reportPaths,
  ];
  const allPaths = [...new Set(requestedPaths)].sort();
  const allowedPaths = allPaths.slice(0, 500);
  const categories = new Set<
    MigrationApprovalAuthority['patchPolicy']['allowedChangeCategories'][number]
  >(['dependency_manifest']);
  if (context.lockfilePath) categories.add('lockfile');
  for (const file of context.impactReport?.affectedFiles ?? []) {
    categories.add(file.classification);
  }
  const reportedProfiles = new Map(
    context.impactReport?.verification.profiles.map(profile => [
      profile.profile,
      profile.availability,
    ]) ?? [],
  );
  const verificationProfile: MigrationApprovalAuthority['verificationProfile'] = {
    schemaVersion: '1.0',
    profiles: (['typescript_static', 'typescript_unit'] as const).map(profile => {
      const availability = reportedProfiles.get(profile) ?? 'unavailable';
      return {
        profile,
        availability,
        commandIds:
          availability === 'available'
            ? [profile === 'typescript_static' ? 'npm.typecheck' : 'npm.test']
            : [],
      };
    }),
  };
  const authority = migrationApprovalAuthoritySchema.parse({
    schemaVersion: '1.0',
    approvalContractVersion: '1.0',
    ...APPROVAL_POLICY_VERSIONS,
    patchPolicy: {
      schemaVersion: '1.0',
      allowedPaths,
      allowedChangeCategories: [...categories].sort(),
      maxChangedFiles: Math.max(1, allowedPaths.length),
      maxPatchBytes: 262_144,
      maxAddedLines: 1_000,
      maxDeletedLines: 500,
    },
    verificationProfile,
    openaiProcessingMode: 'default_controls',
  });
  const blockers: string[] = [];
  if (context.role === 'viewer') blockers.push('APPROVAL_ROLE_REQUIRED');
  if (context.candidateStatus !== 'open') blockers.push('CANDIDATE_NOT_OPEN');
  if (!context.repositoryMutable) blockers.push('REPOSITORY_NOT_MUTABLE');
  if (context.impactReport?.freshness !== 'current') {
    blockers.push('CURRENT_IMPACT_REPORT_REQUIRED');
  } else if (context.impactReport.outcome !== 'affected') {
    blockers.push('AFFECTED_USAGE_REQUIRED');
  }
  if (allPaths.length > 500) blockers.push('PATCH_SCOPE_TOO_LARGE');

  const renderedCopy = [
    'You authorize Migration API to process the exact repository snapshot shown above with OpenAI.',
    `A future migration agent may propose changes only within ${String(allowedPaths.length)} listed path${allowedPaths.length === 1 ? '' : 's'} and the displayed patch limits.`,
    'A future isolated verifier may execute only the named verification profiles and command identifiers shown here.',
    'A later publication stage may create a draft pull request, but Migration API cannot merge it.',
    'Human review remains required before any proposed change is accepted.',
  ].join('\n');
  return {
    eligible: blockers.length === 0,
    blockers,
    renderedCopy,
    renderedCopyDigest: createHash('sha256').update(renderedCopy).digest('hex'),
    authority,
  };
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

  public async hasPlatformOperatorAccess(userId: string): Promise<boolean> {
    const result = await sql<{ isOperator: boolean }>`
      select is_platform_operator(${userId}::uuid) as "isOperator"
    `.execute(this.database);
    return result.rows[0]?.isOperator === true;
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

  public async requestImpactAnalysis(
    userId: string,
    input: RequestImpactAnalysisInput,
  ): Promise<PublicImpactAnalysisRequest> {
    const requestDigest = digestJson({
      organisationId: input.organisationId,
      candidateId: input.candidateId,
    });
    return this.database.transaction().execute(async transaction => {
      requireAction(
        await this.membership(input.organisationId, userId, transaction),
        'repository:scan',
      );
      const candidate = await transaction
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
        .innerJoin(
          'repositories as repository',
          'repository.id',
          'candidate.repositoryId',
        )
        .innerJoin(
          'githubInstallations as installation',
          'installation.id',
          'repository.installationId',
        )
        .select([
          'candidate.id',
          'candidate.status',
          'candidate.migrationSpecificationId',
          'snapshot.id as repositorySnapshotId',
          'snapshot.digest as snapshotDigest',
          'snapshot.status as snapshotStatus',
          'snapshot.expiresAt',
          'specification.trustState',
          'repository.selected',
          'repository.enabled',
          'repository.archived',
          'installation.status as installationStatus',
        ])
        .where('candidate.id', '=', input.candidateId)
        .where('candidate.organisationId', '=', input.organisationId)
        .executeTakeFirst();
      if (!candidate) {
        throw new DomainError(
          'MIGRATION_CANDIDATE_NOT_FOUND',
          'The migration candidate was not found.',
          404,
        );
      }
      if (
        candidate.status !== 'open' ||
        !['reviewed', 'vendor_verified'].includes(candidate.trustState) ||
        candidate.snapshotStatus !== 'available' ||
        candidate.expiresAt <= new Date() ||
        !isRepositoryScannable(candidate)
      ) {
        throw new DomainError(
          'IMPACT_ANALYSIS_NOT_AVAILABLE',
          'Impact analysis is not available for the current candidate.',
          409,
        );
      }

      const previous = await transaction
        .selectFrom('apiIdempotencyKeys')
        .select(['requestDigest', 'resultResourceId'])
        .where('actorId', '=', userId)
        .where('action', '=', 'impact_analysis:request')
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
        return {
          candidateId: input.candidateId,
          correlationId: previous.resultResourceId,
          status: 'queued',
        };
      }

      const active = await transaction
        .selectFrom('impactAnalysisRuns')
        .select('id')
        .where('candidateId', '=', input.candidateId)
        .where('repositorySnapshotId', '=', candidate.repositorySnapshotId)
        .where('migrationSpecificationId', '=', candidate.migrationSpecificationId)
        .where('snapshotDigest', '=', candidate.snapshotDigest)
        .where('status', '=', 'running')
        .executeTakeFirst();
      if (active) {
        throw new DomainError(
          'IMPACT_ANALYSIS_IN_PROGRESS',
          'Impact analysis is already in progress.',
          409,
        );
      }

      const correlationId = randomUUID();
      const now = new Date();
      await transaction
        .insertInto('apiIdempotencyKeys')
        .values({
          actorId: userId,
          action: 'impact_analysis:request',
          idempotencyKey: input.idempotencyKey,
          requestDigest,
          resultResourceId: correlationId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        })
        .executeTakeFirstOrThrow();
      await writeAudit(transaction, {
        organisationId: input.organisationId,
        actorId: userId,
        action: 'impact_analysis.requested',
        resourceType: 'migration_candidate',
        resourceId: input.candidateId,
        requestId: input.requestId,
      });
      return {
        candidateId: input.candidateId,
        correlationId,
        status: 'queued',
      };
    });
  }

  public async listPackageSourceMappings(
    userId: string,
    status: 'needs_review' | 'mapped' | 'rejected' | 'disabled',
  ): Promise<PublicPackageSourceMapping[]> {
    await requirePlatformOperator(this.database, userId);
    return loadPackageSourceMappings(this.database, status);
  }

  public async listPackageSourceCatalog(userId: string): Promise<{
    readonly products: readonly PublicPackageSourceCatalogEntry[];
    readonly vendors: readonly PublicPackageSourceVendor[];
  }> {
    await requirePlatformOperator(this.database, userId);
    const vendors = await this.database
      .selectFrom('vendors')
      .select([
        'id as vendorId',
        'slug as vendorSlug',
        'name as vendorName',
        'trustState as vendorTrustState',
        'officialDomains',
      ])
      .where('synthetic', '=', false)
      .orderBy('name', 'asc')
      .limit(500)
      .execute();
    const products = await this.database
      .selectFrom('apiProducts as product')
      .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
      .select([
        'product.id as apiProductId',
        'product.canonicalIdentifier as packageName',
        'product.status as productStatus',
        'vendor.id as vendorId',
        'vendor.slug as vendorSlug',
        'vendor.name as vendorName',
        'vendor.trustState as vendorTrustState',
        'vendor.officialDomains',
      ])
      .orderBy('product.canonicalIdentifier', 'asc')
      .limit(500)
      .execute();
    return { products, vendors };
  }

  public async reviewPackageSourceCandidate(
    userId: string,
    input: ReviewPackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    let failureStage: PackageSourceReviewFailureStage = 'operator_check';
    const requestDigest = digestJson(
      input.decision === 'approve'
        ? {
            candidateId: input.candidateId,
            decision: input.decision,
            expectedCandidateVersion: input.expectedCandidateVersion,
            expectedMappingVersion: input.expectedMappingVersion,
            pollIntervalSeconds: input.pollIntervalSeconds,
          }
        : {
            candidateId: input.candidateId,
            decision: input.decision,
            expectedCandidateVersion: input.expectedCandidateVersion,
            expectedMappingVersion: input.expectedMappingVersion,
            rejectionReasonCode: input.rejectionReasonCode,
          },
    );
    try {
      return await this.database.transaction().execute(async transaction => {
        failureStage = 'operator_check';
        await requirePlatformOperator(transaction, userId);
        failureStage = 'idempotency_lookup';
        const previous = await transaction
          .selectFrom('apiIdempotencyKeys')
          .select(['requestDigest', 'resultResourceId'])
          .where('actorId', '=', userId)
          .where('action', '=', 'package_source_candidate:review')
          .where('idempotencyKey', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (previous) {
          if (
            previous.requestDigest !== requestDigest ||
            previous.resultResourceId !== input.candidateId
          ) {
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              'The idempotency key was already used for another request.',
              409,
            );
          }
          return {
            mapping: await loadPackageSourceMappingByCandidate(
              transaction,
              input.candidateId,
            ),
          };
        }

        failureStage = 'candidate_load';
        const current = await transaction
          .selectFrom('packageSourceCandidates as candidate')
          .innerJoin(
            'packageSourceMappings as mapping',
            'mapping.id',
            'candidate.mappingId',
          )
          .select([
            'candidate.reviewState',
            'candidate.sourceKind',
            'candidate.version as candidateVersion',
            'mapping.version as mappingVersion',
          ])
          .where('candidate.id', '=', input.candidateId)
          .executeTakeFirst();
        if (!current) {
          throw new DomainError(
            'PACKAGE_SOURCE_CANDIDATE_NOT_FOUND',
            'The package source candidate was not found.',
            404,
          );
        }
        if (
          current.candidateVersion !== input.expectedCandidateVersion ||
          current.mappingVersion !== input.expectedMappingVersion
        ) {
          throw new DomainError(
            'PACKAGE_SOURCE_REVIEW_CONFLICT',
            'The package source evidence changed before it could be reviewed.',
            409,
          );
        }
        if (current.reviewState !== 'pending_review') {
          throw new DomainError(
            'PACKAGE_SOURCE_ALREADY_REVIEWED',
            'The package source candidate has already been reviewed.',
            409,
          );
        }
        if (
          input.decision === 'approve' &&
          current.sourceKind !== 'package_registry_release' &&
          current.sourceKind !== 'sdk_repository_release' &&
          current.sourceKind !== 'changelog' &&
          current.sourceKind !== 'release_feed' &&
          current.sourceKind !== 'migration_guide'
        ) {
          throw new DomainError(
            'PACKAGE_SOURCE_NOT_PROMOTABLE',
            'This candidate type cannot be promoted to the trusted source catalog.',
            409,
          );
        }

        failureStage = 'approval_function';
        await sql`
          select review_exact_package_source_candidate(
            ${input.candidateId}::uuid,
            ${userId}::uuid,
            ${input.expectedCandidateVersion},
            ${input.expectedMappingVersion},
            ${input.decision},
            ${input.decision === 'approve' ? input.pollIntervalSeconds : null},
            ${input.decision === 'reject' ? input.rejectionReasonCode : null},
            ${input.requestId}::uuid
          )
        `.execute(transaction);
        failureStage = 'idempotency_write';
        const now = new Date();
        await transaction
          .insertInto('apiIdempotencyKeys')
          .values({
            actorId: userId,
            action: 'package_source_candidate:review',
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            resultResourceId: input.candidateId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          })
          .executeTakeFirstOrThrow();
        failureStage = 'result_reload';
        return {
          mapping: await loadPackageSourceMappingByCandidate(
            transaction,
            input.candidateId,
          ),
        };
      });
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === '40001') {
        throw new DomainError(
          'PACKAGE_SOURCE_REVIEW_CONFLICT',
          'The package source evidence changed before it could be reviewed.',
          409,
        );
      }
      if (code === '23514' || code === '23505') {
        throw new DomainError(
          'PACKAGE_SOURCE_CATALOG_CONFLICT',
          'The candidate conflicts with the trusted source catalog.',
          409,
        );
      }
      if (
        code === '42501' &&
        [
          'platform operator required',
          'platform operator authorization required',
        ].includes(postgresErrorMessage(error) ?? '')
      ) {
        throw new DomainError(
          'PLATFORM_OPERATOR_REQUIRED',
          'Platform operator authorization is required.',
          403,
        );
      }
      if (code === '42501') {
        throw new DomainError(
          packageSourceReviewPermissionCode(failureStage),
          'The package source review encountered an internal database authorization error.',
          500,
        );
      }
      throw error;
    }
  }

  public async replacePackageSourceCandidate(
    userId: string,
    input: ReplacePackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    const replacement = canonicalPackageSourceUrl(input.canonicalUrl);
    const requestDigest = digestJson({
      candidateId: input.candidateId,
      expectedCandidateVersion: input.expectedCandidateVersion,
      expectedMappingVersion: input.expectedMappingVersion,
      sourceKind: input.sourceKind,
      canonicalUrl: replacement.url,
      proposalNote: input.proposalNote,
    });
    try {
      return await this.database.transaction().execute(async transaction => {
        await requirePlatformOperator(transaction, userId);
        const previous = await transaction
          .selectFrom('apiIdempotencyKeys')
          .select(['requestDigest', 'resultResourceId'])
          .where('actorId', '=', userId)
          .where('action', '=', 'package_source_candidate:replace')
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
          return {
            mapping: await loadPackageSourceMappingByCandidate(
              transaction,
              previous.resultResourceId,
            ),
          };
        }
        const result = await sql<{ candidateId: string }>`
          select replace_package_source_candidate(
            ${input.candidateId}::uuid,
            ${userId}::uuid,
            ${input.expectedCandidateVersion},
            ${input.expectedMappingVersion},
            ${input.sourceKind},
            ${replacement.url},
            ${replacement.domain},
            ${input.proposalNote},
            ${input.requestId}::uuid
          ) as "candidateId"
        `.execute(transaction);
        const candidateId = result.rows[0]?.candidateId;
        if (!candidateId) {
          throw new DomainError(
            'PACKAGE_SOURCE_REPLACEMENT_FAILED',
            'The replacement candidate could not be created.',
            500,
          );
        }
        const now = new Date();
        await transaction
          .insertInto('apiIdempotencyKeys')
          .values({
            actorId: userId,
            action: 'package_source_candidate:replace',
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            resultResourceId: candidateId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          })
          .executeTakeFirstOrThrow();
        return {
          mapping: await loadPackageSourceMappingByCandidate(transaction, candidateId),
        };
      });
    } catch (error) {
      throwPackageSourceMutationError(error, 'replacement');
    }
  }

  public async setPackageSourceMappingState(
    userId: string,
    input: SetPackageSourceMappingStateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    const requestDigest = digestJson({
      mappingId: input.mappingId,
      action: input.action,
      expectedMappingVersion: input.expectedMappingVersion,
      disabledReasonCode:
        input.action === 'disable' ? input.disabledReasonCode : undefined,
    });
    try {
      return await this.database.transaction().execute(async transaction => {
        await requirePlatformOperator(transaction, userId);
        const previous = await transaction
          .selectFrom('apiIdempotencyKeys')
          .select(['requestDigest', 'resultResourceId'])
          .where('actorId', '=', userId)
          .where('action', '=', 'package_source_mapping:state')
          .where('idempotencyKey', '=', input.idempotencyKey)
          .executeTakeFirst();
        if (previous) {
          if (
            previous.requestDigest !== requestDigest ||
            previous.resultResourceId !== input.mappingId
          ) {
            throw new DomainError(
              'IDEMPOTENCY_CONFLICT',
              'The idempotency key was already used for another request.',
              409,
            );
          }
          return {
            mapping: await loadPackageSourceMappingById(transaction, input.mappingId),
          };
        }
        await sql`
          select set_package_source_mapping_enabled(
            ${input.mappingId}::uuid,
            ${userId}::uuid,
            ${input.expectedMappingVersion},
            ${input.action === 'enable'},
            ${input.action === 'disable' ? input.disabledReasonCode : null},
            ${input.requestId}::uuid
          )
        `.execute(transaction);
        const now = new Date();
        await transaction
          .insertInto('apiIdempotencyKeys')
          .values({
            actorId: userId,
            action: 'package_source_mapping:state',
            idempotencyKey: input.idempotencyKey,
            requestDigest,
            resultResourceId: input.mappingId,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          })
          .executeTakeFirstOrThrow();
        return {
          mapping: await loadPackageSourceMappingById(transaction, input.mappingId),
        };
      });
    } catch (error) {
      throwPackageSourceMutationError(error, 'state change');
    }
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
        if (parsed.data.changes.some(change => change.certainty === 'ambiguous')) {
          throw new DomainError(
            'MIGRATION_SPECIFICATION_AMBIGUOUS',
            'Resolve every ambiguous change before reviewing the migration specification.',
            409,
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
    const membership = requireAction(
      await this.membership(organisationId, userId),
      'repository:read',
    );
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
        'githubInstallations as installation',
        'installation.id',
        'repository.installationId',
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
        'repository.selected as repositorySelected',
        'repository.enabled as repositoryEnabled',
        'repository.archived as repositoryArchived',
        'installation.status as installationStatus',
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
    const [evidenceRows, reportRow, impactAnalysisRun] = await Promise.all([
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
      this.database
        .selectFrom('impactAnalysisRuns')
        .select([
          'correlationId',
          'status',
          'safeErrorCode',
          'attempt',
          'startedAt',
          'completedAt',
        ])
        .where('candidateId', '=', row.id)
        .where('repositorySnapshotId', '=', row.repositorySnapshotId)
        .where('migrationSpecificationId', '=', row.migrationSpecificationId)
        .where('snapshotDigest', '=', row.snapshotDigest)
        .orderBy('updatedAt', 'desc')
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
    const detail = {
      candidate,
      repository: {
        id: row.repositoryId,
        fullName: row.repositoryFullName,
        snapshotId: row.repositorySnapshotId,
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
      impactAnalysis: impactAnalysisRun
        ? {
            ...impactAnalysisRun,
            startedAt: impactAnalysisRun.startedAt.toISOString(),
            completedAt: impactAnalysisRun.completedAt?.toISOString() ?? null,
          }
        : null,
    };
    return {
      ...detail,
      approval: createMigrationApprovalPreview({
        role: membership.role,
        candidateStatus: candidate.status,
        repositoryMutable:
          row.repositorySelected &&
          row.repositoryEnabled &&
          !row.repositoryArchived &&
          row.installationStatus === 'active',
        manifestPath: row.manifestPath,
        lockfilePath: row.lockfilePath,
        impactReport,
      }),
    };
  }

  public async createMigrationApproval(
    userId: string,
    input: CreateMigrationApprovalInput,
  ): Promise<PublicMigrationApprovalResult> {
    const requestDigest = digestJson({
      organisationId: input.organisationId,
      candidateId: input.candidateId,
      expectedCandidateVersion: input.expectedCandidateVersion,
      expectedRepositorySnapshotId: input.expectedRepositorySnapshotId,
      expectedBaseCommitSha: input.expectedBaseCommitSha,
      expectedSnapshotDigest: input.expectedSnapshotDigest,
      expectedSpecificationRevision: input.expectedSpecificationRevision,
      expectedSpecificationDigest: input.expectedSpecificationDigest,
      expectedImpactReportId: input.expectedImpactReportId,
      expectedImpactReportRevision: input.expectedImpactReportRevision,
      expectedImpactReportDigest: input.expectedImpactReportDigest,
      renderedCopyDigest: input.renderedCopyDigest,
      acknowledgements: input.acknowledgements,
    });
    try {
      return await this.database.transaction().execute(async transaction => {
        const membership = requireAction(
          await this.membership(input.organisationId, userId, transaction),
          'migration:approve',
        );
        if (membership.role === 'viewer') {
          throw new DomainError(
            'AUTHORIZATION_DENIED',
            'The actor is not authorized for this action.',
            403,
          );
        }
        const previous = await loadIdempotentMigrationApproval(
          transaction,
          userId,
          input,
          requestDigest,
        );
        if (previous) return previous;

        const candidate = await transaction
          .selectFrom('migrationCandidates')
          .selectAll()
          .where('id', '=', input.candidateId)
          .where('organisationId', '=', input.organisationId)
          .forUpdate()
          .executeTakeFirst();
        if (!candidate) {
          throw new DomainError(
            'MIGRATION_CANDIDATE_NOT_FOUND',
            'The migration candidate was not found.',
            404,
          );
        }
        const concurrentPrevious = await loadIdempotentMigrationApproval(
          transaction,
          userId,
          input,
          requestDigest,
        );
        if (concurrentPrevious) return concurrentPrevious;

        const activeRun = await transaction
          .selectFrom('migrationRuns')
          .select('id')
          .where('organisationId', '=', input.organisationId)
          .where('candidateId', '=', input.candidateId)
          .where('status', 'in', ['queued', 'running'])
          .executeTakeFirst();
        if (activeRun) {
          throw new DomainError(
            'MIGRATION_ALREADY_ACTIVE',
            'This migration already has an active run.',
            409,
          );
        }

        const repository = await transaction
          .selectFrom('repositories as repository')
          .innerJoin(
            'githubInstallations as installation',
            'installation.id',
            'repository.installationId',
          )
          .select([
            'repository.id',
            'repository.installationId',
            'repository.githubRepositoryId',
            'repository.defaultBranch',
            'repository.selected',
            'repository.enabled',
            'repository.archived',
            'installation.status as installationStatus',
          ])
          .where('repository.id', '=', candidate.repositoryId)
          .where('repository.organisationId', '=', input.organisationId)
          .executeTakeFirst();
        const observation = await transaction
          .selectFrom('dependencyObservations as observation')
          .innerJoin(
            'repositorySnapshots as snapshot',
            'snapshot.id',
            'observation.repositorySnapshotId',
          )
          .select([
            'observation.manifestPath',
            'observation.lockfilePath',
            'snapshot.id as snapshotId',
            'snapshot.commitSha',
            'snapshot.digest as snapshotDigest',
            'snapshot.status as snapshotStatus',
            'snapshot.expiresAt',
          ])
          .where('observation.id', '=', candidate.dependencyObservationId)
          .where('observation.organisationId', '=', input.organisationId)
          .where('snapshot.repositoryId', '=', candidate.repositoryId)
          .executeTakeFirst();
        const specification = await transaction
          .selectFrom('migrationSpecifications')
          .select(['id', 'trustState', 'revision', 'evidenceDigest'])
          .where('id', '=', candidate.migrationSpecificationId)
          .executeTakeFirst();
        const reportRow = await transaction
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
          .where('report.candidateId', '=', candidate.id)
          .orderBy('report.revision', 'desc')
          .executeTakeFirst();
        if (!repository || !observation || !specification || !reportRow) {
          throw new DomainError(
            'MIGRATION_APPROVAL_STALE',
            'The migration evidence changed or is no longer available.',
            409,
          );
        }
        if (
          specification.trustState === 'draft' ||
          observation.snapshotStatus !== 'available' ||
          observation.expiresAt.getTime() <= Date.now()
        ) {
          throw new DomainError(
            'MIGRATION_APPROVAL_STALE',
            'The migration evidence changed or is no longer available.',
            409,
          );
        }
        const impactReport = publicImpactReport(reportRow, observation.snapshotId);
        const preview = createMigrationApprovalPreview({
          role: membership.role,
          candidateStatus: candidate.status,
          repositoryMutable:
            repository.selected &&
            repository.enabled &&
            !repository.archived &&
            repository.installationStatus === 'active',
          manifestPath: observation.manifestPath,
          lockfilePath: observation.lockfilePath,
          impactReport,
        });
        if (!preview.eligible) {
          throw new DomainError(
            'MIGRATION_APPROVAL_NOT_ALLOWED',
            'This migration is not currently eligible for approval.',
            409,
          );
        }
        if (
          candidate.version !== input.expectedCandidateVersion ||
          observation.snapshotId !== input.expectedRepositorySnapshotId ||
          observation.commitSha !== input.expectedBaseCommitSha ||
          observation.snapshotDigest !== input.expectedSnapshotDigest ||
          specification.revision !== input.expectedSpecificationRevision ||
          specification.evidenceDigest !== input.expectedSpecificationDigest ||
          reportRow.id !== input.expectedImpactReportId ||
          reportRow.revision !== input.expectedImpactReportRevision ||
          reportRow.artifactDigest !== input.expectedImpactReportDigest ||
          preview.renderedCopyDigest !== input.renderedCopyDigest
        ) {
          throw new DomainError(
            'MIGRATION_APPROVAL_STALE',
            'The migration evidence changed before it could be approved.',
            409,
          );
        }

        return persistMigrationApproval(transaction, {
          userId,
          role: membership.role,
          input,
          requestDigest,
          preview,
          candidateId: candidate.id,
          repositoryId: candidate.repositoryId,
          githubRepositoryId: repository.githubRepositoryId,
          installationId: repository.installationId,
          baseBranch: repository.defaultBranch,
          snapshotId: observation.snapshotId,
          commitSha: observation.commitSha,
          snapshotDigest: observation.snapshotDigest,
          specificationId: specification.id,
          specificationRevision: specification.revision,
          specificationDigest: specification.evidenceDigest,
          impactReportId: reportRow.id,
          impactReportRevision: reportRow.revision,
          impactReportDigest: reportRow.artifactDigest,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          'MIGRATION_APPROVAL_CONFLICT',
          'This migration was approved concurrently or the idempotency key was reused.',
          409,
        );
      }
      throw error;
    }
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

  public async getMigrationRun(
    userId: string,
    organisationId: string,
    migrationRunId: string,
  ): Promise<PublicMigrationRunDetail> {
    requireAction(await this.membership(organisationId, userId), 'migration:read');
    return loadMigrationRun(this.database, organisationId, migrationRunId);
  }

  public async getMigrationPatchReview(
    userId: string,
    organisationId: string,
    migrationRunId: string,
  ): Promise<MigrationPatchReviewRecord | null> {
    requireAction(await this.membership(organisationId, userId), 'migration:read');
    return loadMigrationPatchReview(this.database, organisationId, migrationRunId);
  }

  public async listMigrationRuns(
    userId: string,
    organisationId: string,
  ): Promise<PublicMigrationRunSummary[]> {
    requireAction(await this.membership(organisationId, userId), 'migration:read');
    return loadMigrationRuns(this.database, organisationId);
  }

  public async listPublicationNotifications(
    userId: string,
    organisationId: string,
  ): Promise<PublicPublicationNotification[]> {
    requireAction(await this.membership(organisationId, userId), 'migration:read');
    const notifications = await this.database
      .selectFrom('publicationNotificationOutbox as notification')
      .innerJoin('githubPublications as publication', join =>
        join
          .onRef('publication.id', '=', 'notification.publicationId')
          .onRef('publication.organisationId', '=', 'notification.organisationId'),
      )
      .innerJoin('repositories as repository', join =>
        join
          .onRef('repository.id', '=', 'publication.repositoryId')
          .onRef('repository.organisationId', '=', 'publication.organisationId'),
      )
      .select([
        'notification.id',
        'notification.migrationRunId',
        'notification.deliveredAt',
        'repository.fullName as repositoryFullName',
        'publication.pullRequestNumber',
        'publication.pullRequestUrl',
        'publication.state as pullRequestState',
        'publication.isDraft',
      ])
      .where('notification.organisationId', '=', organisationId)
      .where('notification.recipientUserId', '=', userId)
      .where('notification.channel', '=', 'in_app')
      .where('notification.deliveredAt', 'is not', null)
      .orderBy('notification.deliveredAt', 'desc')
      .limit(20)
      .execute();
    return notifications.map(notification => {
      if (notification.deliveredAt === null) {
        throw new Error('A listed publication notification is not delivered.');
      }
      return {
        id: notification.id,
        migrationRunId: notification.migrationRunId,
        repositoryFullName: notification.repositoryFullName,
        pullRequestNumber: notification.pullRequestNumber,
        pullRequestUrl: notification.pullRequestUrl,
        pullRequestState: notification.pullRequestState,
        isDraft: notification.isDraft,
        deliveredAt: notification.deliveredAt.toISOString(),
      };
    });
  }

  public async listCandidateNotifications(
    userId: string,
    organisationId: string,
  ): Promise<PublicCandidateNotification[]> {
    await this.requireCandidateNotificationRecipient(organisationId, userId);
    const notifications = await this.database
      .selectFrom('notificationRecipientStates as recipientState')
      .innerJoin(
        'organisationNotifications as notification',
        'notification.id',
        'recipientState.notificationId',
      )
      .innerJoin('organisationMemberships as currentMembership', join =>
        join
          .onRef('currentMembership.organisationId', '=', 'notification.organisationId')
          .on('currentMembership.userId', '=', userId)
          .on('currentMembership.role', 'in', ['owner', 'admin', 'reviewer']),
      )
      .innerJoin('organisations as organisation', join =>
        join
          .onRef('organisation.id', '=', 'notification.organisationId')
          .on('organisation.status', '=', 'active'),
      )
      .innerJoin(
        'migrationCandidates as candidate',
        'candidate.id',
        'notification.candidateId',
      )
      .innerJoin(
        'repositories as repository',
        'repository.id',
        'notification.repositoryId',
      )
      .innerJoin(
        'dependencyObservations as observation',
        'observation.id',
        'candidate.dependencyObservationId',
      )
      .innerJoin(
        'migrationSpecifications as specification',
        'specification.id',
        'notification.migrationSpecificationId',
      )
      .select([
        'notification.id',
        'notification.eventType',
        'notification.candidateId',
        'notification.title',
        'notification.safeSummary',
        'notification.createdAt',
        'candidate.status as candidateStatus',
        'repository.fullName as repositoryFullName',
        'observation.packageName',
        'observation.declaredRange',
        'observation.resolvedVersion',
        'specification.targetVersion',
        'recipientState.deliveredAt',
        'recipientState.readAt',
        'recipientState.dismissedAt',
        'recipientState.version',
      ])
      .where('notification.organisationId', '=', organisationId)
      .where('recipientState.userId', '=', userId)
      .where('recipientState.channel', '=', 'in_app')
      .orderBy('recipientState.deliveredAt', 'desc')
      .limit(100)
      .execute();

    const candidateIds = notifications.map(notification => notification.candidateId);
    const impacts =
      candidateIds.length === 0
        ? []
        : await this.database
            .selectFrom('impactReports as impact')
            .distinctOn('impact.candidateId')
            .select(['impact.candidateId', 'impact.riskCategory', 'impact.uncertainty'])
            .where('impact.candidateId', 'in', candidateIds)
            .orderBy('impact.candidateId', 'asc')
            .orderBy('impact.revision', 'desc')
            .orderBy('impact.createdAt', 'desc')
            .execute();
    const impactsByCandidate = new Map(
      impacts.map(impact => [impact.candidateId, impact]),
    );

    return notifications.map(notification => {
      const impact = impactsByCandidate.get(notification.candidateId);
      return {
        notificationId: notification.id,
        eventType: notification.eventType,
        candidateId: notification.candidateId,
        candidateStatus: notification.candidateStatus,
        repositoryFullName: notification.repositoryFullName,
        packageName: notification.packageName,
        currentVersion: notification.resolvedVersion ?? notification.declaredRange,
        targetVersion: notification.targetVersion,
        title: notification.title,
        summary: notification.safeSummary,
        sourceProvenance: 'trusted_registry_and_reviewed_specification',
        impactStatus: impact ? 'ready' : 'pending',
        riskCategory: impact?.riskCategory ?? null,
        uncertaintyCount: impact
          ? Array.isArray(impact.uncertainty)
            ? impact.uncertainty.length
            : 0
          : null,
        deliveredAt: notification.deliveredAt.toISOString(),
        readAt: notification.readAt?.toISOString() ?? null,
        dismissedAt: notification.dismissedAt?.toISOString() ?? null,
        version: notification.version,
        createdAt: notification.createdAt.toISOString(),
      };
    });
  }

  public async updateCandidateNotificationState(
    userId: string,
    input: UpdateCandidateNotificationStateInput,
  ): Promise<PublicCandidateNotificationState> {
    await this.requireCandidateNotificationRecipient(input.organisationId, userId);
    try {
      const result = await sql<{
        readonly notificationId: string;
        readonly readAt: Date | null;
        readonly dismissedAt: Date | null;
        readonly version: number;
      }>`
        select
          notification_id as "notificationId",
          read_at as "readAt",
          dismissed_at as "dismissedAt",
          version
        from update_notification_recipient_state(
          ${userId}::uuid,
          ${input.organisationId}::uuid,
          ${input.notificationId}::uuid,
          ${input.action},
          ${input.requestId}::uuid
        )
      `.execute(this.database);
      const state = result.rows[0];
      if (!state) {
        throw new DomainError(
          'DEPENDENCY_NOTIFICATION_NOT_FOUND',
          'The dependency notification was not found.',
          404,
        );
      }
      return {
        notificationId: state.notificationId,
        readAt: state.readAt?.toISOString() ?? null,
        dismissedAt: state.dismissedAt?.toISOString() ?? null,
        version: state.version,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      const code = postgresErrorCode(error);
      if (code === '42501') {
        throw new DomainError(
          'DEPENDENCY_NOTIFICATION_ACCESS_DENIED',
          'The actor is not eligible to receive dependency notifications.',
          403,
        );
      }
      if (code === 'P0002') {
        throw new DomainError(
          'DEPENDENCY_NOTIFICATION_NOT_FOUND',
          'The dependency notification was not found.',
          404,
        );
      }
      throw error;
    }
  }

  private async requireCandidateNotificationRecipient(
    organisationId: string,
    userId: string,
  ): Promise<void> {
    const membership = requireAction(
      await this.membership(organisationId, userId),
      'migration:read',
    );
    if (membership.role === 'viewer') {
      throw new DomainError(
        'DEPENDENCY_NOTIFICATION_ACCESS_DENIED',
        'The actor is not eligible to receive dependency notifications.',
        403,
      );
    }
  }

  public async cancelMigrationRun(
    userId: string,
    input: CancelMigrationRunInput,
  ): Promise<PublicMigrationRunDetail> {
    requireAction(
      await this.membership(input.organisationId, userId),
      'migration:cancel',
    );
    await this.database.transaction().execute(async transaction => {
      const run = await transaction
        .selectFrom('migrationRuns')
        .select(['id', 'status', 'currentStage', 'version', 'cancellationRequestedAt'])
        .where('id', '=', input.migrationRunId)
        .where('organisationId', '=', input.organisationId)
        .forUpdate()
        .executeTakeFirst();
      if (!run) {
        throw new DomainError(
          'MIGRATION_RUN_NOT_FOUND',
          'The requested migration run was not found.',
          404,
        );
      }
      if (run.cancellationRequestedAt !== null || run.status === 'cancelled') return;
      if (!['queued', 'running'].includes(run.status)) {
        throw new DomainError(
          'MIGRATION_RUN_TERMINAL',
          'A completed migration run cannot be cancelled.',
          409,
        );
      }
      if (run.version !== input.expectedVersion) {
        throw new DomainError(
          'MIGRATION_RUN_CHANGED',
          'The migration run changed before cancellation was recorded.',
          409,
        );
      }
      const now = new Date();
      const queued = run.status === 'queued';
      await transaction
        .updateTable('migrationRuns')
        .set({
          cancellationRequestedAt: now,
          cancellationRequestedByUserId: userId,
          cancellationReasonCode: input.reasonCode,
          ...(queued
            ? {
                status: 'cancelled' as const,
                currentStage: 'cancelled' as const,
                terminalResult: 'cancelled' as const,
                completedAt: now,
              }
            : {}),
          updatedAt: now,
          version: run.version + 1,
        })
        .where('id', '=', run.id)
        .where('version', '=', run.version)
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        organisationId: input.organisationId,
        migrationRunId: run.id,
        eventKey: `cancel:${input.idempotencyKey}`,
        eventType: queued ? 'run_cancelled' : 'cancellation_requested',
        status: queued ? 'cancelled' : 'running',
        stage: queued ? 'cancelled' : run.currentStage,
        safeErrorCode: null,
        actorType: 'user',
        actorUserId: userId,
        requestId: input.requestId,
        createdAt: now,
      });
      if (queued) {
        await transaction
          .updateTable('migrationRunOutbox')
          .set({
            deliveredAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: null,
          })
          .where('migrationRunId', '=', run.id)
          .where('deliveredAt', 'is', null)
          .where('leaseOwner', 'is', null)
          .execute();
      }
      await writeAudit(transaction, {
        organisationId: input.organisationId,
        actorId: userId,
        action: 'migration.cancellation_requested',
        resourceType: 'migration_run',
        resourceId: run.id,
        requestId: input.requestId,
      });
    });
    return loadMigrationRun(this.database, input.organisationId, input.migrationRunId);
  }

  public async revokeMigrationApproval(
    userId: string,
    input: RevokeMigrationApprovalInput,
  ): Promise<PublicMigrationRunDetail> {
    const membership = requireAction(
      await this.membership(input.organisationId, userId),
      'migration:revoke',
    );
    if (
      membership.role !== 'owner' &&
      membership.role !== 'admin' &&
      membership.role !== 'reviewer'
    ) {
      throw new DomainError(
        'AUTHORIZATION_DENIED',
        'The actor is not authorized for this action.',
        403,
      );
    }
    const revokingRole = membership.role;
    await this.database.transaction().execute(async transaction => {
      const run = await transaction
        .selectFrom('migrationRuns as run')
        .leftJoin(
          'migrationApprovalRevocations as revocation',
          'revocation.approvalId',
          'run.approvalId',
        )
        .select([
          'run.id',
          'run.approvalId',
          'run.status',
          'run.currentStage',
          'run.version',
          'run.cancellationRequestedAt',
          'revocation.approvalId as revokedApprovalId',
        ])
        .where('run.id', '=', input.migrationRunId)
        .where('run.organisationId', '=', input.organisationId)
        .forUpdate('run')
        .executeTakeFirst();
      if (!run) {
        throw new DomainError(
          'MIGRATION_RUN_NOT_FOUND',
          'The requested migration run was not found.',
          404,
        );
      }
      if (run.revokedApprovalId !== null) return;
      if (!['queued', 'running'].includes(run.status)) {
        throw new DomainError(
          'MIGRATION_RUN_TERMINAL',
          'A completed migration approval cannot be revoked.',
          409,
        );
      }
      if (run.version !== input.expectedVersion) {
        throw new DomainError(
          'MIGRATION_RUN_CHANGED',
          'The migration run changed before revocation was recorded.',
          409,
        );
      }
      const now = new Date();
      const queued = run.status === 'queued';
      await transaction
        .insertInto('migrationApprovalRevocations')
        .values({
          approvalId: run.approvalId,
          revokedByUserId: userId,
          revokedByRole: revokingRole,
          reasonCode: input.reasonCode,
          requestId: input.requestId,
          revokedAt: now,
          createdAt: now,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('migrationRuns')
        .set({
          cancellationRequestedAt: now,
          cancellationRequestedByUserId: userId,
          cancellationReasonCode: 'APPROVAL_REVOKED',
          ...(queued
            ? {
                status: 'stale' as const,
                currentStage: 'stale' as const,
                terminalResult: 'stale' as const,
                safeErrorCode: 'MIGRATION_APPROVAL_REVOKED',
                completedAt: now,
              }
            : {}),
          updatedAt: now,
          version: run.version + 1,
        })
        .where('id', '=', run.id)
        .where('version', '=', run.version)
        .executeTakeFirstOrThrow();
      await appendMigrationRunEvent(transaction, {
        organisationId: input.organisationId,
        migrationRunId: run.id,
        eventKey: `revoke:${input.idempotencyKey}`,
        eventType: queued ? 'run_stale' : 'cancellation_requested',
        status: queued ? 'stale' : 'running',
        stage: queued ? 'stale' : run.currentStage,
        safeErrorCode: queued ? 'MIGRATION_APPROVAL_REVOKED' : null,
        actorType: 'user',
        actorUserId: userId,
        requestId: input.requestId,
        createdAt: now,
      });
      if (queued) {
        await transaction
          .updateTable('migrationRunOutbox')
          .set({
            deliveredAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
            safeErrorCode: null,
          })
          .where('migrationRunId', '=', run.id)
          .where('deliveredAt', 'is', null)
          .where('leaseOwner', 'is', null)
          .execute();
      }
      await writeAudit(transaction, {
        organisationId: input.organisationId,
        actorId: userId,
        action: 'migration.approval_revoked',
        resourceType: 'migration_approval',
        resourceId: run.approvalId,
        requestId: input.requestId,
      });
    });
    return loadMigrationRun(this.database, input.organisationId, input.migrationRunId);
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

interface PersistMigrationApprovalInput {
  readonly userId: string;
  readonly role: 'owner' | 'admin' | 'reviewer';
  readonly input: CreateMigrationApprovalInput;
  readonly requestDigest: string;
  readonly preview: PublicMigrationApprovalPreview;
  readonly candidateId: string;
  readonly repositoryId: string;
  readonly githubRepositoryId: string;
  readonly installationId: string;
  readonly baseBranch: string;
  readonly snapshotId: string;
  readonly commitSha: string;
  readonly snapshotDigest: string;
  readonly specificationId: string;
  readonly specificationRevision: number;
  readonly specificationDigest: string;
  readonly impactReportId: string;
  readonly impactReportRevision: number;
  readonly impactReportDigest: string;
}

async function loadIdempotentMigrationApproval(
  transaction: Transaction<Database>,
  userId: string,
  input: CreateMigrationApprovalInput,
  requestDigest: string,
): Promise<PublicMigrationApprovalResult | undefined> {
  const previous = await transaction
    .selectFrom('migrationApprovals')
    .select(['id', 'organisationId', 'candidateId', 'requestDigest'])
    .where('approvedByUserId', '=', userId)
    .where('idempotencyKey', '=', input.idempotencyKey)
    .executeTakeFirst();
  if (!previous) return undefined;
  if (
    previous.requestDigest !== requestDigest ||
    previous.organisationId !== input.organisationId ||
    previous.candidateId !== input.candidateId
  ) {
    throw new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'The idempotency key was already used for another request.',
      409,
    );
  }
  return loadMigrationApprovalResult(transaction, previous.id);
}

async function persistMigrationApproval(
  transaction: Transaction<Database>,
  context: PersistMigrationApprovalInput,
): Promise<PublicMigrationApprovalResult> {
  const approvalId = randomUUID();
  const migrationRunId = randomUUID();
  const correlationId = randomUUID();
  const now = new Date();
  const authority = context.preview.authority;
  await transaction
    .insertInto('migrationApprovals')
    .values({
      id: approvalId,
      organisationId: context.input.organisationId,
      candidateId: context.candidateId,
      repositoryId: context.repositoryId,
      githubRepositoryId: context.githubRepositoryId,
      installationId: context.installationId,
      repositorySnapshotId: context.snapshotId,
      baseBranch: context.baseBranch,
      baseCommitSha: context.commitSha,
      snapshotDigest: context.snapshotDigest,
      migrationSpecificationId: context.specificationId,
      migrationSpecificationRevision: context.specificationRevision,
      migrationSpecificationDigest: context.specificationDigest,
      impactReportId: context.impactReportId,
      impactReportRevision: context.impactReportRevision,
      impactReportDigest: context.impactReportDigest,
      approvalContractVersion: authority.approvalContractVersion,
      agentPolicyVersion: authority.agentPolicyVersion,
      toolRegistryVersion: authority.toolRegistryVersion,
      patchPolicyVersion: authority.patchPolicyVersion,
      patchPolicy: authority.patchPolicy,
      patchPolicyDigest: digestJson(authority.patchPolicy),
      verificationPolicyVersion: authority.verificationPolicyVersion,
      verificationProfile: authority.verificationProfile,
      verificationProfileDigest: digestJson(authority.verificationProfile),
      publicationPolicyVersion: authority.publicationPolicyVersion,
      openaiProcessingPolicyVersion: authority.openaiProcessingPolicyVersion,
      openaiProcessingMode: authority.openaiProcessingMode,
      acknowledgementSourceProcessing: context.input.acknowledgements.sourceProcessing,
      acknowledgementVerificationExecution:
        context.input.acknowledgements.verificationExecution,
      acknowledgementDraftPullRequest: context.input.acknowledgements.draftPullRequest,
      acknowledgementHumanReviewRequired:
        context.input.acknowledgements.humanReviewRequired,
      renderedCopyDigest: context.preview.renderedCopyDigest,
      approvedByUserId: context.userId,
      approvedByRole: context.role,
      requestId: context.input.requestId,
      correlationId,
      idempotencyKey: context.input.idempotencyKey,
      requestDigest: context.requestDigest,
      approvedAt: now,
      expiresAt: null,
      createdAt: now,
    })
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('migrationRuns')
    .values({
      id: migrationRunId,
      organisationId: context.input.organisationId,
      candidateId: context.candidateId,
      approvalId,
      repositoryId: context.repositoryId,
      baseCommitSha: context.commitSha,
      status: 'queued',
      currentStage: 'queued',
      attempt: 1,
      workflowExecutionArn: null,
      terminalResult: null,
      safeErrorCode: null,
      correlationId,
      cancellationRequestedAt: null,
      cancellationRequestedByUserId: null,
      cancellationReasonCode: null,
      version: 1,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .executeTakeFirstOrThrow();
  await transaction
    .insertInto('migrationRunOutbox')
    .values({
      id: randomUUID(),
      organisationId: context.input.organisationId,
      migrationRunId,
      eventType: 'migration_run.requested',
      aggregateVersion: 1,
      idempotencyKey: `migration-run:${migrationRunId}`,
      payload: {
        schemaVersion: '1.0',
        organisationId: context.input.organisationId,
        migrationRunId,
        candidateId: context.candidateId,
        approvalId,
        repositoryId: context.repositoryId,
        correlationId,
        expectedAttempt: 1,
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
  await appendMigrationRunEvent(transaction, {
    organisationId: context.input.organisationId,
    migrationRunId,
    eventKey: `run:${migrationRunId}:requested`,
    eventType: 'run_requested',
    status: 'queued',
    stage: 'queued',
    safeErrorCode: null,
    actorType: 'user',
    actorUserId: context.userId,
    requestId: context.input.requestId,
    createdAt: now,
  });
  await writeAudit(transaction, {
    organisationId: context.input.organisationId,
    actorId: context.userId,
    action: 'migration.approved',
    resourceType: 'migration_approval',
    resourceId: approvalId,
    requestId: context.input.requestId,
  });
  return loadMigrationApprovalResult(transaction, approvalId);
}

interface MigrationRunEventInput {
  readonly organisationId: string;
  readonly migrationRunId: string;
  readonly eventKey: string;
  readonly eventType:
    | 'run_requested'
    | 'approval_validated'
    | 'stage_entered'
    | 'cancellation_requested'
    | 'run_cancelled'
    | 'run_failed'
    | 'run_stale'
    | 'run_completed';
  readonly status:
    'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
  readonly stage:
    | 'queued'
    | 'revalidating'
    | 'acquiring'
    | 'planning'
    | 'patching'
    | 'verifying'
    | 'repairing'
    | 'publishing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'stale';
  readonly safeErrorCode: string | null;
  readonly actorType: 'user' | 'system';
  readonly actorUserId: string | null;
  readonly requestId: string;
  readonly createdAt: Date;
}

async function appendMigrationRunEvent(
  transaction: Transaction<Database>,
  input: MigrationRunEventInput,
): Promise<void> {
  const existing = await transaction
    .selectFrom('migrationRunEvents')
    .select('id')
    .where('migrationRunId', '=', input.migrationRunId)
    .where('eventKey', '=', input.eventKey)
    .executeTakeFirst();
  if (existing) return;
  const latest = await transaction
    .selectFrom('migrationRunEvents')
    .select('sequence')
    .where('migrationRunId', '=', input.migrationRunId)
    .orderBy('sequence', 'desc')
    .executeTakeFirst();
  await transaction
    .insertInto('migrationRunEvents')
    .values({
      id: randomUUID(),
      organisationId: input.organisationId,
      migrationRunId: input.migrationRunId,
      sequence: (latest?.sequence ?? 0) + 1,
      eventKey: input.eventKey,
      eventType: input.eventType,
      status: input.status,
      stage: input.stage,
      safeErrorCode: input.safeErrorCode,
      actorType: input.actorType,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      createdAt: input.createdAt,
    })
    .executeTakeFirstOrThrow();
}

const migrationRunSummarySelection = [
  'run.id',
  'run.candidateId',
  'run.approvalId',
  'run.baseCommitSha',
  'run.status',
  'run.currentStage',
  'run.safeErrorCode',
  'run.version',
  'run.createdAt',
  'run.completedAt',
  'repository.fullName as repositoryFullName',
  'product.canonicalIdentifier as packageName',
  'specification.targetVersion',
  'approval.approvedByRole',
  'approval.approvedAt',
  'approver.displayName as approvedByDisplayName',
  'revocation.revokedAt',
  'revocation.revokedByRole',
  'revocation.reasonCode as revocationReasonCode',
  'revoker.displayName as revokedByDisplayName',
] as const;

interface MigrationRunSummaryRow {
  readonly id: string;
  readonly candidateId: string;
  readonly approvalId: string;
  readonly baseCommitSha: string;
  readonly status: PublicMigrationRunSummary['status'];
  readonly currentStage: PublicMigrationRunSummary['currentStage'];
  readonly safeErrorCode: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  readonly repositoryFullName: string;
  readonly packageName: string;
  readonly targetVersion: string;
  readonly approvedByRole: 'owner' | 'admin' | 'reviewer';
  readonly approvedAt: Date;
  readonly approvedByDisplayName: string | null;
  readonly revokedAt: Date | null;
  readonly revokedByRole: 'owner' | 'admin' | 'reviewer' | null;
  readonly revocationReasonCode: string | null;
  readonly revokedByDisplayName: string | null;
}

function migrationRunSummary(run: MigrationRunSummaryRow): PublicMigrationRunSummary {
  return {
    id: run.id,
    candidateId: run.candidateId,
    approvalId: run.approvalId,
    repositoryFullName: run.repositoryFullName,
    packageName: run.packageName,
    baseCommitSha: run.baseCommitSha,
    targetVersion: run.targetVersion,
    status: run.status,
    currentStage: run.currentStage,
    safeErrorCode: run.safeErrorCode,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    approval: {
      approvedByDisplayName: run.approvedByDisplayName,
      approvedByRole: run.approvedByRole,
      approvedAt: run.approvedAt.toISOString(),
      revokedAt: run.revokedAt?.toISOString() ?? null,
      revokedByDisplayName: run.revokedByDisplayName,
      revokedByRole: run.revokedByRole,
      revocationReasonCode: run.revocationReasonCode,
    },
  };
}

function selectMigrationRunSummaries(
  database: AppDatabase | Transaction<Database>,
  organisationId: string,
  migrationRunId?: string,
): Promise<MigrationRunSummaryRow[]> {
  let query = database
    .selectFrom('migrationRuns as run')
    .innerJoin('migrationCandidates as candidate', 'candidate.id', 'run.candidateId')
    .innerJoin('repositories as repository', 'repository.id', 'run.repositoryId')
    .innerJoin('migrationApprovals as approval', 'approval.id', 'run.approvalId')
    .innerJoin('appUsers as approver', 'approver.id', 'approval.approvedByUserId')
    .leftJoin(
      'migrationApprovalRevocations as revocation',
      'revocation.approvalId',
      'approval.id',
    )
    .leftJoin('appUsers as revoker', 'revoker.id', 'revocation.revokedByUserId')
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
    .select(migrationRunSummarySelection)
    .where('run.organisationId', '=', organisationId)
    .where('candidate.organisationId', '=', organisationId)
    .where('repository.organisationId', '=', organisationId);
  if (migrationRunId) query = query.where('run.id', '=', migrationRunId);
  return query.orderBy('run.createdAt', 'desc').limit(100).execute();
}

async function loadMigrationRuns(
  database: AppDatabase | Transaction<Database>,
  organisationId: string,
): Promise<PublicMigrationRunSummary[]> {
  const runs = await selectMigrationRunSummaries(database, organisationId);
  return runs.map(migrationRunSummary);
}

async function loadMigrationRun(
  database: AppDatabase | Transaction<Database>,
  organisationId: string,
  migrationRunId: string,
): Promise<PublicMigrationRunDetail> {
  const [run] = await selectMigrationRunSummaries(
    database,
    organisationId,
    migrationRunId,
  );
  if (!run) {
    throw new DomainError(
      'MIGRATION_RUN_NOT_FOUND',
      'The requested migration run was not found.',
      404,
    );
  }
  const [workflow, events, verificationAttempts, publication] = await Promise.all([
    database
      .selectFrom('migrationRuns')
      .select(['workflowExecutionArn', 'cancellationRequestedAt'])
      .where('organisationId', '=', organisationId)
      .where('id', '=', migrationRunId)
      .executeTakeFirstOrThrow(),
    database
      .selectFrom('migrationRunEvents as event')
      .leftJoin('appUsers as actor', 'actor.id', 'event.actorUserId')
      .select([
        'event.sequence',
        'event.eventType',
        'event.status',
        'event.stage',
        'event.safeErrorCode',
        'event.actorType',
        'actor.displayName as actorDisplayName',
        'event.createdAt',
      ])
      .where('event.organisationId', '=', organisationId)
      .where('event.migrationRunId', '=', migrationRunId)
      .orderBy('event.sequence')
      .execute(),
    database
      .selectFrom('verificationAttempts as attempt')
      .leftJoin(
        'verificationAttemptResults as result',
        'result.verificationAttemptId',
        'attempt.id',
      )
      .select([
        'attempt.id',
        'attempt.attemptNumber',
        'attempt.patchAttemptId',
        'attempt.verificationPolicyVersion',
        'attempt.verificationProfile',
        'result.outcome',
        'result.safeErrorCode',
        'result.commands',
        'result.resultDigest',
        'result.stdoutDigest',
        'result.stderrDigest',
        'result.startedAt',
        'result.completedAt',
      ])
      .where('attempt.organisationId', '=', organisationId)
      .where('attempt.migrationRunId', '=', migrationRunId)
      .orderBy('attempt.attemptNumber')
      .execute(),
    database
      .selectFrom('publicationAttempts as attempt')
      .leftJoin(
        'githubPublications as publication',
        'publication.publicationAttemptId',
        'attempt.id',
      )
      .leftJoin('publicationNotificationOutbox as notification', join =>
        join
          .onRef('notification.publicationId', '=', 'publication.id')
          .on('notification.channel', '=', 'in_app'),
      )
      .select([
        'attempt.id as attemptId',
        'attempt.status',
        'attempt.attemptCount',
        'attempt.safeErrorCode',
        'attempt.headBranch',
        'attempt.baseBranch',
        'attempt.baseCommitSha',
        'attempt.createdAt',
        'attempt.completedAt',
        'publication.pullRequestNumber',
        'publication.pullRequestUrl',
        'publication.state as pullRequestState',
        'publication.isDraft',
        'publication.commitSha',
        'publication.createdAt as pullRequestCreatedAt',
        'publication.lastReconciledAt',
        'notification.attempts as notificationAttempts',
        'notification.deliveredAt as notificationDeliveredAt',
        'notification.safeErrorCode as notificationSafeErrorCode',
        'notification.id as notificationId',
      ])
      .where('attempt.organisationId', '=', organisationId)
      .where('attempt.migrationRunId', '=', migrationRunId)
      .orderBy('attempt.createdAt', 'desc')
      .limit(1)
      .executeTakeFirst(),
  ]);
  return {
    ...migrationRunSummary(run),
    workflowExecutionArn: workflow.workflowExecutionArn,
    cancellationRequestedAt: workflow.cancellationRequestedAt?.toISOString() ?? null,
    events: events.map(event => ({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })),
    verificationAttempts: verificationAttempts.map(attempt => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      patchAttemptId: attempt.patchAttemptId,
      policyVersion: attempt.verificationPolicyVersion,
      profiles: migrationApprovalVerificationProfileSchema.parse(
        attempt.verificationProfile,
      ).profiles,
      outcome: attempt.outcome,
      safeErrorCode: attempt.safeErrorCode,
      commands:
        attempt.commands === null
          ? []
          : migrationVerificationResultSchema.shape.commands.parse(attempt.commands),
      resultDigest: attempt.resultDigest,
      stdoutDigest: attempt.stdoutDigest,
      stderrDigest: attempt.stderrDigest,
      startedAt: attempt.startedAt?.toISOString() ?? null,
      completedAt: attempt.completedAt?.toISOString() ?? null,
    })),
    publication:
      publication === undefined
        ? null
        : {
            attemptId: publication.attemptId,
            status: publication.status,
            attemptCount: publication.attemptCount,
            safeErrorCode: publication.safeErrorCode,
            headBranch: publication.headBranch,
            baseBranch: publication.baseBranch,
            baseCommitSha: publication.baseCommitSha,
            createdAt: publication.createdAt.toISOString(),
            completedAt: publication.completedAt?.toISOString() ?? null,
            pullRequest:
              publication.pullRequestNumber === null ||
              publication.pullRequestUrl === null ||
              publication.pullRequestState === null ||
              publication.isDraft === null ||
              publication.commitSha === null ||
              publication.pullRequestCreatedAt === null ||
              publication.lastReconciledAt === null
                ? null
                : {
                    number: publication.pullRequestNumber,
                    url: publication.pullRequestUrl,
                    state: publication.pullRequestState,
                    isDraft: publication.isDraft,
                    commitSha: publication.commitSha,
                    createdAt: publication.pullRequestCreatedAt.toISOString(),
                    lastReconciledAt: publication.lastReconciledAt.toISOString(),
                  },
            notification:
              publication.notificationId === null
                ? null
                : {
                    channel: 'in_app',
                    status:
                      publication.notificationDeliveredAt !== null
                        ? 'delivered'
                        : publication.notificationSafeErrorCode ===
                            'OUTBOX_DELIVERY_FAILED'
                          ? 'failed'
                          : 'queued',
                    attempts: publication.notificationAttempts ?? 0,
                    deliveredAt:
                      publication.notificationDeliveredAt?.toISOString() ?? null,
                    safeErrorCode: publication.notificationSafeErrorCode,
                  },
          },
  };
}

async function loadMigrationPatchReview(
  database: AppDatabase | Transaction<Database>,
  organisationId: string,
  migrationRunId: string,
): Promise<MigrationPatchReviewRecord | null> {
  const run = await database
    .selectFrom('migrationRuns as run')
    .innerJoin('migrationApprovals as approval', 'approval.id', 'run.approvalId')
    .innerJoin(
      'migrationSpecifications as specification',
      'specification.id',
      'approval.migrationSpecificationId',
    )
    .select([
      'run.organisationId',
      'run.id as migrationRunId',
      'run.baseCommitSha',
      'approval.patchPolicy',
      'specification.specification',
    ])
    .where('run.organisationId', '=', organisationId)
    .where('approval.organisationId', '=', organisationId)
    .where('run.id', '=', migrationRunId)
    .executeTakeFirst();
  if (!run) {
    throw new DomainError(
      'MIGRATION_RUN_NOT_FOUND',
      'The requested migration run was not found.',
      404,
    );
  }
  const attempts = await database
    .selectFrom('patchAttempts')
    .select([
      'id',
      'attemptNumber',
      'parentPatchAttemptId',
      'status',
      'safeErrorCode',
      'summaryCode',
      'changedFiles',
      'addedLines',
      'deletedLines',
      'patchBytes',
      'patchArtifactId',
      'validationArtifactId',
      'policyVersion',
      'policyDigest',
      'createdAt',
    ])
    .where('organisationId', '=', organisationId)
    .where('migrationRunId', '=', migrationRunId)
    .orderBy('attemptNumber', 'desc')
    .execute();
  const selected = attempts.find(
    attempt =>
      attempt.patchArtifactId !== null && attempt.validationArtifactId !== null,
  );
  if (!selected?.patchArtifactId || !selected.validationArtifactId) return null;
  const plan = await database
    .selectFrom('migrationPlans')
    .select(['artifactId'])
    .where('organisationId', '=', organisationId)
    .where('migrationRunId', '=', migrationRunId)
    .where('attemptNumber', '=', selected.attemptNumber)
    .executeTakeFirstOrThrow();
  const artifacts = await database
    .selectFrom('migrationArtifacts')
    .select(['id', 'artifactType', 'objectKey', 'digest', 'bytes'])
    .where('organisationId', '=', organisationId)
    .where('migrationRunId', '=', migrationRunId)
    .where('id', 'in', [
      plan.artifactId,
      selected.patchArtifactId,
      selected.validationArtifactId,
    ])
    .execute();
  const manifestArtifact = await database
    .selectFrom('migrationArtifacts')
    .select(['id', 'artifactType', 'objectKey', 'digest', 'bytes'])
    .where('organisationId', '=', organisationId)
    .where('migrationRunId', '=', migrationRunId)
    .where('artifactType', '=', 'patch_manifest')
    .orderBy('createdAt', 'desc')
    .executeTakeFirstOrThrow();
  const allArtifacts = [...artifacts, manifestArtifact];
  const artifact = (
    id: string | null,
    expectedType: (typeof allArtifacts)[number]['artifactType'],
  ): PatchReviewArtifactRecord => {
    const value = allArtifacts.find(
      candidate => candidate.id === id && candidate.artifactType === expectedType,
    );
    if (!value) throw new Error('The migration patch review artifact is missing.');
    const bytes = Number(value.bytes);
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new Error('The migration patch review artifact size is invalid.');
    }
    return {
      objectKey: value.objectKey,
      digest: value.digest,
      bytes,
    };
  };
  return {
    ...run,
    selectedAttemptId: selected.id,
    attemptNumber: selected.attemptNumber,
    policyVersion: selected.policyVersion,
    policyDigest: selected.policyDigest,
    plan: artifact(plan.artifactId, 'migration_plan'),
    patch: artifact(selected.patchArtifactId, 'patch_proposal'),
    manifest: artifact(manifestArtifact.id, 'patch_manifest'),
    validation: artifact(selected.validationArtifactId, 'patch_validation'),
    attempts: attempts.map(attempt => ({
      id: attempt.id,
      attemptNumber: attempt.attemptNumber,
      parentPatchAttemptId: attempt.parentPatchAttemptId,
      status: attempt.status,
      safeErrorCode: attempt.safeErrorCode,
      summaryCode: attempt.summaryCode,
      changedFiles: attempt.changedFiles,
      addedLines: attempt.addedLines,
      deletedLines: attempt.deletedLines,
      patchBytes: attempt.patchBytes,
      selected: attempt.id === selected.id,
      createdAt: attempt.createdAt.toISOString(),
    })),
  };
}

async function loadMigrationApprovalResult(
  database: AppDatabase | Transaction<Database>,
  approvalId: string,
): Promise<PublicMigrationApprovalResult> {
  const row = await database
    .selectFrom('migrationApprovals as approval')
    .innerJoin('migrationRuns as run', 'run.approvalId', 'approval.id')
    .select([
      'approval.id as approvalId',
      'approval.candidateId',
      'approval.repositoryId',
      'approval.baseCommitSha',
      'approval.approvedByRole',
      'approval.approvedAt',
      'run.id as runId',
      'run.status',
      'run.currentStage',
      'run.version',
      'run.createdAt',
    ])
    .where('approval.id', '=', approvalId)
    .executeTakeFirstOrThrow();
  return {
    approval: {
      id: row.approvalId,
      candidateId: row.candidateId,
      repositoryId: row.repositoryId,
      baseCommitSha: row.baseCommitSha,
      approvedByRole: row.approvedByRole,
      approvedAt: row.approvedAt.toISOString(),
    },
    run: {
      id: row.runId,
      candidateId: row.candidateId,
      approvalId: row.approvalId,
      status: row.status,
      currentStage: row.currentStage,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
    },
  };
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

type PackageSourceDatabase = AppDatabase | Transaction<Database>;

async function loadPackageSourceMappingByCandidate(
  database: PackageSourceDatabase,
  candidateId: string,
): Promise<PublicPackageSourceMapping> {
  const candidate = await database
    .selectFrom('packageSourceCandidates')
    .select('mappingId')
    .where('id', '=', candidateId)
    .executeTakeFirst();
  if (!candidate) {
    throw new DomainError(
      'PACKAGE_SOURCE_CANDIDATE_NOT_FOUND',
      'The package source candidate was not found.',
      404,
    );
  }
  const mappings = await loadPackageSourceMappings(
    database,
    undefined,
    candidate.mappingId,
  );
  const mapping = mappings[0];
  if (!mapping) {
    throw new DomainError(
      'PACKAGE_SOURCE_MAPPING_NOT_FOUND',
      'The package source mapping was not found.',
      404,
    );
  }
  return mapping;
}

async function loadPackageSourceMappingById(
  database: PackageSourceDatabase,
  mappingId: string,
): Promise<PublicPackageSourceMapping> {
  const mappings = await loadPackageSourceMappings(database, undefined, mappingId);
  const mapping = mappings[0];
  if (!mapping) {
    throw new DomainError(
      'PACKAGE_SOURCE_MAPPING_NOT_FOUND',
      'The package source mapping was not found.',
      404,
    );
  }
  return mapping;
}

async function loadPackageSourceMappings(
  database: PackageSourceDatabase,
  status?: 'needs_review' | 'mapped' | 'rejected' | 'disabled',
  mappingId?: string,
): Promise<PublicPackageSourceMapping[]> {
  let query = database
    .selectFrom('packageSourceMappings as mapping')
    .innerJoin(
      'packageSourceMappingControls as control',
      'control.mappingId',
      'mapping.id',
    )
    .leftJoin('apiProducts as product', 'product.id', 'mapping.apiProductId')
    .leftJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
    .select([
      'mapping.id',
      'mapping.packageName',
      'mapping.status',
      'mapping.latestVersion',
      'mapping.latestDeprecated',
      'mapping.resolvedAt',
      'mapping.registryMetadataDigest as evidenceDigest',
      'mapping.version',
      'mapping.apiProductId',
      'vendor.id as vendorId',
      'vendor.slug as vendorSlug',
      'vendor.name as vendorName',
      'control.disabled',
      'control.disabledReasonCode',
      'control.disabledAt',
    ])
    .orderBy('mapping.updatedAt', 'desc')
    .limit(100);
  if (status) {
    query =
      status === 'disabled'
        ? query.where('control.disabled', '=', true)
        : query
            .where('control.disabled', '=', false)
            .where('mapping.status', '=', status);
  }
  if (mappingId) {
    query = query.where('mapping.id', '=', mappingId);
  }
  const rows = await query.execute();
  if (rows.length === 0) {
    return [];
  }
  const mappingIds = rows.map(row => row.id);
  const candidates = await database
    .selectFrom('packageSourceCandidates')
    .select([
      'id',
      'mappingId',
      'sourceKind',
      'canonicalUrl',
      'canonicalDomain',
      'reviewState',
      'discoveryMethod',
      'proposalReasonCode',
      'proposalNote',
      'supersedesCandidateId',
      'rejectionReasonCode',
      'reviewedAt',
      'version',
    ])
    .where('mappingId', 'in', mappingIds)
    .orderBy('createdAt', 'asc')
    .execute();
  const usageResult = await sql<{
    mappingId: string;
    total: string;
    direct: string;
    development: string;
    optional: string;
    peer: string;
  }>`
    with latest_snapshots as (
      select distinct on (snapshot.repository_id)
        snapshot.id,
        snapshot.repository_id
      from repository_snapshots as snapshot
      inner join repositories as repository on repository.id = snapshot.repository_id
      where snapshot.status = 'available'
        and snapshot.expires_at > now()
        and repository.selected
        and repository.enabled
        and not repository.archived
      order by snapshot.repository_id, snapshot.created_at desc, snapshot.id desc
    )
    select
      mapping.id as "mappingId",
      count(distinct latest.repository_id)::text as total,
      count(distinct latest.repository_id) filter (
        where observation.dependency_kind = 'dependency'
      )::text as direct,
      count(distinct latest.repository_id) filter (
        where observation.dependency_kind = 'development'
      )::text as development,
      count(distinct latest.repository_id) filter (
        where observation.dependency_kind = 'optional'
      )::text as optional,
      count(distinct latest.repository_id) filter (
        where observation.dependency_kind = 'peer'
      )::text as peer
    from package_source_mappings as mapping
    left join dependency_observations as observation
      on observation.package_name = mapping.package_name
    left join latest_snapshots as latest
      on latest.id = observation.repository_snapshot_id
    where mapping.id in (${sql.join(mappingIds.map(id => sql`${id}::uuid`))})
    group by mapping.id
  `.execute(database);
  const usageByMapping = new Map(
    usageResult.rows.map(usage => [
      usage.mappingId,
      {
        total: Number(usage.total),
        direct: Number(usage.direct),
        development: Number(usage.development),
        optional: Number(usage.optional),
        peer: Number(usage.peer),
      },
    ]),
  );
  return rows.map(row => {
    if (
      row.status !== 'needs_review' &&
      row.status !== 'mapped' &&
      row.status !== 'rejected'
    ) {
      throw new DomainError(
        'PACKAGE_SOURCE_MAPPING_STATE_INVALID',
        'The package source mapping cannot be shown in the review queue.',
        500,
      );
    }
    return {
      id: row.id,
      packageName: row.packageName,
      status: row.disabled ? 'disabled' : row.status,
      latestVersion: row.latestVersion,
      latestDeprecated: row.latestDeprecated,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      evidenceDigest: row.evidenceDigest,
      vendorSlug: row.vendorSlug,
      vendorName: row.vendorName,
      vendorId: row.vendorId,
      apiProductId: row.apiProductId,
      disabledReasonCode: row.disabledReasonCode,
      disabledAt: row.disabledAt?.toISOString() ?? null,
      version: row.version,
      repositoryUsage: usageByMapping.get(row.id) ?? {
        total: 0,
        direct: 0,
        development: 0,
        optional: 0,
        peer: 0,
      },
      candidates: candidates
        .filter(candidate => candidate.mappingId === row.id)
        .map(candidate => ({
          id: candidate.id,
          sourceKind: candidate.sourceKind,
          canonicalUrl: candidate.canonicalUrl,
          canonicalDomain: candidate.canonicalDomain,
          reviewState: candidate.reviewState,
          discoveryMethod: candidate.discoveryMethod,
          proposalReasonCode: candidate.proposalReasonCode,
          proposalNote: candidate.proposalNote,
          supersedesCandidateId: candidate.supersedesCandidateId,
          rejectionReasonCode: candidate.rejectionReasonCode,
          reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
          version: candidate.version,
          canPromote:
            candidate.sourceKind === 'package_registry_release' ||
            candidate.sourceKind === 'sdk_repository_release' ||
            candidate.sourceKind === 'changelog' ||
            candidate.sourceKind === 'release_feed' ||
            candidate.sourceKind === 'migration_guide',
        })),
    };
  });
}

function postgresErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function postgresErrorMessage(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
    ? error.message
    : undefined;
}

type PackageSourceReviewFailureStage =
  | 'operator_check'
  | 'idempotency_lookup'
  | 'candidate_load'
  | 'approval_function'
  | 'idempotency_write'
  | 'result_reload';

function packageSourceReviewPermissionCode(
  stage: PackageSourceReviewFailureStage,
): string {
  return `PACKAGE_SOURCE_REVIEW_${stage.toUpperCase()}_PERMISSION_DENIED`;
}

function canonicalPackageSourceUrl(value: string): {
  readonly url: string;
  readonly domain: string;
} {
  const parsed = new URL(value);
  const domain = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.port !== '' ||
    parsed.hash !== '' ||
    isIP(domain) !== 0 ||
    !domain.includes('.') ||
    domain === 'localhost'
  ) {
    throw new DomainError(
      'PACKAGE_SOURCE_REPLACEMENT_URL_INVALID',
      'The replacement must use a public HTTPS hostname without credentials, port, or fragment.',
      400,
    );
  }
  return { url: parsed.toString(), domain };
}

function throwPackageSourceMutationError(error: unknown, operation: string): never {
  if (error instanceof DomainError) throw error;
  const code = postgresErrorCode(error);
  if (code === '40001') {
    throw new DomainError(
      'PACKAGE_SOURCE_REVIEW_CONFLICT',
      `The package source ${operation} conflicted with a concurrent change.`,
      409,
    );
  }
  if (code === '23514' || code === '23505') {
    throw new DomainError(
      'PACKAGE_SOURCE_CATALOG_CONFLICT',
      `The package source ${operation} conflicts with the trusted catalog.`,
      409,
    );
  }
  if (code === '42501') {
    throw new DomainError(
      'PLATFORM_OPERATOR_REQUIRED',
      'Platform operator authorization is required.',
      403,
    );
  }
  if (code === 'P0002') {
    throw new DomainError(
      'PACKAGE_SOURCE_NOT_FOUND',
      'The package source resource was not found.',
      404,
    );
  }
  throw error;
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
