import { generateKeyPairSync } from 'node:crypto';

import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';

import { handleBrokerCommand } from '../services/github-token-broker/src/handler.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2_048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const repositoryId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const repositoryScanId = '12a906c7-f7df-4c65-9137-70bcf17eec86';
type BrokerDependencies = Parameters<typeof handleBrokerCommand>[2];

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.toString() : input.url;
}

function dependencies(
  fetchImplementation: typeof globalThis.fetch,
  lookupRepositoryAccess: BrokerDependencies['lookupRepositoryAccess'] = (
    _scanId,
    _repositoryId,
  ): Promise<{
    githubInstallationId: string;
    githubRepositoryId: string;
  }> =>
    Promise.resolve({
      githubInstallationId: '12345',
      githubRepositoryId: '67890',
    }),
  lookupInstallationAccess: BrokerDependencies['lookupInstallationAccess'] = (
    _linkedInstallationId,
  ): ReturnType<BrokerDependencies['lookupInstallationAccess']> =>
    Promise.resolve({
      githubInstallationId: '12345',
      githubAccountId: '45678',
      accountLogin: 'acme',
      accountType: 'Organisation',
    }),
): BrokerDependencies {
  return {
    appId: '98765',
    privateKey,
    lookupRepositoryAccess,
    lookupInstallationAccess,
    fetch: fetchImplementation,
    now: (): Date => new Date('2026-07-25T00:00:00.000Z'),
  };
}

