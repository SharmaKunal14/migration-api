import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { Context } from 'aws-lambda';
import { SignJWT } from 'jose';
import { z } from 'zod';

import { githubIdSchema, uuidSchema } from '@migration/contracts';
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
]);

const installationResponseSchema = z
  .object({
    id: z.number().int().positive(),
    account: z
      .object({
        id: z.number().int().positive(),
        login: z.string().min(1).max(255),
        type: z.enum(['Organization', 'User']),
      })
      .loose(),
    suspended_at: z.string().nullable(),
  })
  .loose();

const tokenResponseSchema = z
  .object({
    token: z.string().min(20).max(1_024),
    expires_at: z.iso.datetime(),
  })
  .loose();

interface RepositoryAccess {
  readonly githubInstallationId: string;
  readonly githubRepositoryId: string;
}

interface BrokerDependencies {
  readonly appId: string;
  readonly privateKey: string;
  readonly lookupRepositoryAccess: (
    repositoryScanId: string,
    repositoryId: string,
  ) => Promise<RepositoryAccess>;
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
    const installation = await githubRequest(
      dependency.fetch,
      `/app/installations/${command.installationId}`,
      appJwt,
      { method: 'GET' },
      installationResponseSchema,
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

  const access = await dependency.lookupRepositoryAccess(
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
  return { token: token.token, expiresAt: token.expires_at };
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
    .select(['installation.githubInstallationId', 'repository.githubRepositoryId'])
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
    return schema.parse(await response.json());
  } catch {
    throw new BrokerError('GITHUB_RESPONSE_INVALID');
  }
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
