import { createHash } from 'node:crypto';

import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  vendorIngestionResultSchema,
  vendorIngestionWorkflowInputSchema,
} from '@migration/contracts';
import {
  isPublicIpAddress,
  retrieveVendorSource,
  VendorEvidenceError,
  type VendorRetrievalDependencies,
} from '@migration/vendor-intelligence';

import {
  bundleObjectKey,
  readDetectedRegistryEvidence,
  resultObjectKey,
  sourceObjectKey,
} from '../workers/vendor-fetcher/src/main.js';

const detectedSourceId = '5bbb0741-98ec-4104-b19f-58ae8fc8b67f';
const detectedPollRunId = '40ade5b7-e4c9-438f-90a2-4a1fb93c8124';
const detectedObjectKey =
  `env/development/package-release/npm/source/${detectedSourceId}` +
  `/poll/${detectedPollRunId}/metadata.json`;

function registryEvidenceClient(
  body: Uint8Array,
  digest: string,
  overrides: Readonly<Record<string, unknown>> = {},
): { readonly client: S3Client; readonly send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue({
    ContentLength: body.byteLength,
    ContentType: 'application/json',
    Metadata: { digest, 'source-id': detectedSourceId },
    ChecksumSHA256: Buffer.from(digest, 'hex').toString('base64'),
    Body: { transformToByteArray: vi.fn().mockResolvedValue(body) },
    ...overrides,
  });
  return { client: { send } as unknown as S3Client, send };
}

const source = {
  sourceKey: 'migration_guide',
  canonicalUrl:
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/MIGRATION.md',
  expectedMediaTypes: ['text/plain', 'text/markdown'],
  allowedDomains: new Set(['raw.githubusercontent.com', 'github.com']),
} as const;

function dependencies(
  responses: readonly {
    status: number;
    location?: string;
    mediaType?: string;
    bytes?: string;
  }[],
): VendorRetrievalDependencies {
  let index = 0;
  return {
    resolve: vi.fn().mockResolvedValue(['185.199.108.133']),
    request: vi.fn().mockImplementation(() => {
      const response = responses[index];
      index += 1;
      if (!response) throw new Error('Unexpected request.');
      return Promise.resolve({
        status: response.status,
        location: response.location ?? null,
        mediaType: response.mediaType ?? null,
        etag: null,
        bytes: Buffer.from(response.bytes ?? ''),
      });
    }),
  };
}

describe('Stage 3B vendor retrieval', () => {
  it('retrieves bounded evidence through a DNS-pinned public address', async () => {
    const result = await retrieveVendorSource(
      source,
      dependencies([
        {
          status: 200,
          mediaType: 'text/plain; charset=utf-8',
          bytes: 'migration evidence',
        },
      ]),
    );

    expect(result).toMatchObject({
      canonicalUrl: source.canonicalUrl,
      finalUrl: source.canonicalUrl,
      mediaType: 'text/plain',
      digest: 'cfc2d8d8538618e121d21c6d12c0c82cf56f86ce95236a81eddb23bac754d856',
    });
  });

  it('revalidates an allowlisted redirect and its DNS result', async () => {
    const request = dependencies([
      {
        status: 302,
        location: 'https://github.com/SharmaKunal14/orbitchat-sdk',
      },
      {
        status: 200,
        mediaType: 'text/markdown',
        bytes: 'evidence',
      },
    ]);

    const result = await retrieveVendorSource(source, request);

    expect(result.finalUrl).toBe('https://github.com/SharmaKunal14/orbitchat-sdk');
    expect(request.resolve).toHaveBeenCalledTimes(2);
  });

  it.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
    'invalid',
  ])('rejects non-public address %s', address => {
    expect(isPublicIpAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    address => {
      expect(isPublicIpAddress(address)).toBe(true);
    },
  );

  it('fails closed when any DNS answer is private', async () => {
    const request = {
      ...dependencies([]),
      resolve: vi.fn().mockResolvedValue(['185.199.108.133', '169.254.169.254']),
    };

    await expect(retrieveVendorSource(source, request)).rejects.toMatchObject({
      safeCode: 'VENDOR_SOURCE_ADDRESS_REJECTED',
    });
    expect(request.request).not.toHaveBeenCalled();
  });

  it('prefers IPv4 when both public address families are returned', async () => {
    const request = {
      ...dependencies([{ status: 200, mediaType: 'text/plain', bytes: 'evidence' }]),
      resolve: vi.fn().mockResolvedValue(['2606:50c0:8000::154', '185.199.108.133']),
    };

    await retrieveVendorSource(source, request);

    expect(request.request).toHaveBeenCalledWith(
      expect.any(URL),
      '185.199.108.133',
      1024 * 1024,
    );
  });

  it.each([
    {
      response: { status: 302, location: 'https://example.com/escape' },
      code: 'VENDOR_SOURCE_URL_REJECTED',
    },
    {
      response: {
        status: 200,
        mediaType: 'application/octet-stream',
        bytes: 'evidence',
      },
      code: 'VENDOR_SOURCE_MEDIA_TYPE_REJECTED',
    },
    {
      response: { status: 404, mediaType: 'text/plain', bytes: 'missing' },
      code: 'VENDOR_SOURCE_REQUEST_REJECTED',
    },
    {
      response: { status: 200, mediaType: 'text/plain', bytes: '' },
      code: 'VENDOR_SOURCE_EMPTY',
    },
    {
      response: {
        status: 200,
        mediaType: 'text/plain',
        bytes: 'x'.repeat(1024 * 1024 + 1),
      },
      code: 'VENDOR_SOURCE_SIZE_REJECTED',
    },
  ])('rejects unsafe response as $code', async ({ response, code }) => {
    await expect(
      retrieveVendorSource(source, dependencies([response])),
    ).rejects.toMatchObject({ safeCode: code });
  });

  it('limits redirect depth', async () => {
    const redirect = {
      status: 302,
      location: source.canonicalUrl,
    };
    await expect(
      retrieveVendorSource(
        source,
        dependencies([redirect, redirect, redirect, redirect]),
      ),
    ).rejects.toMatchObject({
      safeCode: 'VENDOR_SOURCE_REDIRECT_REJECTED',
    });
  });
});

