import { PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppDatabase } from '@migration/database';
import { NpmRegistryError } from '@migration/npm-registry';
import {
  handlePackageReleasePolling,
  type PackageReleasePollerDependencies,
} from '../services/package-release-poller/src/handler.js';

const sourceId = '00000000-0000-4000-8000-000000000011';
const productId = '00000000-0000-4000-8000-000000000012';
const pollRunId = '00000000-0000-4000-8000-000000000013';
const workerId = '00000000-0000-4000-8000-000000000014';
const correlationId = '00000000-0000-4000-8000-000000000015';
function baseDependencies(): PackageReleasePollerDependencies {
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
    pollPackage: () =>
      Promise.resolve({
        status: 'modified',
        packageName: 'typescript',
        latestVersion: '6.0.3',
        latestDeprecated: false,
        publishedAt: '2026-08-01T01:02:03.000Z',
        registryEtag: '"etag"',
        responseDigest:
          '99e1c121ad6bfc91f5554cb55b5b5fa5e5d40169ea584ad4e5024a43ff5f662f',
        responseBody: new TextEncoder().encode('{"name":"typescript"}'),
      }),
    id: vi.fn().mockReturnValueOnce(workerId).mockReturnValueOnce(correlationId),
    claim: () =>
      Promise.resolve([
        {
          sourceId,
          apiProductId: productId,
          packageName: 'typescript',
          canonicalUrl: 'https://registry.npmjs.org/typescript',
          pollRunId,
          previousEtag: '"old-etag"',
          previousVersion: '5.9.0',
        },
      ]),
    complete: () => Promise.resolve(),
    fail: () => Promise.resolve(false),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('package release poller', () => {
  it('persists encrypted evidence and one logical newer release', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const send = vi.fn((_command: PutObjectCommand) => Promise.resolve({}));
    const complete = vi.fn(() => Promise.resolve());
    const dependency = { ...baseDependencies(), s3: { send }, complete };

    const result = await handlePackageReleasePolling(
      { operation: 'poll_due' },
      dependency,
      'request-id',
    );

    expect(result).toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
      releasesDetected: 1,
      inconsistencies: 0,
    });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutObjectCommand);
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: 'artifact-bucket',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
    });
    expect(complete).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({
        sourceId,
        pollRunId,
        workerId,
        outcome: 'release_detected',
        observedVersion: '6.0.3',
        metadataDigest:
          '99e1c121ad6bfc91f5554cb55b5b5fa5e5d40169ea584ad4e5024a43ff5f662f',
      }),
    );
  });

  it('completes an ETag 304 without creating another evidence object', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const send = vi.fn((_command: PutObjectCommand) => Promise.resolve({}));
    const complete = vi.fn(() => Promise.resolve());
    const dependency: PackageReleasePollerDependencies = {
      ...baseDependencies(),
      s3: { send },
      complete,
      pollPackage: () =>
        Promise.resolve({ status: 'not_modified', registryEtag: '"old-etag"' }),
    };

    await handlePackageReleasePolling(
      { operation: 'poll_due' },
      dependency,
      'request-id',
    );

    expect(send).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({
        outcome: 'not_modified',
        evidenceObjectKey: null,
        observedVersion: null,
      }),
    );
  });

  it('records a latest-tag rollback as an inconsistency without deleting history', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const complete = vi.fn(() => Promise.resolve());
    const dependency: PackageReleasePollerDependencies = {
      ...baseDependencies(),
      claim: () =>
        Promise.resolve([
          {
            sourceId,
            apiProductId: productId,
            packageName: 'typescript',
            canonicalUrl: 'https://registry.npmjs.org/typescript',
            pollRunId,
            previousEtag: '"newer-etag"',
            previousVersion: '7.0.0',
          },
        ]),
      complete,
    };

    const result = await handlePackageReleasePolling(
      { operation: 'poll_due' },
      dependency,
      'request-id',
    );

    expect(result.inconsistencies).toBe(1);
    expect(result.releasesDetected).toBe(0);
    expect(complete).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({ outcome: 'inconsistent' }),
    );
  });

  it('records one source failure without preventing the next source', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const secondSourceId = '00000000-0000-4000-8000-000000000021';
    const secondRunId = '00000000-0000-4000-8000-000000000022';
    const complete = vi.fn(() => Promise.resolve());
    const fail = vi.fn(() => Promise.resolve(true));
    const dependency: PackageReleasePollerDependencies = {
      ...baseDependencies(),
      claim: () =>
        Promise.resolve([
          {
            sourceId,
            apiProductId: productId,
            packageName: 'typescript',
            canonicalUrl: 'https://registry.npmjs.org/typescript',
            pollRunId,
            previousEtag: null,
            previousVersion: '5.9.0',
          },
          {
            sourceId: secondSourceId,
            apiProductId: productId,
            packageName: 'typescript',
            canonicalUrl: 'https://registry.npmjs.org/typescript',
            pollRunId: secondRunId,
            previousEtag: null,
            previousVersion: '5.9.0',
          },
        ]),
      pollPackage: vi
        .fn()
        .mockRejectedValueOnce(new NpmRegistryError('NPM_REGISTRY_TIMEOUT'))
        .mockResolvedValueOnce({
          status: 'modified',
          packageName: 'typescript',
          latestVersion: '6.0.3',
          latestDeprecated: false,
          publishedAt: null,
          registryEtag: null,
          responseDigest:
            '99e1c121ad6bfc91f5554cb55b5b5fa5e5d40169ea584ad4e5024a43ff5f662f',
          responseBody: new TextEncoder().encode('{"name":"typescript"}'),
        }),
      complete,
      fail,
    };

    const result = await handlePackageReleasePolling(
      { operation: 'poll_due' },
      dependency,
      'request-id',
    );

    expect(result).toMatchObject({ claimed: 2, succeeded: 1, failed: 1 });
    expect(fail).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({
        sourceId,
        safeErrorCode: 'NPM_REGISTRY_TIMEOUT',
        retryable: true,
      }),
    );
    expect(complete).toHaveBeenCalledWith(
      dependency.database,
      expect.objectContaining({ sourceId: secondSourceId }),
    );
  });

  it('rejects scheduler payload expansion before claiming work', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const claim = vi.fn(() => Promise.resolve([]));
    const dependency = { ...baseDependencies(), claim };

    await expect(
      handlePackageReleasePolling(
        { operation: 'poll_due', url: 'https://attacker.example' },
        dependency,
        'request-id',
      ),
    ).rejects.toThrow();
    expect(claim).not.toHaveBeenCalled();
  });
});
