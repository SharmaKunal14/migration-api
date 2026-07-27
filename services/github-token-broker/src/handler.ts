import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Context } from 'aws-lambda';
import { SignJWT } from 'jose';
import { z } from 'zod';

import {
  githubIdSchema,
  githubInstallationInventorySchema,
  githubPublicationAccessSchema,
  githubPublicationAccessResultSchema,
  type GithubInstallationInventory,
  uuidSchema,
} from '@migration/contracts';
import {
  githubAppSecretSchema,
  githubTokenBrokerConfigSchema,
  parseConfig,
  type GithubTokenBrokerConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import { writeLog } from '@migration/observability';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const REPOSITORIES_PER_PAGE = 100;
const MAX_INSTALLATION_REPOSITORIES = 500;

const brokerCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('verify_installation'),
      installationId: githubIdSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('issue_repository_read_token'),
      repositoryScanId: uuidSchema,
      repositoryId: uuidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('issue_migration_repository_read_token'),
      migrationRunId: uuidSchema,
      repositoryId: uuidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('verify_publication_access'),
      migrationRunId: uuidSchema,
      repositoryId: uuidSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('get_installation_inventory'),
      linkedInstallationId: uuidSchema,
    })
    .strict(),
]);

const githubNumberSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const installationResponseSchema = z
  .object({
    id: githubNumberSchema,
    account: z
      .object({
        id: githubNumberSchema,
        login: z.string().min(1).max(255),
        type: z.enum(['Organization', 'User']),
      })
      .loose(),
    suspended_at: z.string().nullable(),
  })
  .loose();

const repositoryResponseSchema = z
  .object({
    id: githubNumberSchema,
    owner: z
      .object({
        login: z.string().min(1).max(255),
      })
      .loose(),
    name: z.string().min(1).max(255),
    full_name: z.string().min(3).max(512),
    default_branch: z.string().min(1).max(255),
    visibility: z.enum(['public', 'private', 'internal']),
    archived: z.boolean(),
  })
  .loose();

const repositoryPageSchema = z
  .object({
    total_count: z.number().int().nonnegative(),
    repositories: z.array(repositoryResponseSchema).max(REPOSITORIES_PER_PAGE),
  })
  .loose();

const tokenResponseSchema = z
  .object({
    token: z.string().min(20).max(1_024),
    expires_at: z.iso.datetime(),
  })
  .loose();

const gitReferenceResponseSchema = z
  .object({
    object: z
      .object({
        sha: z.string().regex(/^[a-f0-9]{40}$/u),
      })
      .loose(),
  })
  .loose();

interface RepositoryAccess {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
}

interface MigrationRepositoryAccess extends RepositoryAccess {
  readonly commitSha: string;
  readonly snapshotDigest: string;
}

interface PublicationRepositoryAccess extends RepositoryAccess {
  readonly baseCommitSha: string;
}

interface InstallationAccess {
  readonly githubInstallationId: string;
  readonly githubAccountId: string;
  readonly accountLogin: string;
  readonly accountType: 'Organisation' | 'User';
}

interface BrokerDependencies {
  readonly appId: string;
  readonly privateKey: string;
  readonly lookupRepositoryAccess: (
    repositoryScanId: string,
    repositoryId: string,
  ) => Promise<RepositoryAccess>;
  readonly lookupMigrationRepositoryAccess: (
    migrationRunId: string,
    repositoryId: string,
  ) => Promise<MigrationRepositoryAccess>;
  readonly lookupPublicationRepositoryAccess: (
    migrationRunId: string,
    repositoryId: string,
  ) => Promise<PublicationRepositoryAccess>;
  readonly lookupInstallationAccess: (
    linkedInstallationId: string,
  ) => Promise<InstallationAccess>;
  readonly fetch: typeof globalThis.fetch;
  readonly now?: () => Date;
}

let cachedDependencies: BrokerDependencies | undefined;

async function dependencies(): Promise<BrokerDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(githubTokenBrokerConfigSchema);
  const secret = await readAppSecret(config);
  const database = await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN);
  cachedDependencies = {
    appId: secret.appId,
    privateKey: secret.privateKey,
    lookupRepositoryAccess: (scanId, repositoryId): Promise<RepositoryAccess> =>
      lookupRepositoryAccess(database, scanId, repositoryId),
    lookupMigrationRepositoryAccess: (
      migrationRunId,
      repositoryId,
    ): Promise<MigrationRepositoryAccess> =>
      lookupMigrationRepositoryAccess(database, migrationRunId, repositoryId),
    lookupPublicationRepositoryAccess: (
      migrationRunId,
      repositoryId,
    ): Promise<PublicationRepositoryAccess> =>
      lookupPublicationRepositoryAccess(database, migrationRunId, repositoryId),
    lookupInstallationAccess: (linkedInstallationId): Promise<InstallationAccess> =>
      lookupInstallationAccess(database, linkedInstallationId),
    fetch: globalThis.fetch,
  };
  return cachedDependencies;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  return handleBrokerCommand(event, context.awsRequestId, await dependencies());
}