describe('Stage 3B contracts and keys', () => {
  it('accepts identifier-only workflow input', () => {
    expect(
      vendorIngestionWorkflowInputSchema.parse({
        schemaVersion: '1.0',
        vendorReleaseId: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
        correlationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      }),
    ).toBeDefined();
    expect(() =>
      vendorIngestionWorkflowInputSchema.parse({
        schemaVersion: '1.0',
        vendorReleaseId: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
        correlationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        url: 'https://attacker.invalid',
      }),
    ).toThrow();
  });

  it('requires result status, safe error, and bundle to agree', () => {
    const base = {
      schemaVersion: '1.0',
      vendorReleaseId: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
      ingestionRunId: '40ade5b7-e4c9-438f-90a2-4a1fb93c8124',
    } as const;
    expect(
      vendorIngestionResultSchema.parse({
        ...base,
        status: 'failed',
        safeErrorCode: 'VENDOR_SOURCE_TIMEOUT',
        bundle: null,
      }),
    ).toBeDefined();
    expect(() =>
      vendorIngestionResultSchema.parse({
        ...base,
        status: 'succeeded',
        safeErrorCode: null,
        bundle: null,
      }),
    ).toThrow();
  });

  it('builds immutable, environment-scoped artifact keys', () => {
    expect(
      sourceObjectKey(
        'development',
        'orbitchat',
        '16dca0bb-dd7d-4251-8e51-3c34816d5014',
        '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
        '5bbb0741-98ec-4104-b19f-58ae8fc8b67f',
        'a'.repeat(64),
      ),
    ).toContain(`/source/5bbb0741-98ec-4104-b19f-58ae8fc8b67f/${'a'.repeat(64)}`);
    expect(
      bundleObjectKey(
        'development',
        'orbitchat',
        '16dca0bb-dd7d-4251-8e51-3c34816d5014',
        '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
        'b'.repeat(64),
      ),
    ).toContain(`/bundle/${'b'.repeat(64)}.json`);
    expect(
      resultObjectKey(
        'development',
        '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
        '40ade5b7-e4c9-438f-90a2-4a1fb93c8124',
      ),
    ).toContain('/ingestion/40ade5b7-e4c9-438f-90a2-4a1fb93c8124/');
  });

  it('uses safe errors without exposing response content', () => {
    const error = new VendorEvidenceError('VENDOR_SOURCE_REQUEST_REJECTED');
    expect(error.message).toBe('The vendor evidence bundle is invalid.');
  });
});

