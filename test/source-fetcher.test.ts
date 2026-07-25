import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SourceFetcherConfig } from '@migration/config';

import { acquireRepository } from '../workers/source-fetcher/src/main.js';

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

function config(workspace: string): SourceFetcherConfig {
  return {
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