export async function handleBrokerCommand(
  event: unknown,
  requestId: string,
  dependency: BrokerDependencies,
): Promise<unknown> {
  const command = brokerCommandSchema.parse(event);
  const appJwt = await createAppJwt(
    dependency.appId,
    dependency.privateKey,
    dependency.now?.() ?? new Date(),
  );

  if (command.operation === 'verify_installation') {
    const installation = await verifyInstallation(
      dependency.fetch,
      command.installationId,
      appJwt,
    );
    writeLog('info', {
      event: 'github_installation_verified',
      requestId,
      outcome: installation.suspended_at ? 'suspended' : 'active',
    });
    return {
      installationId: String(installation.id),
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
      accountType:
        installation.account.type === 'Organization' ? 'Organisation' : 'User',
      status: installation.suspended_at ? 'suspended' : 'active',
    };
  }

  if (command.operation === 'get_installation_inventory') {
    const access = await dependency.lookupInstallationAccess(
      command.linkedInstallationId,
    );
    const installationId = githubIdSchema.parse(access.githubInstallationId);
    const inventory = await getInstallationInventory(
      dependency.fetch,
      { ...access, githubInstallationId: installationId },
      appJwt,
    );
    writeLog('info', {
      event: 'github_installation_inventory_retrieved',
      requestId,
      outcome: String(inventory.repositories.length),
    });
    return inventory;
  }

  if (command.operation === 'verify_publication_access') {
    try {
      const access = await dependency.lookupPublicationRepositoryAccess(
        command.migrationRunId,
        command.repositoryId,
      );
      const installationId = githubIdSchema.parse(access.githubInstallationId);
      const repositoryId = safeGithubNumber(access.githubRepositoryId);
      const token = await githubRequest(
        dependency.fetch,
        `/app/installations/${installationId}/access_tokens`,
        appJwt,
        {
          method: 'POST',
          body: JSON.stringify({
            repository_ids: [repositoryId],
            permissions: {
              contents: 'write',
              pull_requests: 'write',
            },
          }),
        },
        tokenResponseSchema,
      );
      const reference = await githubRequest(
        dependency.fetch,
        publicationReferencePath(access),
        token.token,
        { method: 'GET' },
        gitReferenceResponseSchema,
      );
      writeLog('info', {
        event: 'github_publication_access_verified',
        requestId,
        outcome: 'ready',
      });
      return githubPublicationAccessSchema.parse({
        status: 'ready',
        githubRepositoryId: access.githubRepositoryId,
        owner: access.owner,
        name: access.name,
        baseBranch: access.defaultBranch,
        headCommitSha: reference.object.sha,
      });
    } catch (error) {
      if (!(error instanceof BrokerError)) throw error;
      writeLog('warn', {
        event: 'github_publication_access_denied',
        requestId,
        safeErrorCode: 'GITHUB_PUBLICATION_ACCESS_DENIED',
        outcome: 'denied',
      });
      return githubPublicationAccessResultSchema.parse({
        status: 'denied',
        safeErrorCode: 'GITHUB_PUBLICATION_ACCESS_DENIED',
      });
    }
  }

  const access =
    command.operation === 'issue_migration_repository_read_token'
      ? await dependency.lookupMigrationRepositoryAccess(
          command.migrationRunId,
          command.repositoryId,
        )
      : await dependency.lookupRepositoryAccess(
          command.repositoryScanId,
          command.repositoryId,
        );
  const installationId = githubIdSchema.parse(access.githubInstallationId);
  const repositoryId = safeGithubNumber(access.githubRepositoryId);
  const token = await githubRequest(
    dependency.fetch,
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: 'POST',
      body: JSON.stringify({
        repository_ids: [repositoryId],
        permissions: { contents: 'read' },
      }),
    },
    tokenResponseSchema,
  );
  writeLog('info', {
    event: 'github_repository_read_token_issued',
    requestId,
    outcome: 'issued',
  });
  const migrationFields =
    command.operation === 'issue_migration_repository_read_token'
      ? migrationAccessFields(access)
      : { defaultBranch: access.defaultBranch };
  return {
    token: token.token,
    expiresAt: token.expires_at,
    githubRepositoryId: access.githubRepositoryId,
    owner: access.owner,
    name: access.name,
    ...migrationFields,
  };
}

