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
} from '@migration/contracts';
import type {
  AgentRunRecord,
  ApiRepositoryPort,
  CreateDemoRunInput,
  CreateOrganisationInput,
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
  public readonly createDemoRunMock = vi.fn<
    (userId: string, input: CreateDemoRunInput) => Promise<AgentRunRecord>
  >(() => Promise.resolve(queuedRun));

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
});
