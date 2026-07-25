import { S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { ApiConfig } from '@migration/config';
import { DomainError, type Actor } from '@migration/domain';

import { handleRequest, type ApiDependencies } from '../services/api/src/handler.js';
import type {
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicRepository,
  PublicRepositoryScan,
} from '@migration/contracts';
import type {
  AgentRunRecord,
  ApiRepositoryPort,
  CompleteGithubInstallationInput,
  CompletedGithubInstallation,
  CreateDemoRunInput,
  CreateRepositoryScanInput,
  CreateOrganisationInput,
  InstallationLinkRecord,
  OrganisationRecord,
} from '../services/api/src/repository.js';

const organisationId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const runId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const userId = '12a906c7-f7df-4c65-9137-70bcf17eec86';

const config: ApiConfig = {
  APP_ENVIRONMENT: 'development',
  AWS_REGION: 'ap-southeast-2',
  ARTIFACT_BUCKET: 'artifacts',
  ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
  DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:db',
  OPENAI_MODEL: 'gpt-5.6-sol',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
  SUPABASE_JWT_ISSUER: 'https://project.supabase.co/auth/v1',
  SUPABASE_JWKS_URL: 'https://project.supabase.co/auth/v1/.well-known/jwks.json',
  GITHUB_APP_SLUG: 'migration-api-development',
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: 'migration-api-development-github-token-broker',
};

const queuedRun: AgentRunRecord = {
  id: runId,
  organisationId,
  scenarioId: 'orbitchat-typescript-v1-v2',
  status: 'queued',
  terminalCode: null,
  safeErrorCode: null,
  resultArtifactId: null,
  resultObjectKey: null,
  resultDigest: null,
  resultBytes: null,
  version: 1,
  createdAt: new Date('2026-07-24T00:00:00.000Z'),
  startedAt: null,
  completedAt: null,
};

class FakeRepository implements ApiRepositoryPort {
  public readonly createRepositoryScanMock = vi.fn<
    (userId: string, input: CreateRepositoryScanInput) => Promise<PublicRepositoryScan>
  >((_userId, input) =>
    Promise.resolve({
      id: runId,
      organisationId: input.organisationId,
      repositoryId: input.repositoryId,
      requestedCommit: null,
      status: 'queued',
      safeErrorCode: null,
      version: 1,
      createdAt: '2026-07-24T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
    }),
  );
  public readonly createDemoRunMock = vi.fn<
    (userId: string, input: CreateDemoRunInput) => Promise<AgentRunRecord>
  >(() => Promise.resolve(queuedRun));
  public readonly createGithubInstallLinkMock = vi.fn<
    (userId: string, organisationId: string) => Promise<InstallationLinkRecord>
  >(() =>
    Promise.resolve({
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      expiresAt: new Date('2026-07-24T00:10:00.000Z'),
    }),
  );
  public readonly completeGithubInstallationMock = vi.fn<
    (
      userId: string,
      input: CompleteGithubInstallationInput,
    ) => Promise<CompletedGithubInstallation>
  >(() =>
    Promise.resolve({
      organisationId,
      installation: {
        id: runId,
        accountLogin: 'SharmaKunal14',
        accountType: 'User',
        status: 'active',
        lastReconciledAt: null,
      },
    }),
  );
  public readonly validateGithubInstallStateMock = vi.fn<
    (userId: string, state: string) => Promise<void>
  >(() => Promise.resolve());

  public ensureUser(_actor: Actor): Promise<string> {
    return Promise.resolve(userId);
  }

  public listOrganisations(_userId: string): Promise<OrganisationRecord[]> {
    return Promise.resolve([]);
  }

  public createOrganisation(
    _userId: string,
    input: CreateOrganisationInput,
  ): Promise<OrganisationRecord> {
    return Promise.resolve({
      id: organisationId,
      name: input.name,
      slug: input.slug,
      role: 'owner',
    });
  }

  public createDemoRun(
    requestedBy: string,
    input: CreateDemoRunInput,
  ): Promise<AgentRunRecord> {
    return this.createDemoRunMock(requestedBy, input);
  }

  public getRun(
    _userId: string,
    _organisationId: string,
    _runId: string,
  ): Promise<AgentRunRecord> {
    return Promise.resolve(queuedRun);
  }

  public listGithubInstallations(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicGithubInstallation[]> {
    return Promise.resolve([]);
  }

  public listRepositories(
    _userId: string,
    _organisationId: string,
  ): Promise<PublicRepository[]> {
    return Promise.resolve([]);
  }

  public listDependencies(
    _userId: string,
    _organisationId: string,
    _repositoryId: string,
  ): Promise<PublicDependencyObservation[]> {
    return Promise.resolve([]);
  }

  public createRepositoryScan(
    requestedBy: string,
    input: CreateRepositoryScanInput,
  ): Promise<PublicRepositoryScan> {
    return this.createRepositoryScanMock(requestedBy, input);
  }

  public createGithubInstallLink(
    requestedBy: string,
    requestedOrganisationId: string,
  ): Promise<InstallationLinkRecord> {
    return this.createGithubInstallLinkMock(requestedBy, requestedOrganisationId);
  }

  public validateGithubInstallState(requestedBy: string, state: string): Promise<void> {
    return this.validateGithubInstallStateMock(requestedBy, state);
  }

  public completeGithubInstallation(
    requestedBy: string,
    input: CompleteGithubInstallationInput,
  ): Promise<CompletedGithubInstallation> {
    return this.completeGithubInstallationMock(requestedBy, input);
  }
}

function dependencies(repository = new FakeRepository()): ApiDependencies {
  return {
    config,
    repository,
    s3: new S3Client({ region: 'ap-southeast-2' }),
    tokenVerifier: {
      verify(): Promise<Actor> {
        return Promise.resolve({ userId, subject: userId });
      },
    },
    installationVerifier: {
      verify(installationId): Promise<{
        installationId: string;
        accountId: string;
        accountLogin: string;
        accountType: 'User';
        status: 'active';
      }> {
        return Promise.resolve({
          installationId,
          accountId: '104818699',
          accountLogin: 'SharmaKunal14',
          accountType: 'User',
          status: 'active',
        });
      },
    },
  };
}

function event(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = { authorization: 'Bearer valid.token.value' },
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    headers,
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'vitest',
      },
      requestId: '30a75bfd-6a69-4368-a341-10362df73007',
      routeKey: '$default',
      stage: '$default',
      time: '24/Jul/2026:00:00:00 +0000',
      timeEpoch: 1784851200000,
    },
    isBase64Encoded: false,
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

function parsedBody(response: Awaited<ReturnType<typeof handleRequest>>): unknown {
  return JSON.parse(response.body ?? 'null');
}

describe('API handler trust boundary', () => {
  it('rejects an unauthenticated request safely', async () => {
    const dependency: ApiDependencies = {
      ...dependencies(),
      tokenVerifier: {
        verify(): Promise<Actor> {
          return Promise.reject(
            new DomainError(
              'AUTHENTICATION_REQUIRED',
              'A valid access token is required.',
              401,
            ),
          );
        },
      },
    };
    const response = await handleRequest(
      event('GET', '/api/v1/me', undefined, {}),
      dependency,
    );
    expect(response.statusCode).toBe(401);
    expect(parsedBody(response)).toEqual({
      error: {
        code: 'AUTHENTICATION_REQUIRED',
        message: 'A valid access token is required.',
        requestId: '30a75bfd-6a69-4368-a341-10362df73007',
      },
    });
  });

  it('rejects unknown mutation fields', async () => {
    const response = await handleRequest(
      event('POST', '/api/v1/organisations', {
        name: 'Acme',
        slug: 'acme',
        role: 'owner',
      }),
      dependencies(),
    );
    expect(response.statusCode).toBe(400);
    expect(parsedBody(response)).toMatchObject({
      error: { code: 'INVALID_REQUEST' },
    });
  });

  it('requires an idempotency key before creating a run', async () => {
    const response = await handleRequest(
      event('POST', `/api/v1/organisations/${organisationId}/demo-runs`, {
        scenarioId: 'orbitchat-typescript-v1-v2',
      }),
      dependencies(),
    );
    expect(response.statusCode).toBe(400);
    expect(parsedBody(response)).toMatchObject({
      error: { code: 'INVALID_IDEMPOTENCY_KEY' },
    });
  });

  it('starts one strict synthetic run request', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/demo-runs`,
        { scenarioId: 'orbitchat-typescript-v1-v2' },
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'run:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(202);
    expect(repository.createDemoRunMock).toHaveBeenCalledOnce();
    expect(repository.createDemoRunMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        idempotencyKey: 'run:01J7Y5ABCD',
        scenarioId: 'orbitchat-typescript-v1-v2',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      run: { id: runId, status: 'queued', result: null },
    });
  });

  it('starts an idempotent repository scan with identifier-only input', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event(
        'POST',
        `/api/v1/organisations/${organisationId}/repositories/${runId}/scans`,
        {},
        {
          authorization: 'Bearer valid.token.value',
          'idempotency-key': 'scan:01J7Y5ABCD',
        },
      ),
      dependencies(repository),
    );
    expect(response.statusCode).toBe(202);
    expect(repository.createRepositoryScanMock).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        organisationId,
        repositoryId: runId,
        idempotencyKey: 'scan:01J7Y5ABCD',
      }),
    );
    expect(parsedBody(response)).toMatchObject({
      scan: { id: runId, repositoryId: runId, status: 'queued' },
    });
  });

  it.each([
    [`/api/v1/organisations/${organisationId}/github/installations`, 'installations'],
    [`/api/v1/organisations/${organisationId}/repositories`, 'repositories'],
    [
      `/api/v1/organisations/${organisationId}/repositories/${runId}/dependencies`,
      'dependencies',
    ],
  ])('returns a tenant-scoped Stage 2 collection from %s', async (path, key) => {
    const response = await handleRequest(
      event('GET', path),
      dependencies(new FakeRepository()),
    );
    expect(response.statusCode).toBe(200);
    expect(parsedBody(response)).toEqual({ [key]: [] });
  });

  it('creates a short-lived GitHub App installation URL', async () => {
    const repository = new FakeRepository();
    const response = await handleRequest(
      event('POST', `/api/v1/organisations/${organisationId}/github/install-link`, {}),
      dependencies(repository),
    );

    expect(response.statusCode).toBe(201);
    expect(repository.createGithubInstallLinkMock).toHaveBeenCalledWith(
      userId,
      organisationId,
    );
    expect(parsedBody(response)).toEqual({
      installLink: {
        installationUrl:
          'https://github.com/apps/migration-api-development/installations/new?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        expiresAt: '2026-07-24T00:10:00.000Z',
      },
    });
  });

  it('verifies and links a GitHub App callback', async () => {
    const repository = new FakeRepository();
    const dependency = dependencies(repository);
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(200);
    expect(repository.validateGithubInstallStateMock).toHaveBeenCalledWith(
      userId,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    );
    expect(verify).toHaveBeenCalledWith('123456789');
    expect(repository.completeGithubInstallationMock).toHaveBeenCalledOnce();
    expect(repository.completeGithubInstallationMock.mock.calls[0]?.[0]).toBe(userId);
    expect(repository.completeGithubInstallationMock.mock.calls[0]?.[1]).toMatchObject({
      installationId: '123456789',
      state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      verified: { accountId: '104818699' },
    });
    expect(parsedBody(response)).toMatchObject({
      organisationId,
      installation: { accountLogin: 'SharmaKunal14', status: 'active' },
    });
  });

  it('rejects a malformed callback state before invoking the broker', async () => {
    const dependency = dependencies();
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'predictable',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(400);
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects an invalid or unauthorized state before invoking the broker', async () => {
    const repository = new FakeRepository();
    repository.validateGithubInstallStateMock.mockRejectedValueOnce(
      new DomainError(
        'GITHUB_INSTALLATION_STATE_INVALID',
        'The GitHub installation link is invalid or expired.',
        409,
      ),
    );
    const dependency = dependencies(repository);
    const verify = vi.spyOn(dependency.installationVerifier, 'verify');
    const response = await handleRequest(
      event('POST', '/api/v1/github/setup/callback', {
        installationId: '123456789',
        state: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      dependency,
    );

    expect(response.statusCode).toBe(409);
    expect(verify).not.toHaveBeenCalled();
    expect(repository.completeGithubInstallationMock).not.toHaveBeenCalled();
  });
});
