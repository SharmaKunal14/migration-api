import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { once } from 'node:events';

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  commitShaSchema,
  githubIdSchema,
  repositoryAcquisitionResultSchema,
  type RepositoryAcquisitionResult,
} from '@migration/contracts';
import { parseConfig, sourceFetcherConfigSchema } from '@migration/config';
import { writeLog } from '@migration/observability';
import { InventoryError, inventoryRepository } from '@migration/repository-inventory';
import {
  AcquisitionError,
  normalizeGithubTarball,
} from '@migration/source-acquisition';

const GITHUB_API_ORIGIN = 'https://api.github.com';
const GITHUB_ARCHIVE_ORIGIN = 'https://codeload.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 15_000;
const ARCHIVE_TIMEOUT_MS = 60_000;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const tokenResponseSchema = z
  .object({
    token: z.string().min(20).max(1_024),
    expiresAt: z.iso.datetime(),
    githubRepositoryId: githubIdSchema,
    owner: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    defaultBranch: z.string().min(1).max(255),
  })
  .strict();

const commitResponseSchema = z
  .object({
    sha: commitShaSchema,
  })
  .loose();

interface SourceFetcherDependencies {
  readonly lambda: LambdaClient;
  readonly s3: S3Client;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => Date;
}

async function main(): Promise<void> {
  const config = parseConfig(sourceFetcherConfigSchema);
  const dependencies: SourceFetcherDependencies = {
    lambda: new LambdaClient({ region: config.AWS_REGION }),
    s3: new S3Client({ region: config.AWS_REGION }),
    fetch: globalThis.fetch,
    now: () => new Date(),
  };
  const result = await acquireRepository(config, dependencies);
  const resultKey = resultObjectKey(
    config.APP_ENVIRONMENT,
    config.ORGANISATION_ID,
    config.REPOSITORY_ID,
    config.REPOSITORY_SCAN_ID,
  );
  const body = JSON.stringify(repositoryAcquisitionResultSchema.parse(result));
  if (Buffer.byteLength(body, 'utf8') > MAX_JSON_BYTES) {
    throw new Error('The repository acquisition result exceeds its size limit.');
  }
  await dependencies.s3.send(
    new PutObjectCommand({
      Bucket: config.ARTIFACT_BUCKET,
      Key: resultKey,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': '1.0',
        'repository-scan-id': config.REPOSITORY_SCAN_ID,
      },
    }),
  );
  writeLog(result.status === 'succeeded' ? 'info' : 'warn', {
    event: 'repository_acquisition_result_written',
    organisationId: config.ORGANISATION_ID,
    repositoryId: config.REPOSITORY_ID,
    repositoryScanId: config.REPOSITORY_SCAN_ID,
    outcome: result.status,
    safeErrorCode: result.safeErrorCode ?? undefined,
  });
}

export async function acquireRepository(
  config: z.infer<typeof sourceFetcherConfigSchema>,
  dependency: SourceFetcherDependencies,
): Promise<RepositoryAcquisitionResult> {
  await mkdir(config.WORKSPACE_DIRECTORY, { recursive: true });
  const inputPath = `${config.WORKSPACE_DIRECTORY}/source.tar.gz`;
  const outputPath = `${config.WORKSPACE_DIRECTORY}/snapshot.tar.gz`;
  try {
    const access = await issueReadToken(config, dependency.lambda);
    const commit = await githubJson(
      dependency.fetch,
      `/repositories/${access.githubRepositoryId}/commits/${encodeURIComponent(
        access.defaultBranch,
      )}`,
      access.token,
      commitResponseSchema,
    );
    await downloadGithubArchive(
      dependency.fetch,
      access.owner,
      access.name,
      commit.sha,
      access.token,
      inputPath,
    );
    const normalized = await normalizeGithubTarball(inputPath, outputPath);
    const inventory = inventoryRepository(normalized.inventoryFiles);
    if (inventory.manifests.length === 0) {
      throw new AcquisitionError('MISSING_SUPPORTED_MANIFEST');
    }
    const snapshotKey = snapshotObjectKey(
      config.APP_ENVIRONMENT,
      config.ORGANISATION_ID,
      config.REPOSITORY_ID,
      config.REPOSITORY_SCAN_ID,
      commit.sha,
    );
    await dependency.s3.send(
      new PutObjectCommand({
        Bucket: config.ARTIFACT_BUCKET,
        Key: snapshotKey,
        Body: createReadStream(outputPath),
        ContentLength: normalized.bytes,
        ContentType: 'application/gzip',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
        Metadata: {
          digest: normalized.digest,
          'repository-scan-id': config.REPOSITORY_SCAN_ID,
          'commit-sha': commit.sha,
        },
      }),
    );
    return repositoryAcquisitionResultSchema.parse({
      schemaVersion: '1.0',
      organisationId: config.ORGANISATION_ID,
      repositoryId: config.REPOSITORY_ID,
      repositoryScanId: config.REPOSITORY_SCAN_ID,
      status: 'succeeded',
      safeErrorCode: null,
      snapshot: {
        commitSha: commit.sha,
        objectKey: snapshotKey,
        digest: normalized.digest,
        bytes: normalized.bytes,
        fileCount: normalized.fileCount,
        expiresAt: new Date(
          dependency.now().getTime() + SNAPSHOT_RETENTION_MS,
        ).toISOString(),
      },
      inventory,
    });
  } catch (error) {
    const failure = classifyFailure(error);
    return repositoryAcquisitionResultSchema.parse({
      schemaVersion: '1.0',
      organisationId: config.ORGANISATION_ID,
      repositoryId: config.REPOSITORY_ID,
      repositoryScanId: config.REPOSITORY_SCAN_ID,
      status: failure.status,
      safeErrorCode: failure.safeErrorCode,
      snapshot: null,
      inventory: null,
    });
  }
}

