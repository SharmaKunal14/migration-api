import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { CamelCasePlugin, Kysely, PostgresDialect, sql, type ColumnType } from 'kysely';
import pg from 'pg';
import { z } from 'zod';

import type { OrganisationRole, RunStatus, TerminalCode } from '@migration/domain';

const databaseSecretSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    database: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface AppUserTable {
  id: string;
  authSubject: string;
  displayName: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
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
  bytes: number;
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

export interface Database {
  appUsers: AppUserTable;
  organisations: OrganisationTable;
  organisationMemberships: OrganisationMembershipTable;
  agentRuns: AgentRunTable;
  agentActions: AgentActionTable;
  artifacts: ArtifactTable;
  workflowOutbox: WorkflowOutboxTable;
  apiIdempotencyKeys: ApiIdempotencyKeyTable;
  auditEvents: AuditEventTable;
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
  const credentials = databaseSecretSchema.parse(JSON.parse(response.SecretString));
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
    ssl: { rejectUnauthorized: true },
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
