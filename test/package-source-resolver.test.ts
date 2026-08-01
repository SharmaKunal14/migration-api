import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '@migration/database';
import { NpmRegistryError } from '@migration/npm-registry';
import {
  handlePackageSourceResolution,
  type ResolverDependencies,
} from '../services/package-source-resolver/src/handler.js';

const mappingId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const workerId = '00000000-0000-4000-8000-000000000003';
const correlationId = '00000000-0000-4000-8000-000000000004';
const now = new Date('2026-08-01T00:00:00.000Z');

function baseDependencies(): ResolverDependencies {
  return {
    config: {
      APP_ENVIRONMENT: 'development',
      AWS_REGION: 'ap-southeast-2',
      ARTIFACT_BUCKET: 'artifact-bucket',
      ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:111122223333:key/test',
      DATABASE_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-2:111122223333:secret:test',
      NPM_REGISTRY_ORIGIN: 'https://registry.npmjs.org',
    },
    database: {} as AppDatabase,
    s3: { send: () => Promise.resolve({}) },
    resolvePackage: () =>
      Promise.resolve({
        packageName: 'typescript',
        latestVersion: '6.0.3',
        deprecated: false,
        registryEtag: '"etag"',
        registryUrl: 'https://registry.npmjs.org/typescript',
        candidates: [
          {
            sourceKind: 'package_registry_release',
            canonicalUrl: 'https://registry.npmjs.org/typescript',
            canonicalDomain: 'registry.npmjs.org',
          },
        ],
      }),
    id: vi.fn().mockReturnValueOnce(workerId).mockReturnValueOnce(correlationId),
    now: () => now,
    claim: () =>
      Promise.resolve([
        { mappingId, packageName: 'typescript', resolutionRunId: runId, attempt: 1 },
      ]),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('package-source resolver service', () => {
  it('writes encrypted evidence before atomically completing the leased mapping', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const send = vi.fn((_command: PutObjectCommand) => Promise.resolve({}));
    const complete = vi.fn(() => Promise.resolve());
    const dependency: ResolverDependencies = {
      ...baseDependencies(),
      s3: { send },
      complete,
    };

    const result = await handlePackageSourceResolution(
      { operation: 'resolve_due' },
      dependency,
      'request-id',
    );

    expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command?.input).toMatchObject({
      Bucket: 'artifact-bucket',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
      ContentType: 'application/json',
    });
    expect(command?.input.Key).toContain(`/mapping/${mappingId}/resolution/${runId}/`);
    expect(command?.input.ChecksumSHA256).toMatch(/^[A-Za-z0-9+/]{43}=$/u);
    expect(complete).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({
        mappingId,
        resolutionRunId: runId,
        workerId,
        latestVersion: '6.0.3',
        latestDeprecated: false,
      }),
    );
  });

  it('records safe registry failures without writing an evidence object', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const send = vi.fn((_command: PutObjectCommand) => Promise.resolve({}));
    const fail = vi.fn(() => Promise.resolve());
    const dependency: ResolverDependencies = {
      ...baseDependencies(),
      s3: { send },
      fail,
      resolvePackage: () =>
        Promise.reject(new NpmRegistryError('NPM_PACKAGE_NOT_FOUND')),
    };

    const result = await handlePackageSourceResolution(
      { operation: 'resolve_due' },
      dependency,
      'request-id',
    );

    expect(result).toEqual({ claimed: 1, succeeded: 0, failed: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({
        mappingId,
        resolutionRunId: runId,
        workerId,
        safeErrorCode: 'NPM_PACKAGE_NOT_FOUND',
      }),
    );
  });

  it('rejects scheduler payload expansion before claiming work', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const claim = vi.fn(() => Promise.resolve([]));
    const dependency: ResolverDependencies = { ...baseDependencies(), claim };

    await expect(
      handlePackageSourceResolution(
        { operation: 'resolve_due', arbitraryUrl: 'https://attacker.example' },
        dependency,
        'request-id',
      ),
    ).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
  });
});
