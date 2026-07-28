import { createHash, generateKeyPairSync } from 'node:crypto';

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
    owner: string;
    name: string;
    defaultBranch: string;
  }> =>
    Promise.resolve({
      githubInstallationId: '12345',
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
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
  lookupMigrationRepositoryAccess: BrokerDependencies['lookupMigrationRepositoryAccess'] = (
    _migrationRunId,
    _repositoryId,
  ) =>
    Promise.resolve({
      githubInstallationId: '12345',
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      commitSha: 'a'.repeat(40),
      snapshotDigest: 'b'.repeat(64),
    }),
  lookupPublicationRepositoryAccess: BrokerDependencies['lookupPublicationRepositoryAccess'] = (
    _migrationRunId,
    _repositoryId,
  ) =>
    Promise.resolve({
      githubInstallationId: '12345',
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      publicationAttemptId: '9c694c4d-8b78-44bf-960f-77ea1de2cc81',
      patchDigest: 'c'.repeat(64),
      headBranch: 'migration-api/run-8955ed33-d1d8-4fdb-bd48-3a0835562934',
    }),
): BrokerDependencies {
  return {
    appId: '98765',
    privateKey,
    lookupRepositoryAccess,
    lookupMigrationRepositoryAccess,
    lookupPublicationRepositoryAccess,
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
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      defaultBranch: 'main',
    });
  });

  it('issues a migration token bound to the approved commit and digest', async () => {
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
            token: 'github-installation-token-never-persisted',
            expires_at: '2026-07-25T01:00:00.000Z',
          }),
          { status: 201 },
        ),
      );
    });
    const lookupMigration = vi.fn(
      (): ReturnType<BrokerDependencies['lookupMigrationRepositoryAccess']> =>
        Promise.resolve({
          githubInstallationId: '12345',
          githubRepositoryId: '67890',
          owner: 'acme',
          name: 'widgets',
          defaultBranch: 'main',
          commitSha: 'a'.repeat(40),
          snapshotDigest: 'b'.repeat(64),
        }),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'issue_migration_repository_read_token',
        migrationRunId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
        repositoryId,
      },
      'request-id',
      dependencies(fetchMock, undefined, undefined, lookupMigration),
    );

    expect(lookupMigration).toHaveBeenCalledWith(
      '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      repositoryId,
    );
    expect(result).toEqual({
      token: 'github-installation-token-never-persisted',
      expiresAt: '2026-07-25T01:00:00.000Z',
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      commitSha: 'a'.repeat(40),
      snapshotDigest: 'b'.repeat(64),
    });
  });

  it('verifies write access and the live base without returning a token', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/app/installations/12345/access_tokens')) {
        if (typeof init?.body !== 'string') {
          throw new Error('Expected a serialized JSON request body.');
        }
        expect(JSON.parse(init.body)).toEqual({
          repository_ids: [67890],
          permissions: {
            contents: 'write',
            pull_requests: 'write',
          },
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'github-publication-token-never-returned',
              expires_at: '2026-07-25T01:00:00.000Z',
            }),
            { status: 201 },
          ),
        );
      }
      expect(url).toBe('https://api.github.com/repos/acme/widgets/git/ref/heads/main');
      return Promise.resolve(
        new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } }), {
          status: 200,
        }),
      );
    });
    const lookupPublication = vi.fn(
      (): ReturnType<BrokerDependencies['lookupPublicationRepositoryAccess']> =>
        Promise.resolve({
          githubInstallationId: '12345',
          githubRepositoryId: '67890',
          owner: 'acme',
          name: 'widgets',
          defaultBranch: 'main',
          baseCommitSha: 'a'.repeat(40),
          publicationAttemptId: '9c694c4d-8b78-44bf-960f-77ea1de2cc81',
          patchDigest: 'c'.repeat(64),
          headBranch: 'migration-api/run-8955ed33-d1d8-4fdb-bd48-3a0835562934',
        }),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'verify_publication_access',
        migrationRunId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
        repositoryId,
      },
      'request-id',
      dependencies(fetchMock, undefined, undefined, undefined, lookupPublication),
    );

    expect(lookupPublication).toHaveBeenCalledWith(
      '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      repositoryId,
    );
    expect(result).toEqual({
      status: 'ready',
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widgets',
      baseBranch: 'main',
      headCommitSha: 'a'.repeat(40),
    });
    expect(result).not.toHaveProperty('token');
  });

  it('returns a safe denial when GitHub rejects publication permissions', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'Resource not accessible' }), {
          status: 403,
        }),
      ),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'verify_publication_access',
        migrationRunId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
        repositoryId,
      },
      'request-id',
      dependencies(fetchMock),
    );

    expect(result).toEqual({
      status: 'denied',
      safeErrorCode: 'GITHUB_PUBLICATION_ACCESS_DENIED',
    });
  });

  it('publishes one deterministic commit and draft pull request', async () => {
    const migrationRunId = '8955ed33-d1d8-4fdb-bd48-3a0835562934';
    const publicationAttemptId = '9c694c4d-8b78-44bf-960f-77ea1de2cc81';
    const patch = [
      'diff --git a/package.json b/package.json',
      '--- a/package.json',
      '+++ b/package.json',
      '@@ -1,1 +1,1 @@',
      '-{"version":1}',
      '+{"version":2}',
      '',
    ].join('\n');
    const patchDigest = createHash('sha256').update(patch).digest('hex');
    const fetchMock = vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = requestUrl(input);
      if (url.endsWith('/access_tokens')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              token: 'github-publication-token-never-returned',
              expires_at: '2026-07-25T01:00:00.000Z',
            }),
            { status: 201 },
          ),
        );
      }
      if (url.endsWith('/git/ref/heads/main')) {
        return Promise.resolve(
          new Response(JSON.stringify({ object: { sha: 'a'.repeat(40) } })),
        );
      }
      if (url.includes('/git/ref/heads/migration-api/')) {
        return Promise.resolve(new Response('{}', { status: 404 }));
      }
      if (url.includes('/contents/package.json')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              type: 'file',
              encoding: 'base64',
              content: Buffer.from('{"version":1}\n').toString('base64'),
            }),
          ),
        );
      }
      if (url.endsWith(`/git/commits/${'a'.repeat(40)}`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              sha: 'a'.repeat(40),
              message: 'base',
              tree: { sha: 'b'.repeat(40) },
              parents: [{ sha: '0'.repeat(40) }],
            }),
          ),
        );
      }
      if (url.endsWith('/git/blobs')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: 'c'.repeat(40) }), { status: 201 }),
        );
      }
      if (url.includes(`/git/trees/${'b'.repeat(40)}?recursive=1`)) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              truncated: false,
              tree: [
                { path: 'src', mode: '040000', type: 'tree' },
                {
                  path: 'vendor-link',
                  mode: '120000',
                  type: 'blob',
                },
                {
                  path: 'vendor-submodule',
                  mode: '160000',
                  type: 'commit',
                },
                { path: 'package.json', mode: '100644', type: 'blob' },
              ],
            }),
          ),
        );
      }
      if (url.endsWith('/git/trees')) {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: 'd'.repeat(40) }), { status: 201 }),
        );
      }
      if (url.endsWith('/git/commits') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(JSON.stringify({ sha: 'e'.repeat(40) }), { status: 201 }),
        );
      }
      if (url.endsWith('/git/refs')) {
        return Promise.resolve(
          new Response(JSON.stringify({ object: { sha: 'e'.repeat(40) } }), {
            status: 201,
          }),
        );
      }
      if (url.includes('/pulls?')) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (url.endsWith('/pulls') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 42,
              node_id: 'PR_test',
              html_url: 'https://github.com/acme/widgets/pull/42',
              state: 'open',
              draft: true,
              head: { sha: 'e'.repeat(40) },
            }),
            { status: 201 },
          ),
        );
      }
      throw new Error(`Unexpected GitHub request: ${init?.method ?? 'GET'} ${url}`);
    });
    const lookupPublication = vi.fn(
      (): ReturnType<BrokerDependencies['lookupPublicationRepositoryAccess']> =>
        Promise.resolve({
          githubInstallationId: '12345',
          githubRepositoryId: '67890',
          owner: 'acme',
          name: 'widgets',
          defaultBranch: 'main',
          baseCommitSha: 'a'.repeat(40),
          publicationAttemptId,
          patchDigest,
          headBranch: `migration-api/run-${migrationRunId}`,
        }),
    );

    const result = await handleBrokerCommand(
      {
        operation: 'publish_draft_pr',
        migrationRunId,
        repositoryId,
        publicationAttemptId,
        patchDigest,
        patch,
      },
      'request-id',
      dependencies(fetchMock, undefined, undefined, undefined, lookupPublication),
    );

    expect(result).toEqual({
      status: 'published',
      githubRepositoryId: '67890',
      headBranch: `migration-api/run-${migrationRunId}`,
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      commitSha: 'e'.repeat(40),
      pullRequestNumber: 42,
      pullRequestNodeId: 'PR_test',
      pullRequestUrl: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      isDraft: true,
    });
    const pullRequestCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).endsWith('/pulls'),
    );
    const pullRequestBody = pullRequestCall?.[1]?.body;
    if (typeof pullRequestBody !== 'string') {
      throw new Error('Expected a serialized pull request body.');
    }
    expect(JSON.parse(pullRequestBody)).toMatchObject({
      draft: true,
      head: `migration-api/run-${migrationRunId}`,
      base: 'main',
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