function migrationAccessFields(
  access: RepositoryAccess | MigrationRepositoryAccess,
): Pick<MigrationRepositoryAccess, 'commitSha' | 'snapshotDigest'> {
  if (!('commitSha' in access)) {
    throw new BrokerError('MIGRATION_REPOSITORY_ACCESS_DENIED');
  }
  return {
    commitSha: access.commitSha,
    snapshotDigest: access.snapshotDigest,
  };
}

async function getInstallationInventory(
  fetchImplementation: typeof globalThis.fetch,
  access: InstallationAccess,
  appJwt: string,
): Promise<GithubInstallationInventory> {
  const installationId = access.githubInstallationId;
  let installation: z.infer<typeof installationResponseSchema>;
  try {
    installation = await verifyInstallation(
      fetchImplementation,
      installationId,
      appJwt,
    );
  } catch (error) {
    if (
      error instanceof BrokerError &&
      error.safeCode === 'GITHUB_INSTALLATION_NOT_FOUND'
    ) {
      return githubInstallationInventorySchema.parse({
        installation: {
          installationId,
          accountId: access.githubAccountId,
          accountLogin: access.accountLogin,
          accountType: access.accountType,
          status: 'removed',
        },
        repositories: [],
      });
    }
    throw error;
  }
  if (installation.suspended_at) {
    return githubInstallationInventorySchema.parse({
      installation: {
        installationId: String(installation.id),
        accountId: String(installation.account.id),
        accountLogin: installation.account.login,
        accountType:
          installation.account.type === 'Organization' ? 'Organisation' : 'User',
        status: 'suspended',
      },
      repositories: [],
    });
  }
  const token = await githubRequest(
    fetchImplementation,
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    {
      method: 'POST',
      body: JSON.stringify({
        permissions: {
          metadata: 'read',
        },
      }),
    },
    tokenResponseSchema,
  );

  const repositories: z.infer<typeof repositoryResponseSchema>[] = [];
  for (let page = 1; repositories.length < MAX_INSTALLATION_REPOSITORIES; page += 1) {
    const response = await githubRequest(
      fetchImplementation,
      `/installation/repositories?per_page=${String(
        REPOSITORIES_PER_PAGE,
      )}&page=${String(page)}`,
      token.token,
      { method: 'GET' },
      repositoryPageSchema,
    );
    if (response.total_count > MAX_INSTALLATION_REPOSITORIES) {
      throw new BrokerError('GITHUB_REPOSITORY_LIMIT_EXCEEDED');
    }
    repositories.push(...response.repositories);
    if (repositories.length >= response.total_count) break;
    if (response.repositories.length === 0) {
      throw new BrokerError('GITHUB_RESPONSE_INVALID');
    }
  }

  return githubInstallationInventorySchema.parse({
    installation: {
      installationId: String(installation.id),
      accountId: String(installation.account.id),
      accountLogin: installation.account.login,
      accountType:
        installation.account.type === 'Organization' ? 'Organisation' : 'User',
      status: 'active',
    },
    repositories: repositories.map(repository => ({
      githubRepositoryId: String(repository.id),
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
      defaultBranch: repository.default_branch,
      visibility: repository.visibility,
      archived: repository.archived,
    })),
  });
}

function verifyInstallation(
  fetchImplementation: typeof globalThis.fetch,
  installationId: string,
  appJwt: string,
): Promise<z.infer<typeof installationResponseSchema>> {
  return githubRequest(
    fetchImplementation,
    `/app/installations/${installationId}`,
    appJwt,
    { method: 'GET' },
    installationResponseSchema,
  );
}

async function readAppSecret(
  config: GithubTokenBrokerConfig,
): Promise<z.infer<typeof githubAppSecretSchema>> {
  const client = new SecretsManagerClient({ region: config.AWS_REGION });
  const response = await client.send(
    new GetSecretValueCommand({
      SecretId: config.GITHUB_APP_SECRET_ARN,
      VersionStage: 'AWSCURRENT',
    }),
  );
  if (!response.SecretString) {
    throw new Error('The GitHub App secret has no string value.');
  }
  return githubAppSecretSchema.parse(JSON.parse(response.SecretString));
}