async function issueReadToken(
  config: z.infer<typeof sourceFetcherConfigSchema>,
  lambda: LambdaClient,
): Promise<z.infer<typeof tokenResponseSchema>> {
  let response;
  try {
    response = await lambda.send(
      new InvokeCommand({
        FunctionName: config.GITHUB_TOKEN_BROKER_FUNCTION_NAME,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(
          JSON.stringify({
            operation: 'issue_repository_read_token',
            repositoryScanId: config.REPOSITORY_SCAN_ID,
            repositoryId: config.REPOSITORY_ID,
          }),
        ),
      }),
    );
  } catch {
    throw new SourceFetcherError('TOKEN_BROKER_FAILED');
  }
  if (response.FunctionError || !response.Payload) {
    throw new SourceFetcherError('TOKEN_BROKER_FAILED');
  }
  try {
    return tokenResponseSchema.parse(
      JSON.parse(Buffer.from(response.Payload).toString('utf8')),
    );
  } catch {
    throw new SourceFetcherError('TOKEN_BROKER_RESPONSE_INVALID');
  }
}

async function githubJson<T>(
  fetchImplementation: typeof globalThis.fetch,
  path: string,
  token: string,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImplementation(`${GITHUB_API_ORIGIN}${path}`, {
      method: 'GET',
      headers: githubHeaders(token),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SourceFetcherError('GITHUB_REQUEST_FAILED');
  }
  if (!response.ok) throw new SourceFetcherError('GITHUB_REQUEST_REJECTED');
  const bytes = await readBounded(response, MAX_JSON_BYTES);
  try {
    return schema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    throw new SourceFetcherError('GITHUB_RESPONSE_INVALID');
  }
}

async function downloadGithubArchive(
  fetchImplementation: typeof globalThis.fetch,
  owner: string,
  name: string,
  commitSha: string,
  token: string,
  destination: string,
): Promise<void> {
  let redirect: Response;
  try {
    redirect = await fetchImplementation(
      `${GITHUB_API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
        name,
      )}/tarball/${commitSha}`,
      {
        method: 'GET',
        headers: githubHeaders(token),
        redirect: 'manual',
        signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
      },
    );
  } catch {
    throw new SourceFetcherError('GITHUB_REQUEST_FAILED');
  }
  if (![301, 302, 307, 308].includes(redirect.status)) {
    throw new SourceFetcherError('GITHUB_ARCHIVE_REDIRECT_INVALID');
  }
  const location = redirect.headers.get('location');
  let archiveUrl: URL;
  try {
    archiveUrl = new URL(location ?? '');
  } catch {
    throw new SourceFetcherError('GITHUB_ARCHIVE_REDIRECT_INVALID');
  }
  if (
    archiveUrl.origin !== GITHUB_ARCHIVE_ORIGIN ||
    archiveUrl.username ||
    archiveUrl.password
  ) {
    throw new SourceFetcherError('GITHUB_ARCHIVE_REDIRECT_INVALID');
  }
  let response: Response;
  try {
    response = await fetchImplementation(archiveUrl, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(ARCHIVE_TIMEOUT_MS),
    });
  } catch {
    throw new SourceFetcherError('GITHUB_ARCHIVE_DOWNLOAD_FAILED');
  }
  if (!response.ok) throw new SourceFetcherError('GITHUB_ARCHIVE_DOWNLOAD_FAILED');
  const contentLengthHeader = response.headers.get('content-length');
  const contentLength =
    contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  if (
    contentLength !== undefined &&
    (!Number.isFinite(contentLength) ||
      contentLength < 1 ||
      contentLength > MAX_COMPRESSED_BYTES)
  ) {
    throw new SourceFetcherError('ARCHIVE_COMPRESSED_LIMIT_EXCEEDED');
  }
  const bytes = await readBounded(response, MAX_COMPRESSED_BYTES);
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  output.end(bytes);
  await once(output, 'finish');
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new SourceFetcherError('GITHUB_RESPONSE_INVALID');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SourceFetcherError('ARCHIVE_COMPRESSED_LIMIT_EXCEEDED');
    }
    chunks.push(value);
  }
  if (total === 0) throw new SourceFetcherError('GITHUB_RESPONSE_INVALID');
  return Buffer.concat(chunks, total);
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'user-agent': 'migration-api',
    'x-github-api-version': GITHUB_API_VERSION,
  };
}

class SourceFetcherError extends Error {
  public constructor(public readonly safeCode: string) {
    super('Repository acquisition failed.');
    this.name = 'SourceFetcherError';
  }
}

function classifyFailure(error: unknown): {
  readonly status: 'unsupported' | 'failed';
  readonly safeErrorCode: string;
} {
  if (error instanceof AcquisitionError || error instanceof InventoryError) {
    return { status: 'unsupported', safeErrorCode: error.safeCode };
  }
  if (error instanceof SourceFetcherError) {
    return { status: 'failed', safeErrorCode: error.safeCode };
  }
  return { status: 'failed', safeErrorCode: 'SOURCE_FETCHER_FAILED' };
}

export function resultObjectKey(
  environment: string,
  organisationId: string,
  repositoryId: string,
  scanId: string,
): string {
  return `env/${environment}/org/${organisationId}/repository/${repositoryId}/scan/${scanId}/result.json`;
}

export function snapshotObjectKey(
  environment: string,
  organisationId: string,
  repositoryId: string,
  scanId: string,
  commitSha: string,
): string {
  return `env/${environment}/org/${organisationId}/repository/${repositoryId}/scan/${scanId}/snapshot/${commitSha}.tar.gz`;
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
