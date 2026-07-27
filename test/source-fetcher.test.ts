import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  MigrationSourceFetcherConfig,
  SourceFetcherConfig,
} from '@migration/config';

import {
  acquireMigrationRepository,
  acquireRepository,
} from '../workers/source-fetcher/src/main.js';

const temporaryDirectories: string[] = [];
const organisationId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const repositoryId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const repositoryScanId = '12a906c7-f7df-4c65-9137-70bcf17eec86';
const commitSha = 'a'.repeat(40);

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })),
  );
});

describe('trusted source fetcher', () => {
  it('acquires one exact commit without returning or persisting the token', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'migration-api-fetcher-'));
    temporaryDirectories.push(workspace);
    const snapshotWrites: unknown[] = [];
    const fetchMock = vi.fn<typeof globalThis.fetch>(async input => {
      const url = requestUrl(input);
      if (url.includes('/commits/')) {
        return new Response(JSON.stringify({ sha: commitSha }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.startsWith('https://api.github.com/repos/')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/acme/widgets/legacy.tar.gz/${commitSha}`,
          },
        });
      }
      return new Response(
        Uint8Array.from(
          await githubArchive(
            JSON.stringify({
              dependencies: { '@orbitchat/sdk': '^1.0.0' },
            }),
          ),
        ),
        { status: 200 },
      );
    });
    const dependency = {
      lambda: {
        send: vi.fn(() =>
          Promise.resolve({
            Payload: Buffer.from(
              JSON.stringify({
                token: 'github-installation-token-never-persisted',
                expiresAt: '2026-07-26T01:00:00.000Z',
                githubRepositoryId: '67890',
                owner: 'acme',
                name: 'widgets',
                defaultBranch: 'main',
              }),
            ),
          }),
        ),
      },
      s3: {
        send: vi.fn(command => {
          snapshotWrites.push(command);
          return Promise.resolve({});
        }),
      },
      fetch: fetchMock,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    } as unknown as Parameters<typeof acquireRepository>[1];

    const result = await acquireRepository(config(workspace), dependency);

    expect(result.status).toBe('succeeded');
    expect(result.snapshot?.commitSha).toBe(commitSha);
    expect(result.inventory?.observations).toEqual([
      expect.objectContaining({
        packageName: '@orbitchat/sdk',
        declaredRange: '^1.0.0',
        resolvedVersion: null,
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('github-installation-token');
    expect(snapshotWrites).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects an archive redirect outside the fixed codeload origin', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'migration-api-fetcher-'));
    temporaryDirectories.push(workspace);
    const fetchMock = vi.fn<typeof globalThis.fetch>(input => {
      const url = requestUrl(input);
      if (url.includes('/commits/')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: commitSha }), { status: 200 }),
        );
      }
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example/archive.tar.gz' },
        }),
      );
    });
    const s3Send = vi.fn();
    const dependency = {
      lambda: {
        send: vi.fn(() =>
          Promise.resolve({
            Payload: Buffer.from(
              JSON.stringify({
                token: 'github-installation-token-never-persisted',
                expiresAt: '2026-07-26T01:00:00.000Z',
                githubRepositoryId: '67890',
                owner: 'acme',
                name: 'widgets',
                defaultBranch: 'main',
              }),
            ),
          }),
        ),
      },
      s3: { send: s3Send },
      fetch: fetchMock,
      now: () => new Date('2026-07-26T00:00:00.000Z'),
    } as unknown as Parameters<typeof acquireRepository>[1];

    await expect(acquireRepository(config(workspace), dependency)).resolves.toEqual(
      expect.objectContaining({
        status: 'failed',
        safeErrorCode: 'GITHUB_ARCHIVE_REDIRECT_INVALID',
        snapshot: null,
      }),
    );
    expect(s3Send).not.toHaveBeenCalled();
  });
});

describe('migration source acquisition', () => {
  it('downloads the approved commit directly and stores it only when its digest matches', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'migration-api-migration-'));
    temporaryDirectories.push(workspace);
    const archive = await githubArchive(
      JSON.stringify({ dependencies: { '@orbitchat/sdk': '1.0.0' } }),
    );
    const digestWorkspace = await mkdtemp(
      join(tmpdir(), 'migration-api-migration-digest-'),
    );
    temporaryDirectories.push(digestWorkspace);
    const digestDependency = migrationDependency(archive, '0'.repeat(64));
    const first = await acquireMigrationRepository(
      migrationConfig(digestWorkspace),
      digestDependency.dependency,
    );
    expect(first.status).toBe('stale');
    const expectedDigest = await normalizedDigest(archive);
    const dependency = migrationDependency(archive, expectedDigest);

    const result = await acquireMigrationRepository(
      migrationConfig(workspace),
      dependency.dependency,
    );

    expect(result.status).toBe('succeeded');
    expect(result.safeErrorCode).toBeNull();
    expect(result.snapshot?.commitSha).toBe(commitSha);
    expect(result.snapshot?.digest).toBe(expectedDigest);
    expect(dependency.fetchMock).toHaveBeenCalledTimes(2);
    expect(requestUrl(dependency.fetchMock.mock.calls[0]![0])).toContain(
      `/tarball/${commitSha}`,
    );
    expect(JSON.stringify(result)).not.toContain('github-installation-token');
  });

  it('fails closed without writing a snapshot when the normalized digest changed', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'migration-api-migration-'));
    temporaryDirectories.push(workspace);
    const archive = await githubArchive('{}');
    const dependency = migrationDependency(archive, 'f'.repeat(64));

    const result = await acquireMigrationRepository(
      migrationConfig(workspace),
      dependency.dependency,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: 'stale',
        safeErrorCode: 'MIGRATION_SNAPSHOT_DIGEST_MISMATCH',
        snapshot: null,
      }),
    );
    expect(dependency.s3Send).not.toHaveBeenCalled();
  });
});

function config(workspace: string): SourceFetcherConfig {
  return {
    ACQUISITION_MODE: 'repository_scan',
    APP_ENVIRONMENT: 'development',
    AWS_REGION: 'ap-southeast-2',
    ARTIFACT_BUCKET: 'artifacts',
    ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
    GITHUB_TOKEN_BROKER_FUNCTION_NAME: 'migration-api-development-github-token-broker',
    ORGANISATION_ID: organisationId,
    REPOSITORY_ID: repositoryId,
    REPOSITORY_SCAN_ID: repositoryScanId,
    WORKSPACE_DIRECTORY: workspace as '/workspace',
  };
}

function migrationConfig(workspace: string): MigrationSourceFetcherConfig {
  return {
    ACQUISITION_MODE: 'migration',
    APP_ENVIRONMENT: 'development',
    AWS_REGION: 'ap-southeast-2',
    APPROVAL_ID: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
    ARTIFACT_BUCKET: 'artifacts',
    ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
    GITHUB_TOKEN_BROKER_FUNCTION_NAME: 'migration-api-development-github-token-broker',
    MIGRATION_RUN_ID: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
    ORGANISATION_ID: organisationId,
    REPOSITORY_ID: repositoryId,
    WORKSPACE_DIRECTORY: workspace as '/workspace',
  };
}

function migrationDependency(
  archive: Buffer,
  snapshotDigest: string,
): {
  dependency: Parameters<typeof acquireMigrationRepository>[1];
  fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  s3Send: ReturnType<typeof vi.fn>;
} {
  const fetchMock = vi.fn<typeof globalThis.fetch>(input => {
    const url = requestUrl(input);
    if (url.startsWith('https://api.github.com/repos/')) {
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/acme/widgets/legacy.tar.gz/${commitSha}`,
          },
        }),
      );
    }
    return Promise.resolve(new Response(Uint8Array.from(archive), { status: 200 }));
  });
  const s3Send = vi.fn(() => Promise.resolve({}));
  const dependency = {
    lambda: {
      send: vi.fn(() =>
        Promise.resolve({
          Payload: Buffer.from(
            JSON.stringify({
              token: 'github-installation-token-never-persisted',
              expiresAt: '2026-07-26T01:00:00.000Z',
              githubRepositoryId: '67890',
              owner: 'acme',
              name: 'widgets',
              commitSha,
              snapshotDigest,
            }),
          ),
        }),
      ),
    },
    s3: { send: s3Send },
    fetch: fetchMock,
    now: () => new Date('2026-07-26T00:00:00.000Z'),
  } as unknown as Parameters<typeof acquireMigrationRepository>[1];
  return { dependency, fetchMock, s3Send };
}

async function normalizedDigest(archive: Buffer): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'migration-api-normalize-'));
  temporaryDirectories.push(workspace);
  const dependency = migrationDependency(archive, '0'.repeat(64));
  const result = await acquireMigrationRepository(
    migrationConfig(workspace),
    dependency.dependency,
  );
  expect(result.status).toBe('stale');
  const { readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(await readFile(join(workspace, 'snapshot.tar.gz')))
    .digest('hex');
}

function githubArchive(packageJson: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.once('end', () => resolve(Buffer.concat(chunks)));
    gzip.once('error', reject);
    pack.once('error', reject);
    pack.pipe(gzip);
    pack.entry(
      {
        name: 'acme-widgets-abcdef/package.json',
        type: 'file',
        size: Buffer.byteLength(packageJson),
      },
      packageJson,
    );
    pack.finalize();
  });
}