async function lookupRepositoryAccess(
  database: AppDatabase,
  repositoryScanId: string,
  repositoryId: string,
): Promise<RepositoryAccess> {
  const access = await database
    .selectFrom('repositoryScans as scan')
    .innerJoin('repositories as repository', join =>
      join
        .onRef('repository.id', '=', 'scan.repositoryId')
        .onRef('repository.organisationId', '=', 'scan.organisationId'),
    )
    .innerJoin(
      'githubInstallations as installation',
      'installation.id',
      'repository.installationId',
    )
    .select([
      'installation.githubInstallationId',
      'repository.githubRepositoryId',
      'repository.owner',
      'repository.name',
      'repository.defaultBranch',
    ])
    .where('scan.id', '=', repositoryScanId)
    .where('scan.repositoryId', '=', repositoryId)
    .where('scan.status', 'in', ['queued', 'running'])
    .where('repository.selected', '=', true)
    .where('repository.enabled', '=', true)
    .where('repository.archived', '=', false)
    .where('installation.status', '=', 'active')
    .executeTakeFirst();
  if (!access) {
    throw new BrokerError('REPOSITORY_ACCESS_DENIED');
  }
  return access;
}

async function lookupMigrationRepositoryAccess(
  database: AppDatabase,
  migrationRunId: string,
  repositoryId: string,
): Promise<MigrationRepositoryAccess> {
  const access = await database
    .selectFrom('migrationRuns as run')
    .innerJoin('migrationApprovals as approval', join =>
      join
        .onRef('approval.id', '=', 'run.approvalId')
        .onRef('approval.organisationId', '=', 'run.organisationId')
        .onRef('approval.repositoryId', '=', 'run.repositoryId'),
    )
    .innerJoin('repositories as repository', join =>
      join
        .onRef('repository.id', '=', 'run.repositoryId')
        .onRef('repository.organisationId', '=', 'run.organisationId')
        .onRef('repository.installationId', '=', 'approval.installationId'),
    )
    .innerJoin(
      'githubInstallations as installation',
      'installation.id',
      'repository.installationId',
    )
    .leftJoin(
      'migrationApprovalRevocations as revocation',
      'revocation.approvalId',
      'approval.id',
    )
    .select([
      'installation.githubInstallationId',
      'repository.githubRepositoryId',
      'repository.owner',
      'repository.name',
      'repository.defaultBranch',
      'approval.baseCommitSha as commitSha',
      'approval.snapshotDigest',
    ])
    .where('run.id', '=', migrationRunId)
    .where('run.repositoryId', '=', repositoryId)
    .where('run.status', '=', 'running')
    .where('run.currentStage', '=', 'acquiring')
    .where('run.cancellationRequestedAt', 'is', null)
    .where('repository.selected', '=', true)
    .where('repository.enabled', '=', true)
    .where('repository.archived', '=', false)
    .where('repository.defaultBranch', '=', eb => eb.ref('approval.baseBranch'))
    .where('repository.githubRepositoryId', '=', eb =>
      eb.ref('approval.githubRepositoryId'),
    )
    .where('installation.status', '=', 'active')
    .where('revocation.approvalId', 'is', null)
    .where(eb =>
      eb.or([
        eb('approval.expiresAt', 'is', null),
        eb('approval.expiresAt', '>', new Date()),
      ]),
    )
    .executeTakeFirst();
  if (!access) {
    throw new BrokerError('MIGRATION_REPOSITORY_ACCESS_DENIED');
  }
  return access;
}