describe('GitHub token broker', () => {
  it('verifies an installation with a short-lived GitHub App JWT', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      expect(authorization).toMatch(/^Bearer /u);
      const jwt = authorization!.slice('Bearer '.length);
      expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'RS256', typ: 'JWT' });
      const verified = await jwtVerify(jwt, await importSPKI(publicKey, 'RS256'), {
        issuer: '98765',
        currentDate: new Date('2026-07-25T00:00:00.000Z'),
      });
      expect(verified.payload.iat).toBe(1784937540);
      expect(verified.payload.exp).toBe(1784938140);
      return new Response(
        JSON.stringify({
          id: 12345,
          account: { id: 45678, login: 'acme', type: 'Organization' },
          suspended_at: null,
        }),
        { status: 200 },
      );
    });

    const result = await handleBrokerCommand(
      { operation: 'verify_installation', installationId: '12345' },
      'request-id',
      dependencies(fetchMock),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/12345',
      expect.objectContaining({ method: 'GET', redirect: 'error' }),
    );
    expect(result).toEqual({
      installationId: '12345',
      accountId: '45678',
      accountLogin: 'acme',
      accountType: 'Organisation',
      status: 'active',
    });
  });

  it('issues a token narrowed to one selected repository and read-only contents', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>((_input, init) => {
      if (typeof init?.body !== 'string') {
        throw new Error('Expected a serialized JSON request body.');
      }
      expect(JSON.parse(init.body)).toEqual({
        repository_ids: [67890],
        permissions: { contents: 'read' },
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: 'github-installation-token-not-real',
            expires_at: '2026-07-25T01:00:00.000Z',
          }),
          { status: 201 },
        ),
      );
    });

    const result = await handleBrokerCommand(
      {
        operation: 'issue_repository_read_token',
        repositoryScanId,
        repositoryId,
      },
      'request-id',
      dependencies(fetchMock),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/app/installations/12345/access_tokens',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    expect(result).toEqual({
      token: 'github-installation-token-not-real',
      expiresAt: '2026-07-25T01:00:00.000Z',
    });
  });

  it('retrieves bounded selected-repository metadata without returning its token', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/app/installations/12345')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 12345,
              account: { id: 45678, login: 'acme', type: 'Organization' },
              suspended_at: null,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/app/installations/12345/access_tokens')) {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized JSON request body.');
        }
        expect(JSON.parse(init.body)).toEqual({
          permissions: {
            metadata: 'read',
          },
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'github-installation-token-not-real',
              expires_at: '2026-07-25T01:00:00.000Z',
            }),
            { status: 201 },
          ),
        );
      }
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer github-installation-token-not-real',
      );
      return Promise.resolve(
        new Response(
          JSON.stringify({
            total_count: 1,
            repositories: [
              {
                id: 67890,
                owner: { login: 'acme' },
                name: 'widget',
                full_name: 'acme/widget',
                default_branch: 'main',
                visibility: 'private',
                archived: false,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    });

    const result = await handleBrokerCommand(
      {
        operation: 'get_installation_inventory',
        linkedInstallationId: repositoryId,
      },
      'request-id',
      dependencies(fetchMock),
    );

    expect(result).toEqual({
      installation: {
        installationId: '12345',
        accountId: '45678',
        accountLogin: 'acme',
        accountType: 'Organisation',
        status: 'active',
      },
      repositories: [
        {
          githubRepositoryId: '67890',
          owner: 'acme',
          name: 'widget',
          fullName: 'acme/widget',
          defaultBranch: 'main',
          visibility: 'private',
          archived: false,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('github-installation-token-not-real');
  });

  it('returns current suspended state without minting an installation token', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 12345,
            account: { id: 45678, login: 'acme', type: 'Organization' },
            suspended_at: '2026-07-25T00:00:00.000Z',
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'get_installation_inventory',
        linkedInstallationId: repositoryId,
      },
      'request-id',
      dependencies(fetchMock),
    );

    expect(result).toMatchObject({
      installation: { installationId: '12345', status: 'suspended' },
      repositories: [],
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps a missing linked installation to current removed state', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('not found', { status: 404 })),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'get_installation_inventory',
        linkedInstallationId: repositoryId,
      },
      'request-id',
      dependencies(fetchMock),
    );

    expect(result).toEqual({
      installation: {
        installationId: '12345',
        accountId: '45678',
        accountLogin: 'acme',
        accountType: 'Organisation',
        status: 'removed',
      },
      repositories: [],
    });
  });

  it('rejects repository inventory above the bounded installation limit', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(input => {
      const url = requestUrl(input);
      if (url.endsWith('/app/installations/12345')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 12345,
              account: { id: 45678, login: 'acme', type: 'Organization' },
              suspended_at: null,
            }),
            { status: 200 },
          ),
        );
      }
      if (url.endsWith('/app/installations/12345/access_tokens')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'github-installation-token-not-real',
              expires_at: '2026-07-25T01:00:00.000Z',
            }),
            { status: 201 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ total_count: 501, repositories: [] }), {
          status: 200,
        }),
      );
    });

    await expect(
      handleBrokerCommand(
        {
          operation: 'get_installation_inventory',
          linkedInstallationId: repositoryId,
        },
        'request-id',
        dependencies(fetchMock),
      ),
    ).rejects.toMatchObject({
      safeCode: 'GITHUB_REPOSITORY_LIMIT_EXCEEDED',
    });
  });

  it('does not contact GitHub when installation inventory access is denied', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();

    await expect(
      handleBrokerCommand(
        {
          operation: 'get_installation_inventory',
          linkedInstallationId: repositoryId,
        },
        'request-id',
        dependencies(fetchMock, undefined, () =>
          Promise.reject(
            Object.assign(new Error('denied'), {
              safeCode: 'INSTALLATION_ACCESS_DENIED',
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ safeCode: 'INSTALLATION_ACCESS_DENIED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not contact GitHub when repository binding is denied', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>();
    await expect(
      handleBrokerCommand(
        {
          operation: 'issue_repository_read_token',
          repositoryScanId,
          repositoryId,
        },
        'request-id',
        dependencies(fetchMock, () =>
          Promise.reject(
            Object.assign(new Error('denied'), {
              safeCode: 'REPOSITORY_ACCESS_DENIED',
            }),
          ),
        ),
      ),
    ).rejects.toMatchObject({ safeCode: 'REPOSITORY_ACCESS_DENIED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an unknown installation to a safe error without exposing the response', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response('upstream details must not escape', { status: 404 }),
      ),
    );
    await expect(
      handleBrokerCommand(
        { operation: 'verify_installation', installationId: '12345' },
        'request-id',
        dependencies(fetchMock),
      ),
    ).rejects.toMatchObject({ safeCode: 'GITHUB_INSTALLATION_NOT_FOUND' });
  });
});
