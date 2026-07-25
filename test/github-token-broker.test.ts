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
): BrokerDependencies {
  return {
    appId: '98765',
    privateKey,
    lookupRepositoryAccess,
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