async function lookupPublicationRepositoryAccess(
  database: AppDatabase,
  migrationRunId: string,
  repositoryId: string,
): Promise<PublicationRepositoryAccess> {
  const access = await database
    .selectFrom('migrationRuns as run')
    .innerJoin('migrationApprovals as approval', join =>
      join
        .onRef('approval.id', '=', 'run.approvalId')
        .onRef('approval.organisationId', '=', 'run.organisationId')
        .onRef('approval.repositoryId', '=', 'run.repositoryId'),
    )
    .innerJoin('repositories as repository', join =>
      join
        .onRef('repository.id', '=', 'run.repositoryId')
        .onRef('repository.organisationId', '=', 'run.organisationId')
        .onRef('repository.installationId', '=', 'approval.installationId'),
    )
    .innerJoin(
      'githubInstallations as installation',
      'installation.id',
      'repository.installationId',
    )
    .innerJoin('verificationAttempts as verification', join =>
      join
        .onRef('verification.migrationRunId', '=', 'run.id')
        .onRef('verification.organisationId', '=', 'run.organisationId')
        .onRef('verification.approvalId', '=', 'run.approvalId')
        .onRef('verification.baseCommitSha', '=', 'run.baseCommitSha'),
    )
    .innerJoin('verificationAttemptResults as result', join =>
      join
        .onRef('result.verificationAttemptId', '=', 'verification.id')
        .onRef('result.migrationRunId', '=', 'run.id')
        .onRef('result.organisationId', '=', 'run.organisationId')
        .on('result.outcome', '=', 'passed'),
    )
    .leftJoin(
      'migrationApprovalRevocations as revocation',
      'revocation.approvalId',
      'approval.id',
    )
    .select([
      'installation.githubInstallationId',
      'repository.githubRepositoryId',
      'repository.owner',
      'repository.name',
      'repository.defaultBranch',
      'approval.baseCommitSha',
    ])
    .where('run.id', '=', migrationRunId)
    .where('run.repositoryId', '=', repositoryId)
    .where('run.status', '=', 'running')
    .where('run.currentStage', '=', 'publishing')
    .where('run.cancellationRequestedAt', 'is', null)
    .where('repository.selected', '=', true)
    .where('repository.enabled', '=', true)
    .where('repository.archived', '=', false)
    .where('repository.defaultBranch', '=', eb => eb.ref('approval.baseBranch'))
    .where('repository.githubRepositoryId', '=', eb =>
      eb.ref('approval.githubRepositoryId'),
    )
    .where('installation.status', '=', 'active')
    .where('revocation.approvalId', 'is', null)
    .where(eb =>
      eb.or([
        eb('approval.expiresAt', 'is', null),
        eb('approval.expiresAt', '>', new Date()),
      ]),
    )
    .executeTakeFirst();
  if (!access) {
    throw new BrokerError('PUBLICATION_ACCESS_DENIED');
  }
  return access;
}

function publicationReferencePath(access: PublicationRepositoryAccess): string {
  const owner = encodeURIComponent(access.owner);
  const name = encodeURIComponent(access.name);
  const branch = access.defaultBranch
    .split('/')
    .map(component => encodeURIComponent(component))
    .join('/');
  return `/repos/${owner}/${name}/git/ref/heads/${branch}`;
}

async function lookupInstallationAccess(
  database: AppDatabase,
  linkedInstallationId: string,
): Promise<InstallationAccess> {
  const access = await database
    .selectFrom('githubInstallations')
    .select(['githubInstallationId', 'githubAccountId', 'accountLogin', 'accountType'])
    .where('id', '=', linkedInstallationId)
    .executeTakeFirst();
  if (!access) {
    throw new BrokerError('INSTALLATION_ACCESS_DENIED');
  }
  return access;
}

async function createAppJwt(
  appId: string,
  privateKey: string,
  now: Date,
): Promise<string> {
  const epochSeconds = Math.floor(now.getTime() / 1_000);
  const key = createPrivateKey(privateKey);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(appId)
    .setIssuedAt(epochSeconds - 60)
    .setExpirationTime(epochSeconds + 540)
    .sign(key);
}

async function githubRequest<T>(
  fetchImplementation: typeof globalThis.fetch,
  path: string,
  appJwt: string,
  init: Pick<RequestInit, 'method' | 'body'>,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(`${GITHUB_API_ORIGIN}${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${appJwt}`,
        'content-type': 'application/json',
        'user-agent': 'migration-api',
        'x-github-api-version': GITHUB_API_VERSION,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new BrokerError('GITHUB_REQUEST_FAILED');
  }
  if (!response.ok) {
    throw new BrokerError(
      response.status === 404
        ? 'GITHUB_INSTALLATION_NOT_FOUND'
        : 'GITHUB_REQUEST_REJECTED',
    );
  }
  try {
    return schema.parse(await readBoundedJson(response));
  } catch {
    throw new BrokerError('GITHUB_RESPONSE_INVALID');
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new BrokerError('GITHUB_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > MAX_GITHUB_RESPONSE_BYTES) {
      await reader.cancel();
      throw new BrokerError('GITHUB_RESPONSE_TOO_LARGE');
    }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeGithubNumber(value: string): number {
  const parsed = Number(githubIdSchema.parse(value));
  if (!Number.isSafeInteger(parsed)) {
    throw new BrokerError('GITHUB_ID_UNSUPPORTED');
  }
  return parsed;
}

class BrokerError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The GitHub broker operation could not be completed.');
    this.name = 'BrokerError';
  }
}
import { createPrivateKey } from 'node:crypto';
