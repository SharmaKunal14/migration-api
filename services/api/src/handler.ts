import { createHash, randomUUID } from 'node:crypto';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';

import {
  bearerToken,
  createTokenVerifier,
  type TokenVerifier,
} from '@migration/authorization';
import {
  agentResultEnvelopeSchema,
  demoRunRequestSchema,
  type PublicAgentRun,
} from '@migration/contracts';
import { apiConfigSchema, parseConfig, type ApiConfig } from '@migration/config';
import { createDatabase } from '@migration/database';
import { DomainError, requireIdempotencyKey } from '@migration/domain';
import { safeErrorCode, writeLog } from '@migration/observability';

import {
  ApiRepository,
  type AgentRunRecord,
  type ApiRepositoryPort,
} from './repository.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
type JsonResponse = Exclude<APIGatewayProxyResultV2, string>;

const organisationBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  })
  .strict();

export interface ApiDependencies {
  readonly config: ApiConfig;
  readonly repository: ApiRepositoryPort;
  readonly tokenVerifier: TokenVerifier;
  readonly s3: S3Client;
}

let cachedDependencies: ApiDependencies | undefined;

async function dependencies(): Promise<ApiDependencies> {
  if (cachedDependencies) {
    return cachedDependencies;
  }
  const config = parseConfig(apiConfigSchema);
  const database = await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN);
  cachedDependencies = {
    config,
    repository: new ApiRepository(database),
    tokenVerifier: createTokenVerifier({
      audience: config.SUPABASE_JWT_AUDIENCE,
      issuer: config.SUPABASE_JWT_ISSUER,
      jwksUrl: config.SUPABASE_JWKS_URL,
    }),
    s3: new S3Client({ region: config.AWS_REGION }),
  };
  return cachedDependencies;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleRequest(event, await dependencies());
}

export async function handleRequest(
  event: APIGatewayProxyEventV2,
  dependency: ApiDependencies,
): Promise<JsonResponse> {
  const started = Date.now();
  const requestId = requestIdentifier(event.requestContext.requestId);
  try {
    const actor = await dependency.tokenVerifier.verify(
      bearerToken(event.headers.authorization),
    );
    const repository = dependency.repository;
    const userId = await repository.ensureUser(actor);
    const method = event.requestContext.http.method;
    const path = normalizePath(event.rawPath);

    let response: JsonResponse;
    if (method === 'GET' && path === '/v1/me') {
      response = json(200, {
        user: { id: userId },
        organisations: await repository.listOrganisations(userId),
      });
    } else if (method === 'GET' && path === '/v1/organisations') {
      response = json(200, {
        organisations: await repository.listOrganisations(userId),
      });
    } else if (method === 'POST' && path === '/v1/organisations') {
      const input = organisationBodySchema.parse(parseBody(event));
      const organisation = await repository.createOrganisation(userId, {
        ...input,
        requestId,
      });
      response = json(201, { organisation });
    } else {
      const createMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/demo-runs$/u.exec(path)
          : null;
      const readMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/runs\/([0-9a-f-]{36})$/u.exec(path)
          : null;
      if (createMatch?.[1]) {
        const input = demoRunRequestSchema.parse(parseBody(event));
        const run = await repository.createDemoRun(userId, {
          organisationId: z.uuid().parse(createMatch[1]),
          idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
          requestId,
          scenarioId: input.scenarioId,
          requestedModel: dependency.config.OPENAI_MODEL,
        });
        response = json(202, { run: await publicRun(run, dependency) });
      } else if (readMatch?.[1] && readMatch[2]) {
        const run = await repository.getRun(
          userId,
          z.uuid().parse(readMatch[1]),
          z.uuid().parse(readMatch[2]),
        );
        response = json(200, { run: await publicRun(run, dependency) });
      } else {
        throw new DomainError('ROUTE_NOT_FOUND', 'The route was not found.', 404);
      }
    }
    writeLog('info', {
      event: 'api_request_completed',
      requestId,
      durationMs: Date.now() - started,
      outcome: String(response.statusCode),
    });
    return withRequestId(response, requestId);
  } catch (error) {
    const status =
      error instanceof DomainError
        ? error.httpStatus
        : error instanceof z.ZodError
          ? 400
          : 500;
    const code = error instanceof z.ZodError ? 'INVALID_REQUEST' : safeErrorCode(error);
    writeLog(status >= 500 ? 'error' : 'warn', {
      event: 'api_request_failed',
      requestId,
      durationMs: Date.now() - started,
      safeErrorCode: code,
      outcome: String(status),
    });
    return withRequestId(
      json(status, {
        error: {
          code,
          message:
            status >= 500
              ? 'The request could not be completed.'
              : publicMessage(error),
          requestId,
        },
      }),
      requestId,
    );
  }
}

async function publicRun(
  run: AgentRunRecord,
  dependency: ApiDependencies,
): Promise<PublicAgentRun> {
  let result: PublicAgentRun['result'] = null;
  if (
    run.status === 'succeeded' &&
    run.resultObjectKey &&
    run.resultDigest &&
    run.resultBytes !== null
  ) {
    if (run.resultBytes > MAX_RESULT_BYTES) {
      throw new Error('Result artifact exceeds the configured display limit.');
    }
    const response = await dependency.s3.send(
      new GetObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: run.resultObjectKey,
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (bytes?.byteLength !== run.resultBytes) {
      throw new Error('Result artifact size validation failed.');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== run.resultDigest) {
      throw new Error('Result artifact digest validation failed.');
    }
    const envelope = agentResultEnvelopeSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
    if (
      envelope.organisationId !== run.organisationId ||
      envelope.agentRunId !== run.id
    ) {
      throw new Error('Result artifact ownership validation failed.');
    }
    result = envelope.result;
  }
  return {
    id: run.id,
    organisationId: run.organisationId,
    scenarioId: run.scenarioId,
    status: run.status,
    terminalCode: run.terminalCode,
    safeErrorCode: run.safeErrorCode,
    result,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    throw new DomainError('INVALID_REQUEST', 'A JSON request body is required.', 400);
  }
  const bytes = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new DomainError('REQUEST_TOO_LARGE', 'The request body is too large.', 413);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'The request body is not valid JSON.', 400);
  }
}

function normalizePath(rawPath: string): string {
  const path = rawPath.startsWith('/api/') ? rawPath.slice(4) : rawPath;
  return path.length > 1 ? path.replace(/\/+$/u, '') : path;
}

function requestIdentifier(value: string): string {
  return z.uuid().safeParse(value).data ?? randomUUID();
}

function publicMessage(error: unknown): string {
  if (error instanceof DomainError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'The request is invalid.';
  }
  return 'The request could not be completed.';
}

function json(statusCode: number, body: unknown): JsonResponse {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function withRequestId(response: JsonResponse, requestId: string): JsonResponse {
  return {
    ...response,
    headers: { ...response.headers, 'x-request-id': requestId },
  };
}
