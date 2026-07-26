import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type ColumnType } from 'kysely';
import pg from 'pg';

import { databaseCredentialSchema } from '@migration/config';
import type { OrganisationRole, RunStatus, TerminalCode } from '@migration/domain';

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AppUserTable {
  id: string;
  authSubject: string;
  displayName: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PlatformOperatorTable {
  userId: string;
  status: 'active' | 'revoked';
  grantedAt: Timestamp;
  revokedAt: Timestamp | null;
  reason: string;
}

export interface PlatformAuditEventTable {
  id: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  metadata: unknown;
  createdAt: Timestamp;
}

export interface OrganisationTable {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'deleting' | 'deleted';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface OrganisationMembershipTable {
  organisationId: string;
  userId: string;
  role: OrganisationRole;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface AgentRunTable {
  id: string;
  organisationId: string;
  requestedByUserId: string;
  scenarioId: 'orbitchat-typescript-v1-v2';
  status: RunStatus;
  terminalCode: TerminalCode | null;
  safeErrorCode: string | null;
  resultArtifactId: string | null;
  requestedModel: string;
  returnedModel: string | null;
  openaiRequestId: string | null;
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  toolCalls: number;
  iterations: number;
  version: number;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  updatedAt: Timestamp;
}

export interface AgentActionTable {
  id: string;
  agentRunId: string;
  sequence: number;
  toolName: string;
  toolVersion: string;
  status: 'started' | 'succeeded' | 'failed' | 'rejected' | 'timed_out';
  inputDigest: string;
  outputDigest: string | null;
  safeErrorCode: string | null;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
}

export interface ArtifactTable {
  id: string;
  organisationId: string;
  ownerType: 'agent_run';
  ownerId: string;
  artifactType: 'vendor_evidence' | 'agent_action' | 'final_result';
  objectKey: string;
  digest: string;
  bytes: ColumnType<string, number, never>;
  mediaType: string;
  createdAt: Timestamp;
  expiresAt: Timestamp | null;
}

export interface WorkflowOutboxTable {
  id: string;
  eventType: 'agent_run.requested';
  aggregateId: string;
  aggregateVersion: number;
  idempotencyKey: string;
  payload: unknown;
  availableAt: Timestamp;
  leaseOwner: string | null;
  leaseExpiresAt: Timestamp | null;
  attempts: number;
  deliveredAt: Timestamp | null;
  safeErrorCode: string | null;
  createdAt: Timestamp;
}

export interface RepositoryScanOutboxTable {
  id: string;
  repositoryScanId: string;
  aggregateVersion: number;
  idempotencyKey: string;
  payload: unknown;
  availableAt: Timestamp;
  leaseOwner: string | null;
  leaseExpiresAt: Timestamp | null;
  attempts: number;
  deliveredAt: Timestamp | null;
  safeErrorCode: string | null;
  createdAt: Timestamp;
}

export interface ApiIdempotencyKeyTable {
  actorId: string;
  action: string;
  idempotencyKey: string;
  requestDigest: string;
  resultResourceId: string;
  createdAt: Timestamp;
  expiresAt: Timestamp;
}

export interface AuditEventTable {
  id: string;
  organisationId: string;
  actorType: 'user' | 'system';
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  metadata: unknown;
  createdAt: Timestamp;
}

export interface GithubInstallationTable {
  id: string;
  organisationId: string;
  githubInstallationId: string;
  githubAccountId: string;
  accountLogin: string;
  accountType: 'Organisation' | 'User';
  status: 'active' | 'suspended' | 'removed';
  suspendedAt: Timestamp | null;
  removedAt: Timestamp | null;
  lastReconciledAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface InstallationLinkStateTable {
  stateDigest: string;
  organisationId: string;
  userId: string;
  expiresAt: Timestamp;
  consumedAt: Timestamp | null;
  returnPath: string;
  createdAt: Timestamp;
}

export interface RepositoryTable {
  id: string;
  organisationId: string;
  installationId: string;
  githubRepositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  visibility: 'public' | 'private' | 'internal';
  selected: boolean;
  archived: boolean;
  enabled: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface GithubWebhookDeliveryTable {
  deliveryId: string;
  eventName: string;
  action: string | null;
  payloadDigest: string;
  processingState: 'received' | 'processing' | 'processed' | 'failed';
  attempts: number;
  safeErrorCode: string | null;
  receivedAt: Timestamp;
  processedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface RepositoryScanTable {
  id: string;
  organisationId: string;
  repositoryId: string;
  requestedCommit: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unsupported';
  triggerSource: 'installation' | 'webhook' | 'manual';
  attempt: number;
  safeErrorCode: string | null;
  version: number;
  createdAt: Timestamp;
  startedAt: Timestamp | null;
  completedAt: Timestamp | null;
  updatedAt: Timestamp;
}

export interface RepositorySnapshotTable {
  id: string;
  organisationId: string;
  repositoryId: string;
  repositoryScanId: string;
  commitSha: string;
  acquisitionPurpose: 'inventory';
  status: 'available' | 'expired' | 'deleted';
  objectKey: string;
  digest: string;
  bytes: ColumnType<string, number, never>;
  fileCount: number;
  expiresAt: Timestamp;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface DependencyObservationTable {
  id: string;
  organisationId: string;
  repositorySnapshotId: string;
  packageName: string;
  dependencyKind: 'dependency' | 'development' | 'optional' | 'peer';
  manifestPath: string;
  lockfilePath: string | null;
  declaredRange: string;
  resolvedVersion: string | null;
  discoveryMethod: 'manifest' | 'npm_lockfile';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface VendorTable {
  id: string;
  slug: string;
  name: string;
  officialDomains: string[];
  trustState: 'draft' | 'trusted' | 'disabled';
  synthetic: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ApiProductTable {
  id: string;
  vendorId: string;
  ecosystem: 'npm';
  canonicalIdentifier: string;
  status: 'active' | 'disabled';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface VendorSourceTable {
  id: string;
  apiProductId: string;
  sourceKey: string;
  sourceKind:
    | 'package_registry_release'
    | 'migration_guide'
    | 'changelog'
    | 'api_definition'
    | 'sdk_repository_release';
  canonicalUrl: string;
  canonicalDomain: string;
  expectedMediaTypes: string[];
  trustState: 'draft' | 'trusted' | 'disabled';
  pollIntervalSeconds: number;
  lastDigest: string | null;
  lastEtag: string | null;
  lastCheckedAt: Timestamp | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface VendorReleaseTable {
  id: string;
  apiProductId: string;
  version: string;
  revision: number;
  publishedAt: Timestamp | null;
  evidenceObjectKey: string | null;
  evidenceDigest: string | null;
  sourceDigest: string;
  processingState: 'registered' | 'fetched' | 'validated' | 'rejected';
  trustState: 'draft' | 'reviewed' | 'vendor_verified';
  createdAt: Timestamp;
}

export interface MigrationSpecificationTable {
  id: string;
  vendorReleaseId: string;
  sourceCompatibility: string;
  targetVersion: string;
  schemaVersion: '1.0';
  specification: unknown;
  evidenceObjectKey: string;
  evidenceDigest: string;
  trustState: 'draft' | 'reviewed' | 'vendor_verified';
  revision: number;
  generatedBy: 'change_intelligence_agent' | 'operator';
  reviewedByUserId: string | null;
  reviewedAt: Timestamp | null;
  createdAt: Timestamp;
}

export interface MigrationCandidateTable {
  id: string;
  organisationId: string;
  repositoryId: string;
  migrationSpecificationId: string;
  dependencyObservationId: string;
  status: 'open' | 'dismissed' | 'superseded' | 'resolved';
  firstDetectedAt: Timestamp;
  lastDetectedAt: Timestamp;
  version: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ImpactReportTable {
  id: string;
  candidateId: string;
  repositoryId: string;
  repositorySnapshotId: string;
  impactAgentRunId: string;
  schemaVersion: '1.0';
  outcome: 'affected' | 'not_affected' | 'inconclusive';
  affectedSummary: unknown;
  riskCategory: 'low' | 'medium' | 'high' | 'unknown';
  verificationAvailability: unknown;
  uncertainty: unknown;
  artifactObjectKey: string;
  artifactDigest: string;
  revision: number;
  createdAt: Timestamp;
}

export interface VendorIngestionRunTable {
  id: string;
  vendorReleaseId: string;
  status: 'running' | 'succeeded' | 'failed';
  attempt: number;
  safeErrorCode: string | null;
  correlationId: string;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  updatedAt: Timestamp;
}

export interface VendorEvidenceItemTable {
  id: string;
  vendorReleaseId: string;
  vendorSourceId: string;
  canonicalUrl: string;
  objectKey: string;
  digest: string;
  bytes: ColumnType<string, number, never>;
  mediaType: string;
  etag: string | null;
  retrievedAt: Timestamp;
  createdAt: Timestamp;
}

export interface ChangeIntelligenceRunTable {
  id: string;
  vendorReleaseId: string;
  evidenceDigest: string;
  status: 'running' | 'succeeded' | 'failed';
  attempt: number;
  safeErrorCode: string | null;
  correlationId: string;
  resultObjectKey: string;
  migrationSpecificationId: string | null;
  requestedModel: string;
  returnedModel: string | null;
  openaiRequestId: string | null;
  modelCalls: number;
  toolCalls: number;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  startedAt: Timestamp;
  completedAt: Timestamp | null;
  updatedAt: Timestamp;
}

export interface Database {
  appUsers: AppUserTable;
  platformOperators: PlatformOperatorTable;
  platformAuditEvents: PlatformAuditEventTable;
  organisations: OrganisationTable;
  organisationMemberships: OrganisationMembershipTable;
  agentRuns: AgentRunTable;
  agentActions: AgentActionTable;
  artifacts: ArtifactTable;
  workflowOutbox: WorkflowOutboxTable;
  repositoryScanOutbox: RepositoryScanOutboxTable;
  apiIdempotencyKeys: ApiIdempotencyKeyTable;
  auditEvents: AuditEventTable;
  githubInstallations: GithubInstallationTable;
  installationLinkStates: InstallationLinkStateTable;
  repositories: RepositoryTable;
  githubWebhookDeliveries: GithubWebhookDeliveryTable;
  repositoryScans: RepositoryScanTable;
  repositorySnapshots: RepositorySnapshotTable;
  dependencyObservations: DependencyObservationTable;
  vendors: VendorTable;
  apiProducts: ApiProductTable;
  vendorSources: VendorSourceTable;
  vendorReleases: VendorReleaseTable;
  migrationSpecifications: MigrationSpecificationTable;
  migrationCandidates: MigrationCandidateTable;
  impactReports: ImpactReportTable;
  vendorIngestionRuns: VendorIngestionRunTable;
  vendorEvidenceItems: VendorEvidenceItemTable;
  changeIntelligenceRuns: ChangeIntelligenceRunTable;
}

export type AppDatabase = Kysely<Database>;

export async function createDatabase(
  region: string,
  secretArn: string,
): Promise<AppDatabase> {
  const secrets = new SecretsManagerClient({ region });
  const response = await secrets.send(
    new GetSecretValueCommand({ SecretId: secretArn, VersionStage: 'AWSCURRENT' }),
  );
  if (!response.SecretString) {
    throw new Error('The database credential secret has no string value.');
  }
  const credentials = databaseCredentialSchema.parse(JSON.parse(response.SecretString));
  const pool = new pg.Pool({
    host: credentials.host,
    port: credentials.port,
    database: credentials.database,
    user: credentials.username,
    password: credentials.password,
    application_name: 'migration-api',
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 10_000,
    max: 1,
    options:
      '-c statement_timeout=5000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=5000',
    ssl: {
      ca: credentials.sslCaCertificate,
      rejectUnauthorized: true,
    },
  });
  pool.on('error', () => {
    // The caller observes query failure; credential and connection details are not logged.
  });
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}

export async function healthCheck(database: AppDatabase): Promise<void> {
  await sql`select 1`.execute(database);
}