describe('Stage 8F detected registry evidence', () => {
  const sourceDefinition = {
    id: detectedSourceId,
    sourceKey: 'package_registry',
    canonicalUrl: 'https://registry.npmjs.org/%40types%2Fnode',
    expectedMediaTypes: ['application/json'],
  } as const;
  const releaseRoute = {
    packageIdentifier: '@types/node',
    sourceVersion: '22.0.0',
    targetVersion: '24.0.0',
  } as const;

  function packument(extra: Readonly<Record<string, unknown>> = {}): Uint8Array {
    return Buffer.from(
      JSON.stringify({
        name: releaseRoute.packageIdentifier,
        'dist-tags': { latest: releaseRoute.targetVersion },
        time: { [releaseRoute.targetVersion]: '2026-08-01T00:00:00.000Z' },
        versions: {
          [releaseRoute.sourceVersion]: {
            version: releaseRoute.sourceVersion,
            engines: { node: '>=18' },
          },
          [releaseRoute.targetVersion]: {
            version: releaseRoute.targetVersion,
            engines: { node: '>=22' },
          },
        },
        ...extra,
      }),
      'utf8',
    );
  }

  it('reads only the immutable fixed-origin evidence object and verifies its digest', async () => {
    const body = packument();
    const evidenceDigest = createHash('sha256').update(body).digest('hex');
    const s3 = registryEvidenceClient(body, evidenceDigest);

    const result = await readDetectedRegistryEvidence(
      s3.client,
      'artifacts',
      'development',
      {
        sourceId: detectedSourceId,
        objectKey: detectedObjectKey,
        digest: evidenceDigest,
      },
      sourceDefinition,
      releaseRoute,
    );

    expect(result).toMatchObject({
      canonicalUrl: sourceDefinition.canonicalUrl,
      finalUrl: sourceDefinition.canonicalUrl,
      mediaType: 'application/json',
    });
    expect(result.digest).not.toBe(evidenceDigest);
    expect(JSON.parse(Buffer.from(result.bytes).toString('utf8'))).toMatchObject({
      packageIdentifier: '@types/node',
      sourceVersion: '22.0.0',
      targetVersion: '24.0.0',
      rawEvidenceDigest: evidenceDigest,
      target: { version: '24.0.0', engines: { entries: { node: '>=22' } } },
    });
    expect(s3.send).toHaveBeenCalledOnce();
  });

  it('normalizes a bounded large npm packument into tool-readable evidence', async () => {
    const body = packument({ ignoredPublisherData: 'x'.repeat(2 * 1024 * 1024) });
    const evidenceDigest = createHash('sha256').update(body).digest('hex');
    const s3 = registryEvidenceClient(body, evidenceDigest);

    const result = await readDetectedRegistryEvidence(
      s3.client,
      'artifacts',
      'development',
      {
        sourceId: detectedSourceId,
        objectKey: detectedObjectKey,
        digest: evidenceDigest,
      },
      sourceDefinition,
      releaseRoute,
    );

    expect(body.byteLength).toBeGreaterThan(1024 * 1024);
    expect(result.bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.from(result.bytes).toString('utf8')).not.toContain(
      'ignoredPublisherData',
    );
  });

  it('rejects an object key outside the exact source boundary before reading S3', async () => {
    const body = Buffer.from('{}', 'utf8');
    const evidenceDigest = createHash('sha256').update(body).digest('hex');
    const s3 = registryEvidenceClient(body, evidenceDigest);

    await expect(
      readDetectedRegistryEvidence(
        s3.client,
        'artifacts',
        'development',
        {
          sourceId: detectedSourceId,
          objectKey: 'env/development/package-release/npm/source/other/metadata.json',
          digest: evidenceDigest,
        },
        sourceDefinition,
        releaseRoute,
      ),
    ).rejects.toMatchObject({
      safeCode: 'VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID',
    });
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('rejects metadata or content that does not match the trusted digest', async () => {
    const body = Buffer.from('{}', 'utf8');
    const evidenceDigest = createHash('sha256').update(body).digest('hex');
    const s3 = registryEvidenceClient(body, evidenceDigest, {
      Metadata: { digest: 'a'.repeat(64), 'source-id': detectedSourceId },
    });

    await expect(
      readDetectedRegistryEvidence(
        s3.client,
        'artifacts',
        'development',
        {
          sourceId: detectedSourceId,
          objectKey: detectedObjectKey,
          digest: evidenceDigest,
        },
        sourceDefinition,
        releaseRoute,
      ),
    ).rejects.toMatchObject({
      safeCode: 'VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID',
    });
  });
});
