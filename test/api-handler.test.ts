import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '@migration/config';
import { DomainError, type Actor } from '@migration/domain';

import { handleRequest, type ApiDependencies } from '../services/api/src/handler.js';
import type {
  PublicCandidateNotification,
  PublicCandidateNotificationState,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationApprovalResult,
  PublicImpactAnalysisRequest,
  PublicMigrationRunDetail,
  PublicMigrationRunSummary,
  PublicPublicationNotification,
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
import type {
  AgentRunRecord,
  ApiRepositoryPort,
  CompleteGithubInstallationInput,
  CompletedGithubInstallation,
  CreateMigrationApprovalInput,
  CancelMigrationRunInput,
  CreateDemoRunInput,
  CreateRepositoryScanInput,
  CreateOrganisationInput,
  InstallationLinkRecord,
  MigrationPatchReviewRecord,
  OrganisationRecord,
  PackageReleasePilotBackfillDispatch,
  ReviewMigrationSpecificationInput,
  RequestImpactAnalysisInput,
  ReviewPackageSourceCandidateInput,
  ReplacePackageSourceCandidateInput,
  RequestPackageReleasePilotBackfillInput,
  RetryPackageReleasePilotBackfillInput,
  RevokeMigrationApprovalInput,
  SetPackageSourceMappingStateInput,
  UpdateCandidateNotificationStateInput,
} from '../services/api/src/repository.js';

const organisationId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const runId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const userId = '12a906c7-f7df-4c65-9137-70bcf17eec86';

const config: ApiConfig = {
  APP_ENVIRONMENT: 'development',
  AWS_REGION: 'ap-southeast-2',
  ARTIFACT_BUCKET: 'artifacts',
  ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
  DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:db',
  OPENAI_MODEL: 'gpt-5.6-sol',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
  SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  GITHUB_APP_SLUG: 'migration-api-development',
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: 'migration-api-development-github-token-broker',
  IMPACT_ANALYSIS_STATE_MACHINE_ARN:
    'arn:aws:states:ap-southeast-2:123456789012:stateMachine:impact-analysis',
};

const queuedRun: AgentRunRecord = {
  id: runId,
  organisationId,
  scenarioId: 'orbitchat-typescript-v1-v2',
  status: 'queued',
  terminalCode: null,
  safeErrorCode: null,
  resultArtifactId: null,
  resultObjectKey: null,
  resultDigest: null,
  resultBytes: null,
  version: 1,
  createdAt: new Date('2026-07-24T00:00:00.000Z'),
  startedAt: null,
  completedAt: null,
};

const draftSpecification: PublicMigrationSpecification = {
  id: runId,
  vendorReleaseId: organisationId,
  vendorName: 'OrbitChat',
  productIdentifier: '@orbitchat/sdk',
  sourceCompatibility: '1.x',
  targetVersion: '2.0.0',
  trustState: 'draft',
  revision: 1,
  evidenceDigest: 'a'.repeat(64),
  reviewedAt: null,
  createdAt: '2026-07-26T00:00:00.000Z',
};

const packageSourceMapping: PublicPackageSourceMapping = {
  id: organisationId,
  packageName: '@orbitchat/sdk',
  status: 'needs_review',
  latestVersion: '2.0.0',
  latestDeprecated: false,
  resolvedAt: '2026-08-01T00:00:00.000Z',
  evidenceDigest: 'b'.repeat(64),
  vendorSlug: null,
  vendorName: null,
  vendorId: null,
  apiProductId: null,
  disabledReasonCode: null,
  disabledAt: null,
  repositoryUsage: {
    total: 1,
    direct: 1,
    development: 0,
    optional: 0,
    peer: 0,
  },
  version: 1,
  candidates: [
    {
      id: runId,
      sourceKind: 'package_registry_release',
      canonicalUrl: 'https://registry.npmjs.org/@orbitchat%2Fsdk',
      canonicalDomain: 'registry.npmjs.org',
      reviewState: 'pending_review',
      discoveryMethod: 'npm_registry_metadata',
      proposalReasonCode: 'NPM_REGISTRY_AUTHORITATIVE',
      proposalNote: null,
      supersedesCandidateId: null,
      rejectionReasonCode: null,
      reviewedAt: null,
      version: 1,
      canPromote: true,
    },
  ],
};

class FakeRepository implements ApiRepositoryPort {
  private readonly migrationRun: PublicMigrationRunDetail = {
    id: runId,
    candidateId: runId,
    approvalId: organisationId,
    repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
    packageName: '@orbitchat/sdk',
    baseCommitSha: 'a'.repeat(40),
    targetVersion: '2.0.0',
    status: 'running',
    currentStage: 'revalidating',
    workflowExecutionArn: null,
    safeErrorCode: null,
    cancellationRequestedAt: null,
    version: 2,
    createdAt: '2026-07-27T00:00:00.000Z',
    completedAt: null,
    approval: {
      approvedByDisplayName: 'Kunal Sharma',
      approvedByRole: 'owner',
      approvedAt: '2026-07-27T00:00:00.000Z',
      revokedAt: null,
      revokedByDisplayName: null,
      revokedByRole: null,
      revocationReasonCode: null,
    },
    events: [],
    verificationAttempts: [],
    publication: null,
  };
  public readonly createMigrationApprovalMock = vi.fn<
    (
      userId: string,
      input: CreateMigrationApprovalInput,
    ) => Promise<PublicMigrationApprovalResult>
  >((_userId, input) =>
    Promise.resolve({
      approval: {
        id: organisationId,
        candidateId: input.candidateId,
        repositoryId: runId,
        baseCommitSha: 'a'.repeat(40),
        approvedByRole: 'owner',
        approvedAt: '2026-07-27T00:00:00.000Z',
      },
      run: {
        id: runId,
        candidateId: input.candidateId,
        approvalId: organisationId,
        status: 'queued',
        currentStage: 'queued',
        version: 1,
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    }),
  );
  public readonly createRepositoryScanMock = vi.fn<
    (userId: string, input: CreateRepositoryScanInput) => Promise<PublicRepositoryScan>
  >((_userId, input) =>
    Promise.resolve({
      id: runId,
      organisationId: input.organisationId,
      repositoryId: input.repositoryId,
      requestedCommit: null,
      status: 'queued',
      safeErrorCode: null,
      version: 1,
      createdAt: '2026-07-24T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
    }),
  );
  public readonly requestImpactAnalysisMock = vi.fn<
    (
      userId: string,
      input: RequestImpactAnalysisInput,
    ) => Promise<PublicImpactAnalysisRequest>
  >((_userId, input) =>
    Promise.resolve({
      candidateId: input.candidateId,
      correlationId: runId,
      status: 'queued',
    }),
  );
  public readonly createDemoRunMock = vi.fn<
    (userId: string, input: CreateDemoRunInput) => Promise<AgentRunRecord>
  >(() => Promise.resolve(queuedRun));
  public readonly createGithubInstallLinkMock = vi.fn<
    (userId: string, organisationId: string) => Promise<InstallationLinkRecord>
  >(() =>
    Promise.resolve({
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      expiresAt: new Date('2026-07-24T00:10:00.000Z'),
    }),
  );
  public readonly completeGithubInstallationMock = vi.fn<
    (
      userId: string,
      input: CompleteGithubInstallationInput,
    ) => Promise<CompletedGithubInstallation>
  >(() =>
    Promise.resolve({
      organisationId,
      installation: {
        id: runId,
        accountLogin: 'SharmaKunal14',
        accountType: 'User',
        status: 'active',
        lastReconciledAt: null,
      },
    }),
  );
  public readonly validateGithubInstallStateMock = vi.fn<
    (userId: string, state: string) => Promise<void>
  >(() => Promise.resolve());
  public readonly reviewMigrationSpecificationMock = vi.fn<
    (
      userId: string,
      input: ReviewMigrationSpecificationInput,
    ) => Promise<PublicMigrationSpecificationReview>
  >(() =>
    Promise.resolve({
      specification: {
        ...draftSpecification,
        trustState: 'reviewed',
        reviewedAt: '2026-07-26T01:00:00.000Z',
      },
      matchedRepositories: 1,
      unmatchedRepositories: 0,
    }),
  );
  public readonly reviewPackageSourceCandidateMock = vi.fn<
    (
      userId: string,
      input: ReviewPackageSourceCandidateInput,
    ) => Promise<PublicPackageSourceCandidateReview>
  >(() => Promise.resolve({ mapping: packageSourceMapping }));
  public readonly replacePackageSourceCandidateMock = vi.fn<
    (
      userId: string,
      input: ReplacePackageSourceCandidateInput,
    ) => Promise<PublicPackageSourceCandidateReview>
  >(() => Promise.resolve({ mapping: packageSourceMapping }));
  public readonly setPackageSourceMappingStateMock = vi.fn<
    (
      userId: string,
      input: SetPackageSourceMappingStateInput,
    ) => Promise<PublicPackageSourceCandidateReview>
  >(() => Promise.resolve({ mapping: packageSourceMapping }));
  public readonly requestPackageReleasePilotBackfillMock = vi.fn<
    (
      userId: string,
      input: RequestPackageReleasePilotBackfillInput,
    ) => Promise<PackageReleasePilotBackfillDispatch>
  >(() =>
    Promise.resolve({
      backfill: {
        detectionId: runId,
        vendorReleaseId: organisationId,
        sourceVersion: '5.9.0',
        targetVersion: '5.10.0',
        created: true,
      },
      workflowExecutionArn: null,
      outboxPending: true,
    }),
  );
  public readonly retryPackageReleasePilotBackfillMock = vi.fn<
    (userId: string, input: RetryPackageReleasePilotBackfillInput) => Promise<void>
  >(() => Promise.resolve());

  public ensureUser(_actor: Actor): Promise<string> {
    return Promise.resolve(userId);
  }

  public hasPlatformOperatorAccess(_userId: string): Promise<boolean> {
    return Promise.resolve(true);
  }

  public listPackageSourceMappings(
    _userId: string,
    _status: 'needs_review' | 'mapped' | 'rejected' | 'disabled',
  ): Promise<PublicPackageSourceMapping[]> {
    return Promise.resolve([packageSourceMapping]);
  }

  public reviewPackageSourceCandidate(
    _userId: string,
    _input: ReviewPackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    return this.reviewPackageSourceCandidateMock(_userId, _input);
  }

  public listPackageSourceCatalog(_userId: string): Promise<{
    readonly products: readonly PublicPackageSourceCatalogEntry[];
    readonly vendors: readonly PublicPackageSourceVendor[];
  }> {
    return Promise.resolve({ products: [], vendors: [] });
  }

  public replacePackageSourceCandidate(
    _userId: string,
    _input: ReplacePackageSourceCandidateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    return this.replacePackageSourceCandidateMock(_userId, _input);
  }

  public setPackageSourceMappingState(
    _userId: string,
    _input: SetPackageSourceMappingStateInput,
  ): Promise<PublicPackageSourceCandidateReview> {
    return this.setPackageSourceMappingStateMock(_userId, _input);
  }

  public requestPackageReleasePilotBackfill(
    _userId: string,
    _input: RequestPackageReleasePilotBackfillInput,
  ): Promise<PackageReleasePilotBackfillDispatch> {
    return this.requestPackageReleasePilotBackfillMock(_userId, _input);
  }

  public retryPackageReleasePilotBackfill(
    _userId: string,
    _input: RetryPackageReleasePilotBackfillInput,
  ): Promise<void> {
    return this.retryPackageReleasePilotBackfillMock(_userId, _input);
  }

  public listOrganisations(_userId: string): Promise<OrganisationRecord[]> {
    return Promise.resolve([]);
  }

  public createOrganisation(
    _userId: string,
    input: CreateOrganisationInput,
  ): Promise<OrganisationRecord> {
    return Promise.resolve({
      id: organisationId,
      name: input.name,
      slug: input.slug,
      role: 'owner',
    });
  }

  public createDemoRun(
    requestedBy: string,
    input: CreateDemoRunInput,
  ): Promise<AgentRunRecord> {
    return this.createDemoRunMock(requestedBy, input);
  }

  public getRun(
    _userId: string,
    _organisationId: string,
    _runId: string,
  ): Promise<AgentRunRecord> {
    return Promise.resolve(queuedRun);
  }

  public getMigrationRun(
    _userId: string,
    _organisationId: string,
    _migrationRunId: string,
  ): Promise<PublicMigrationRunDetail> {
    return Promise.resolve(this.migrationRun);
  }

  public getMigrationPatchReview(
    _userId: string,
    _organisationId: string,
    _migrationRunId: string,
  ): Promise<MigrationPatchReviewRecord | null> {
    return Promise.resolve(null);
  }

  public listMigrationRuns(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicMigrationRunSummary[]> {
    return Promise.resolve([this.migrationRun]);
  }

  public listPublicationNotifications(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicPublicationNotification[]> {
    return Promise.resolve([]);
  }

  public listCandidateNotifications(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicCandidateNotification[]> {
    return Promise.resolve([
      {
        notificationId: runId,
        eventType: 'migration_candidate_ready',
        candidateId: runId,
        candidateStatus: 'open',
        repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
        packageName: '@orbitchat/sdk',
        currentVersion: '1.0.0',
        targetVersion: '2.0.0',
        title: 'Dependency update ready',
        summary:
          'A trusted package release has reviewed migration guidance and matches this repository.',
        sourceProvenance: 'trusted_registry_and_reviewed_specification',
        impactStatus: 'pending',
        riskCategory: null,
        uncertaintyCount: null,
        deliveredAt: '2026-08-02T00:00:00.000Z',
        readAt: null,
        dismissedAt: null,
        version: 1,
        createdAt: '2026-08-02T00:00:00.000Z',
      },
    ]);
  }

  public updateCandidateNotificationState(
    _userId: string,
    input: UpdateCandidateNotificationStateInput,
  ): Promise<PublicCandidateNotificationState> {
    return Promise.resolve({
      notificationId: input.notificationId,
      readAt: '2026-08-02T00:01:00.000Z',
      dismissedAt: input.action === 'dismiss' ? '2026-08-02T00:01:00.000Z' : null,
      version: 2,
    });
  }

  public cancelMigrationRun(
    _userId: string,
    _input: CancelMigrationRunInput,
  ): Promise<PublicMigrationRunDetail> {
    return Promise.resolve({
      ...this.migrationRun,
      status: 'cancelled',
      currentStage: 'cancelled',
      cancellationRequestedAt: '2026-07-27T00:01:00.000Z',
      completedAt: '2026-07-27T00:01:00.000Z',
      version: 3,
    });
  }

  public revokeMigrationApproval(
    _userId: string,
    _input: RevokeMigrationApprovalInput,
  ): Promise<PublicMigrationRunDetail> {
    return Promise.resolve({
      ...this.migrationRun,
      status: 'stale',
      currentStage: 'stale',
      safeErrorCode: 'MIGRATION_APPROVAL_REVOKED',
      completedAt: '2026-07-27T00:01:00.000Z',
      version: 3,
      approval: {
        ...this.migrationRun.approval,
        revokedAt: '2026-07-27T00:01:00.000Z',
        revokedByDisplayName: 'Kunal Sharma',
        revokedByRole: 'owner',
        revocationReasonCode: 'USER_REQUESTED',
      },
    });
  }

  public listGithubInstallations(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicGithubInstallation[]> {
    return Promise.resolve([]);
  }

  public listRepositories(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicRepository[]> {
    return Promise.resolve([]);
  }

  public listDependencies(
    _userId: string,
    _organisationId: string,
    _repositoryId: string,
  ): Promise<PublicDependencyObservation[]> {
    return Promise.resolve([]);
  }

  public createRepositoryScan(
    requestedBy: string,
    input: CreateRepositoryScanInput,
  ): Promise<PublicRepositoryScan> {
    return this.createRepositoryScanMock(requestedBy, input);
  }

  public requestImpactAnalysis(
    requestedBy: string,
    input: RequestImpactAnalysisInput,
  ): Promise<PublicImpactAnalysisRequest> {
    return this.requestImpactAnalysisMock(requestedBy, input);
  }

  public createGithubInstallLink(
    requestedBy: string,
    requestedOrganisationId: string,
  ): Promise<InstallationLinkRecord> {
    return this.createGithubInstallLinkMock(requestedBy, requestedOrganisationId);
  }

  public validateGithubInstallState(requestedBy: string, state: string): Promise<void> {
    return this.validateGithubInstallStateMock(requestedBy, state);
  }

  public completeGithubInstallation(
    requestedBy: string,
    input: CompleteGithubInstallationInput,
  ): Promise<CompletedGithubInstallation> {
    return this.completeGithubInstallationMock(requestedBy, input);
  }

  public listMigrationSpecifications(
    _userId: string,
    _trustState: 'draft' | 'reviewed' | 'vendor_verified',
  ): Promise<PublicMigrationSpecification[]> {
    return Promise.resolve([draftSpecification]);
  }

  public reviewMigrationSpecification(
    requestedBy: string,
    input: ReviewMigrationSpecificationInput,
  ): Promise<PublicMigrationSpecificationReview> {
    return this.reviewMigrationSpecificationMock(requestedBy, input);
  }

  public getMigrationSpecification(
    _userId: string,
    _specificationId: string,
  ): Promise<PublicMigrationSpecificationDetail> {
    return Promise.resolve({
      ...draftSpecification,
      specification: {
        schemaVersion: '1.0',
        vendor: { slug: 'orbitchat', name: 'OrbitChat' },
        product: { ecosystem: 'npm', identifier: '@orbitchat/sdk' },
        sourceCompatibility: '1.x',
        targetVersion: '2.0.0',
        changes: [],
        evidence: [],
        preconditions: [],
        verificationRecommendations: ['typescript_static'],
        uncertainties: [],
        trust: {
          status: 'draft',
          generatedBy: 'change_intelligence_agent',
          reviewedAt: null,
        },
        revision: 1,
        generatedAt: '2026-07-26T00:00:00.000Z',
      },
    });
  }

  public listMigrationCandidates(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicMigrationCandidate[]> {
    return Promise.resolve([]);
  }

  public getMigrationCandidate(
    _userId: string,
    _organisationId: string,
    candidateId: string,
  ): Promise<PublicMigrationCandidateDetail> {
    return Promise.resolve({
      candidate: {
        id: candidateId,
        repositoryId: runId,
        repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
        migrationSpecificationId: runId,
        packageName: '@orbitchat/sdk',
        declaredRange: '^1.0.0',
        resolvedVersion: '1.0.0',
        sourceCompatibility: '1.x',
        targetVersion: '2.0.0',
        specificationTrustState: 'reviewed',
        status: 'open',
        impact: null,
        firstDetectedAt: '2026-07-26T00:00:00.000Z',
        lastDetectedAt: '2026-07-26T00:00:00.000Z',
        version: 1,
      },
      repository: {
        id: runId,
        fullName: 'SharmaKunal14/orbitchat-migration-fixture',
        snapshotId: organisationId,
        commitSha: 'a'.repeat(40),
        snapshotDigest: 'b'.repeat(64),
        snapshotCreatedAt: '2026-07-26T00:00:00.000Z',
      },
      dependency: {
        id: organisationId,
        packageName: '@orbitchat/sdk',
        dependencyKind: 'dependency',
        manifestPath: 'package.json',
        lockfilePath: 'package-lock.json',
        declaredRange: '^1.0.0',
        resolvedVersion: '1.0.0',
        discoveryMethod: 'npm_lockfile',
      },
      specification: {
        ...draftSpecification,
        trustState: 'reviewed',
        reviewedAt: '2026-07-26T00:00:00.000Z',
        specification: {
          schemaVersion: '1.0',
          vendor: { slug: 'orbitchat', name: 'OrbitChat' },
          product: { ecosystem: 'npm', identifier: '@orbitchat/sdk' },
          sourceCompatibility: '1.x',
          targetVersion: '2.0.0',
          changes: [],
          evidence: [],
          preconditions: [],
          verificationRecommendations: ['typescript_static'],
          uncertainties: [],
          trust: {
            status: 'reviewed',
            generatedBy: 'change_intelligence_agent',
            reviewedAt: '2026-07-26T00:00:00.000Z',
          },
          revision: 1,
          generatedAt: '2026-07-26T00:00:00.000Z',
        },
      },
      vendorEvidence: [],
      impactReport: null,
      impactAnalysis: null,
      approval: {
        eligible: false,
        blockers: ['CURRENT_IMPACT_REPORT_REQUIRED'],
        renderedCopy: 'Exact approval copy.',
        renderedCopyDigest: 'd'.repeat(64),
        authority: {
          schemaVersion: '1.0',
          approvalContractVersion: '1.0',
          agentPolicyVersion: 'migration-agent-1.0',
          toolRegistryVersion: 'migration-tools-1.0',
          patchPolicyVersion: 'typescript-bounded-1.0',
          patchPolicy: {
            schemaVersion: '1.0',
            allowedPaths: ['package.json'],
            allowedChangeCategories: ['dependency_manifest'],
            maxChangedFiles: 1,
            maxPatchBytes: 262_144,
            maxAddedLines: 1_000,
            maxDeletedLines: 500,
          },
          verificationPolicyVersion: 'typescript-default-1.0',
          verificationProfile: {
            schemaVersion: '1.0',
            profiles: [
              {
                profile: 'typescript_static',
                availability: 'unavailable',
                commandIds: [],
              },
            ],
          },
          publicationPolicyVersion: 'draft-pr-1.0',
          openaiProcessingPolicyVersion: 'default-controls-1.0',
          openaiProcessingMode: 'default_controls',
        },
      },
    });
  }

  public createMigrationApproval(
    requestedBy: string,
    input: CreateMigrationApprovalInput,
  ): Promise<PublicMigrationApprovalResult> {
    return this.createMigrationApprovalMock(requestedBy, input);
  }
}

function dependencies(
  repository = new FakeRepository(),
  stepFunctionsSend: ApiDependencies['stepFunctions']['send'] = vi.fn(() =>
    Promise.resolve({}),
  ),
): ApiDependencies {
  return {
    config,
    repository,
    s3: new S3Client({ region: 'ap-southeast-2' }),
    stepFunctions: {
      send: stepFunctionsSend,
    },
    workflowExecutionInspector: {
      describe: vi.fn(() => Promise.resolve('RUNNING' as const)),
    },
    tokenVerifier: {
      verify(): Promise<Actor> {
        return Promise.resolve({ userId, subject: userId });
      },
    },
    installationVerifier: {
      verify(installationId): Promise<{
        installationId: string;
        accountId: string;
        accountLogin: string;
        accountType: 'User';
        status: 'active';
      }> {
        return Promise.resolve({
          installationId,
          accountId: '104818699',
          accountLogin: 'SharmaKunal14',
          accountType: 'User',
          status: 'active',
        });
      },
    },
  };
}

function event(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: 'Bearer valid.token.value' },
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: '30a75bfd-6a69-4368-a341-10362df73007',
      routeKey: '$default',
      stage: '$default',
      time: '24/Jul/2026:00:00:00 +0000',
      timeEpoch: 1784851200000,
    },
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function parsedBody(response: Awaited<ReturnType<typeof handleRequest>>): unknown {
  return JSON.parse(response.body ?? 'null');
}

describe('API handler trust boundary', () => {
  it('rejects an unauthenticated request safely', async () => {
    const dependency: ApiDependencies = {
      ...dependencies(),
      tokenVerifier: {
        verify(): Promise<Actor> {
          return Promise.reject(
            new DomainError(
              'AUTHENTICATION_REQUIRED',
              'A valid access token is required.',
              401,
            ),
          );
        },
      },
    };
    const response = await handleRequest(
      event('GET', '/api/v1/me', undefined, {}),
      dependency,
    );
    expect(response.statusCode).toBe(401);
    expect(parsedBody(response)).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid access token is required.',
        requestId: '30a75bfd-6a69-4368-a341-10362df73007',
      },
    });
  });

  it('rejects unknown mutation fields', async () => {
    const response = await handleRequest(
      event('POST', '/api/v1/organisations', {
        name: 'Acme',
        slug: 'acme',
        role: 'owner',
      }),
      dependencies(),
    );
    expect(response.statusCode).toBe(400);
    expect(parsedBody(response)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('requires an idempotency key before creating a run', async () => {
    const response = await handleRequest(
      event('POST', `/api/v1/organisations/${organisationId}/demo-runs`, {
        scenarioId: 'orbitchat-typescript-v1-v2',
      }),
      dependencies(),
    );
    expect(response.statusCode).toBe(400);
    expect(parsedBody(response)).toMatchObject({
      error: { code: 'INVALID_IDEMPOTENCY_KEY' },
    });
  });

  it('starts one strict synthetic run request', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/demo-runs`,
        { scenarioId: 'orbitchat-typescript-v1-v2' },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'run:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(202);
    expect(repository.createDemoRunMock).toHaveBeenCalledOnce();
    expect(repository.createDemoRunMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        idempotencyKey: 'run:01J7Y5ABCD',
        scenarioId: 'orbitchat-typescript-v1-v2',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      run: { id: runId, status: 'queued', result: null },
    });
  });

  it('starts an idempotent repository scan with identifier-only input', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/repositories/${runId}/scans`,
        {},
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'scan:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(202);
    expect(repository.createRepositoryScanMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        repositoryId: runId,
        idempotencyKey: 'scan:01J7Y5ABCD',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      scan: { id: runId, repositoryId: runId, status: 'queued' },
    });
  });

  it('starts tenant-scoped impact analysis with an idempotency key', async () => {
    const repository = new FakeRepository();
    const startExecution = vi.fn(() => Promise.resolve({}));
    const dependency = dependencies(repository, startExecution);
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/migration-candidates/${runId}/impact-analysis`,
        {},
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'impact:01J7Y5ABCD',
        },
      ),
      dependency,
    );
    expect(response.statusCode).toBe(202);
    expect(repository.requestImpactAnalysisMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        candidateId: runId,
        idempotencyKey: 'impact:01J7Y5ABCD',
      }),
    );
    expect(startExecution).toHaveBeenCalledOnce();
    expect(parsedBody(response)).toEqual({
      analysis: {
        candidateId: runId,
        correlationId: runId,
        status: 'queued',
      },
    });
  });

  it.each([
    [`/api/v1/organisations/${organisationId}/github/installations`, 'installations'],
    [`/api/v1/organisations/${organisationId}/repositories`, 'repositories'],
    [
      `/api/v1/organisations/${organisationId}/repositories/${runId}/dependencies`,
      'dependencies',
    ],
    [`/api/v1/organisations/${organisationId}/migration-candidates`, 'candidates'],
  ])('returns a tenant-scoped Stage 2 collection from %s', async (path, key) => {
    const response = await handleRequest(
      event('GET', path),
      dependencies(new FakeRepository()),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ [key]: [] });
  });

  it('returns a tenant-scoped migration candidate detail', async () => {
    const response = await handleRequest(
      event(
        'GET',
        `/api/v1/organisations/${organisationId}/migration-candidates/${runId}`,
      ),
      dependencies(new FakeRepository()),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toMatchObject({
      candidate: {
        candidate: {
          id: runId,
          repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
          specificationTrustState: 'reviewed',
        },
        repository: { commitSha: 'a'.repeat(40) },
      },
    });
  });

  it('creates one exact migration approval with an idempotency key', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/migration-candidates/${runId}/approvals`,
        {
          expectedCandidateVersion: 1,
          expectedRepositorySnapshotId: organisationId,
          expectedBaseCommitSha: 'a'.repeat(40),
          expectedSnapshotDigest: 'b'.repeat(64),
          expectedSpecificationRevision: 1,
          expectedSpecificationDigest: 'c'.repeat(64),
          expectedImpactReportId: userId,
          expectedImpactReportRevision: 1,
          expectedImpactReportDigest: 'e'.repeat(64),
          renderedCopyDigest: 'd'.repeat(64),
          acknowledgements: {
            sourceProcessing: true,
            verificationExecution: true,
            draftPullRequest: true,
            humanReviewRequired: true,
          },
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'approval:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(202);
    expect(repository.createMigrationApprovalMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        candidateId: runId,
        idempotencyKey: 'approval:01J7Y5ABCD',
        expectedCandidateVersion: 1,
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      approval: { candidateId: runId },
      run: { status: 'queued', currentStage: 'queued' },
    });
  });

  it('rejects approval unless every effect is acknowledged', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/migration-candidates/${runId}/approvals`,
        {
          expectedCandidateVersion: 1,
          expectedRepositorySnapshotId: organisationId,
          expectedBaseCommitSha: 'a'.repeat(40),
          expectedSnapshotDigest: 'b'.repeat(64),
          expectedSpecificationRevision: 1,
          expectedSpecificationDigest: 'c'.repeat(64),
          expectedImpactReportId: userId,
          expectedImpactReportRevision: 1,
          expectedImpactReportDigest: 'e'.repeat(64),
          renderedCopyDigest: 'd'.repeat(64),
          acknowledgements: {
            sourceProcessing: false,
            verificationExecution: true,
            draftPullRequest: true,
            humanReviewRequired: true,
          },
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'approval:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(400);
    expect(repository.createMigrationApprovalMock).not.toHaveBeenCalled();
  });

  it('returns the tenant-scoped durable migration timeline', async () => {
    const response = await handleRequest(
      event('GET', `/api/v1/organisations/${organisationId}/migration-runs/${runId}`),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toMatchObject({
      run: {
        id: runId,
        repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
        currentStage: 'revalidating',
      },
    });
  });

  it('returns no patch review before an immutable patch attempt exists', async () => {
    const response = await handleRequest(
      event(
        'GET',
        `/api/v1/organisations/${organisationId}/migration-runs/${runId}/patch-review`,
      ),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ patchReview: null });
  });

  it('returns the tenant-scoped migration run history', async () => {
    const response = await handleRequest(
      event('GET', `/api/v1/organisations/${organisationId}/migration-runs`),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toMatchObject({
      runs: [
        {
          id: runId,
          repositoryFullName: 'SharmaKunal14/orbitchat-migration-fixture',
          approval: {
            approvedByDisplayName: 'Kunal Sharma',
            approvedByRole: 'owner',
          },
        },
      ],
    });
  });

  it('returns only the current reviewer in-app publication notifications', async () => {
    const response = await handleRequest(
      event('GET', `/api/v1/organisations/${organisationId}/notifications`),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ notifications: [] });
  });

  it('returns dependency notifications independently from publication alerts', async () => {
    const response = await handleRequest(
      event('GET', `/api/v1/organisations/${organisationId}/dependency-notifications`),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toMatchObject({
      notifications: [
        {
          eventType: 'migration_candidate_ready',
          packageName: '@orbitchat/sdk',
          currentVersion: '1.0.0',
          targetVersion: '2.0.0',
          impactStatus: 'pending',
        },
      ],
    });
  });

  it('updates only a strict dependency-notification recipient state action', async () => {
    const path = `/api/v1/organisations/${organisationId}/dependency-notifications/${runId}/state`;
    const invalid = await handleRequest(
      event('POST', path, { action: 'dismiss', unexpected: true }),
      dependencies(),
    );
    expect(invalid.statusCode).toBe(400);

    const response = await handleRequest(
      event('POST', path, { action: 'dismiss' }),
      dependencies(),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({
      state: {
        notificationId: runId,
        readAt: '2026-08-02T00:01:00.000Z',
        dismissedAt: '2026-08-02T00:01:00.000Z',
        version: 2,
      },
    });
  });

  it('requires strict input and an idempotency key to cancel a migration', async () => {
    const path = `/api/v1/organisations/${organisationId}/migration-runs/${runId}/cancellation`;
    const missingKey = await handleRequest(
      event('POST', path, {
        expectedVersion: 2,
        reasonCode: 'USER_REQUESTED',
      }),
      dependencies(),
    );
    expect(missingKey.statusCode).toBe(400);
    expect(parsedBody(missingKey)).toMatchObject({
      error: { code: 'INVALID_IDEMPOTENCY_KEY' },
    });

    const response = await handleRequest(
      event(
        'POST',
        path,
        { expectedVersion: 2, reasonCode: 'USER_REQUESTED' },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'cancel:01J7Y5ABCD',
        },
      ),
      dependencies(),
    );
    expect(response.statusCode).toBe(202);
    expect(parsedBody(response)).toMatchObject({
      run: { id: runId, status: 'cancelled', currentStage: 'cancelled' },
    });
  });

  it('requires strict input and an idempotency key to revoke an approval', async () => {
    const path = `/api/v1/organisations/${organisationId}/migration-runs/${runId}/approval-revocation`;
    const missingKey = await handleRequest(
      event('POST', path, {
        expectedVersion: 2,
        reasonCode: 'USER_REQUESTED',
      }),
      dependencies(),
    );
    expect(missingKey.statusCode).toBe(400);
    expect(parsedBody(missingKey)).toMatchObject({
      error: { code: 'INVALID_IDEMPOTENCY_KEY' },
    });

    const invalidReason = await handleRequest(
      event(
        'POST',
        path,
        { expectedVersion: 2, reasonCode: 'arbitrary text' },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'revoke:01J7Y5ABCD',
        },
      ),
      dependencies(),
    );
    expect(invalidReason.statusCode).toBe(400);

    const response = await handleRequest(
      event(
        'POST',
        path,
        { expectedVersion: 2, reasonCode: 'USER_REQUESTED' },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'revoke:01J7Y5ABCD',
        },
      ),
      dependencies(),
    );
    expect(response.statusCode).toBe(202);
    expect(parsedBody(response)).toMatchObject({
      run: {
        id: runId,
        status: 'stale',
        currentStage: 'stale',
        safeErrorCode: 'MIGRATION_APPROVAL_REVOKED',
        approval: {
          revokedAt: '2026-07-27T00:01:00.000Z',
          revokedByRole: 'owner',
        },
      },
    });
  });

  it('reviews a draft only through the operator route with idempotency', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/migration-specifications/${runId}/review`,
        { expectedRevision: 1 },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'review:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(200);
    expect(repository.reviewMigrationSpecificationMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        specificationId: runId,
        expectedRevision: 1,
        idempotencyKey: 'review:01J7Y5ABCD',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      review: {
        specification: { trustState: 'reviewed' },
        matchedRepositories: 1,
      },
    });
  });

  it('lists the operator package source review queue', async () => {
    const response = await handleRequest(
      event('GET', '/api/v1/operator/package-source-mappings'),
      dependencies(),
    );

    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toMatchObject({
      mappings: [{ packageName: '@orbitchat/sdk', status: 'needs_review' }],
    });
  });

  it('lists the operator catalog without exposing customer repositories', async () => {
    const response = await handleRequest(
      event('GET', '/api/v1/operator/package-source-catalog'),
      dependencies(),
    );

    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ products: [], vendors: [] });
  });

  it('validates and reviews an exact package source candidate', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-candidates/${runId}/review`,
        {
          decision: 'approve',
          expectedCandidateVersion: 1,
          expectedMappingVersion: 1,
          pollIntervalSeconds: 86400,
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-source-review:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(200);
    expect(repository.reviewPackageSourceCandidateMock.mock.calls[0]?.[0]).toBe(userId);
    expect(
      repository.reviewPackageSourceCandidateMock.mock.calls[0]?.[1],
    ).toMatchObject({
      candidateId: runId,
      decision: 'approve',
      pollIntervalSeconds: 86400,
      idempotencyKey: 'package-source-review:01J7Y5ABCD',
    });
  });

  it('rejects package source approvals that try to supply extra fields', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-candidates/${runId}/review`,
        {
          decision: 'approve',
          expectedCandidateVersion: 1,
          expectedMappingVersion: 1,
          catalog: {
            mode: 'new_vendor',
            vendorSlug: 'orbitchat',
            vendorName: 'OrbitChat',
            officialDomains: ['orbitchat.example'],
          },
          approveCandidateDomain: false,
          pollIntervalSeconds: 86400,
          canonicalUrl: 'https://attacker.example/source',
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-source-review:01J7Y5ABCE',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(400);
    expect(repository.reviewPackageSourceCandidateMock).not.toHaveBeenCalled();
  });

  it('creates a versioned operator replacement candidate', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-candidates/${runId}/replacement`,
        {
          expectedCandidateVersion: 1,
          expectedMappingVersion: 1,
          sourceKind: 'changelog',
          canonicalUrl: 'https://docs.orbitchat.example/changelog',
          proposalNote: 'The vendor documentation links this changelog.',
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-source-replacement:01J7Y5ABCF',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(201);
    expect(repository.replacePackageSourceCandidateMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        candidateId: runId,
        sourceKind: 'changelog',
        expectedCandidateVersion: 1,
      }),
    );
  });

  it('disables a package source mapping with an explicit reason', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-mappings/${organisationId}/state`,
        {
          action: 'disable',
          expectedMappingVersion: 1,
          disabledReasonCode: 'SECURITY_CONCERN',
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-source-state:01J7Y5ABCG',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(200);
    expect(repository.setPackageSourceMappingStateMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        mappingId: organisationId,
        action: 'disable',
        disabledReasonCode: 'SECURITY_CONCERN',
      }),
    );
  });

  it('requests an operator-authorized current release pilot backfill', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-mappings/${organisationId}/pilot-backfill`,
        { expectedMappingVersion: 1 },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-release-backfill:01J7Y5ABCH',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(202);
    expect(repository.requestPackageReleasePilotBackfillMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        mappingId: organisationId,
        expectedMappingVersion: 1,
        idempotencyKey: 'package-release-backfill:01J7Y5ABCH',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      backfill: { queueState: 'queued' },
    });
  });

  it('requeues an operator pilot only after its prior workflow failed', async () => {
    const repository = new FakeRepository();
    const workflowExecutionArn =
      'arn:aws:states:ap-southeast-2:123456789012:execution:vendor-ingestion:failed';
    repository.requestPackageReleasePilotBackfillMock.mockResolvedValueOnce({
      backfill: {
        detectionId: runId,
        vendorReleaseId: organisationId,
        sourceVersion: '5.9.0',
        targetVersion: '5.10.0',
        created: false,
      },
      workflowExecutionArn,
      outboxPending: false,
    });
    const dependency: ApiDependencies = {
      ...dependencies(repository),
      workflowExecutionInspector: {
        describe: vi.fn(() => Promise.resolve('FAILED' as const)),
      },
    };

    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-mappings/${organisationId}/pilot-backfill`,
        { expectedMappingVersion: 1 },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-release-backfill:retry-01J7Y5ABCH',
        },
      ),
      dependency,
    );

    expect(response.statusCode).toBe(202);
    expect(repository.retryPackageReleasePilotBackfillMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        detectionId: runId,
        expectedWorkflowExecutionArn: workflowExecutionArn,
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      backfill: { created: false, queueState: 'queued' },
    });
  });

  it('does not duplicate a pilot workflow that is still running', async () => {
    const repository = new FakeRepository();
    repository.requestPackageReleasePilotBackfillMock.mockResolvedValueOnce({
      backfill: {
        detectionId: runId,
        vendorReleaseId: organisationId,
        sourceVersion: '5.9.0',
        targetVersion: '5.10.0',
        created: false,
      },
      workflowExecutionArn:
        'arn:aws:states:ap-southeast-2:123456789012:execution:vendor-ingestion:running',
      outboxPending: false,
    });
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-mappings/${organisationId}/pilot-backfill`,
        { expectedMappingVersion: 1 },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-release-backfill:running-01J7Y5ABCH',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(202);
    expect(repository.retryPackageReleasePilotBackfillMock).not.toHaveBeenCalled();
    expect(parsedBody(response)).toMatchObject({
      backfill: { queueState: 'in_progress' },
    });
  });

  it('rejects unsafe replacement URL shapes before catalog mutation', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/operator/package-source-candidates/${runId}/replacement`,
        {
          expectedCandidateVersion: 1,
          expectedMappingVersion: 1,
          sourceKind: 'changelog',
          canonicalUrl: 'http://169.254.169.254/latest/meta-data',
          proposalNote: 'Unsafe source.',
        },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'package-source-replacement:01J7Y5ABCH',
        },
      ),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(400);
    expect(repository.replacePackageSourceCandidateMock).not.toHaveBeenCalled();
  });

  it('creates a short-lived GitHub App installation URL', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event('POST', `/api/v1/organisations/${organisationId}/github/install-link`, {}),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(201);
    expect(repository.createGithubInstallLinkMock).toHaveBeenCalledWith(
      userId,
      organisationId,
    );
    expect(parsedBody(response)).toEqual({
      installLink: {
        installationUrl:
          'https://github.com/apps/migration-api-development/installations/new?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        expiresAt: '2026-07-24T00:10:00.000Z',
      },
    });
  });

  it('verifies and links a GitHub App callback', async () => {
    const repository = new FakeRepository();
    const dependency = dependencies(repository);
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(200);
    expect(repository.validateGithubInstallStateMock).toHaveBeenCalledWith(
      userId,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(verify).toHaveBeenCalledWith('123456789');
    expect(repository.completeGithubInstallationMock).toHaveBeenCalledOnce();
    expect(repository.completeGithubInstallationMock.mock.calls[0]?.[0]).toBe(userId);
    expect(repository.completeGithubInstallationMock.mock.calls[0]?.[1]).toMatchObject({
      installationId: '123456789',
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      verified: { accountId: '104818699' },
    });
    expect(parsedBody(response)).toMatchObject({
      organisationId,
      installation: { accountLogin: 'SharmaKunal14', status: 'active' },
    });
  });

  it('rejects a malformed callback state before invoking the broker', async () => {
    const dependency = dependencies();
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'predictable',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an invalid or unauthorized state before invoking the broker', async () => {
    const repository = new FakeRepository();
    repository.validateGithubInstallStateMock.mockRejectedValueOnce(
      new DomainError(
        'GITHUB_INSTALLATION_STATE_INVALID',
        'The GitHub installation link is invalid or expired.',
        409,
      ),
    );
    const dependency = dependencies(repository);
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(409);
    expect(verify).not.toHaveBeenCalled();
    expect(repository.completeGithubInstallationMock).not.toHaveBeenCalled();
  });
});
