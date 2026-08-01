/* eslint-disable @typescript-eslint/require-await -- Fetch mocks intentionally implement Promise-returning callbacks. */
import { describe, expect, it, vi } from 'vitest';

import {
  npmRegistrySafeErrorCode,
  resolveNpmPackageMetadata,
} from '@migration/npm-registry';
import type { NpmRegistryError } from '@migration/npm-registry';

function metadataResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...options.headers,
    },
  });
}

async function expectedErrorCode(
  action: () => Promise<unknown>,
  safeCode: NpmRegistryError['safeCode'],
): Promise<void> {
  await expect(action()).rejects.toMatchObject({ safeCode });
}

describe('npm registry resolver', () => {
  it('requests the fixed latest endpoint and returns review-only normalized candidates', async () => {
    const fetch = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      metadataResponse(
        {
          name: '@types/node',
          version: '24.1.0',
          repository: {
            url: 'git+https://github.com/DefinitelyTyped/DefinitelyTyped.git',
          },
          homepage: 'https://github.com/DefinitelyTyped/DefinitelyTyped/',
          bugs: { url: 'https://github.com/DefinitelyTyped/DefinitelyTyped/issues' },
        },
        { headers: { etag: '"registry-etag"' } },
      ),
    );

    const result = await resolveNpmPackageMetadata('@types/node', { fetch });

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://registry.npmjs.org/%40types%2Fnode/latest',
    );
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'manual',
    });
    expect(result).toEqual({
      packageName: '@types/node',
      latestVersion: '24.1.0',
      deprecated: false,
      registryEtag: '"registry-etag"',
      registryUrl: 'https://registry.npmjs.org/%40types%2Fnode',
      candidates: [
        {
          sourceKind: 'package_registry_release',
          canonicalUrl: 'https://registry.npmjs.org/%40types%2Fnode',
          canonicalDomain: 'registry.npmjs.org',
        },
        {
          sourceKind: 'sdk_repository_release',
          canonicalUrl: 'https://github.com/DefinitelyTyped/DefinitelyTyped',
          canonicalDomain: 'github.com',
        },
        {
          sourceKind: 'homepage',
          canonicalUrl: 'https://github.com/DefinitelyTyped/DefinitelyTyped',
          canonicalDomain: 'github.com',
        },
        {
          sourceKind: 'issue_tracker',
          canonicalUrl: 'https://github.com/DefinitelyTyped/DefinitelyTyped/issues',
          canonicalDomain: 'github.com',
        },
      ],
    });
  });

  it('ignores unsafe candidate URLs without failing trusted registry resolution', async () => {
    const result = await resolveNpmPackageMetadata('typescript', {
      fetch: async () =>
        metadataResponse({
          name: 'typescript',
          version: '6.0.3',
          repository: 'git+ssh://git@github.com/microsoft/TypeScript.git',
          homepage: 'https://127.0.0.1/internal',
          bugs: 'https://example.com/issues?token=do-not-store',
        }),
    });

    expect(result.candidates).toEqual([
      {
        sourceKind: 'package_registry_release',
        canonicalUrl: 'https://registry.npmjs.org/typescript',
        canonicalDomain: 'registry.npmjs.org',
      },
    ]);
  });

  it.each([
    ['bad package/name', 'NPM_PACKAGE_NAME_INVALID'],
    ['', 'NPM_PACKAGE_NAME_INVALID'],
  ] as const)('rejects invalid package name %j', async (packageName, safeCode) => {
    await expectedErrorCode(
      () => resolveNpmPackageMetadata(packageName, { fetch: vi.fn() }),
      safeCode,
    );
  });

  it('rejects redirects, missing packages, errors, and non-JSON responses', async () => {
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () =>
            new Response(null, { status: 302, headers: { location: '/' } }),
        }),
      'NPM_REGISTRY_REDIRECT_REJECTED',
    );
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () => metadataResponse({}, { status: 404 }),
        }),
      'NPM_PACKAGE_NOT_FOUND',
    );
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () => metadataResponse({}, { status: 503 }),
        }),
      'NPM_REGISTRY_REQUEST_FAILED',
    );
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () =>
            new Response('text', { headers: { 'content-type': 'text/plain' } }),
        }),
      'NPM_REGISTRY_MEDIA_TYPE_INVALID',
    );
  });

  it('rejects oversized and malformed registry bodies', async () => {
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () =>
            metadataResponse(
              {},
              { headers: { 'content-length': String(1024 * 1024 + 1) } },
            ),
        }),
      'NPM_REGISTRY_RESPONSE_TOO_LARGE',
    );
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () =>
            new Response('{', { headers: { 'content-type': 'application/json' } }),
        }),
      'NPM_REGISTRY_RESPONSE_INVALID',
    );
  });

  it('rejects package substitution and non-stable latest versions', async () => {
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () => metadataResponse({ name: 'other', version: '6.0.3' }),
        }),
      'NPM_REGISTRY_PACKAGE_MISMATCH',
    );
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () =>
            metadataResponse({ name: 'typescript', version: '7.0.0-beta.1' }),
        }),
      'NPM_REGISTRY_VERSION_INVALID',
    );
  });

  it('maps aborts to a bounded safe error code and hides unexpected failures', async () => {
    await expectedErrorCode(
      () =>
        resolveNpmPackageMetadata('typescript', {
          fetch: async () => {
            throw new DOMException('timed out', 'AbortError');
          },
        }),
      'NPM_REGISTRY_TIMEOUT',
    );
    expect(npmRegistrySafeErrorCode(new Error('private upstream detail'))).toBe(
      'NPM_REGISTRY_REQUEST_FAILED',
    );
  });
});
