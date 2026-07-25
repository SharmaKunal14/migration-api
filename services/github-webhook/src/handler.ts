import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

import {
  githubWebhookEnvelopeSchema,
  type GithubWebhookEnvelope,
  uuidSchema,
} from '@migration/contracts';
import {
  githubWebhookConfigSchema,
  githubWebhookSecretSchema,
  parseConfig,
  type GithubWebhookConfig,
} from '@migration/config';
import { writeLog } from '@migration/observability';

const MAX_WEBHOOK_BODY_BYTES = 160 * 1024;
const SIGNATURE_PREFIX = 'sha256=';
type JsonResponse = Exclude<APIGatewayProxyResultV2, string>;

interface WebhookDependencies {
  readonly config: GithubWebhookConfig;
  readonly webhookSecret: string;
  readonly enqueue: (envelope: GithubWebhookEnvelope) => Promise<void>;
  readonly now?: () => Date;
}

let cachedDependencies: WebhookDependencies | undefined;

async function dependencies(): Promise<WebhookDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(githubWebhookConfigSchema);
  const secrets = new SecretsManagerClient({ region: config.AWS_REGION });
  const response = await secrets.send(
    new GetSecretValueCommand({
      SecretId: config.GITHUB_WEBHOOK_SECRET_ARN,
      VersionStage: 'AWSCURRENT',
    }),
  );
  if (!response.SecretString) {
    throw new Error('The GitHub webhook secret has no string value.');
  }
  const secret = githubWebhookSecretSchema.parse(JSON.parse(response.SecretString));
  const sqs = new SQSClient({ region: config.AWS_REGION });
  cachedDependencies = {
    config,
    webhookSecret: secret.webhookSecret,
    enqueue: async (envelope): Promise<void> => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: config.GITHUB_WEBHOOK_QUEUE_URL,
          MessageBody: JSON.stringify(envelope),
        }),
      );
    },
  };
  return cachedDependencies;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleWebhook(event, await dependencies());
}

export async function handleWebhook(
  event: APIGatewayProxyEventV2,
  dependency: WebhookDependencies,
): Promise<JsonResponse> {
  const requestId = event.requestContext.requestId;
  try {
    if (event.requestContext.http.method !== 'POST') {
      return response(405, requestId, 'METHOD_NOT_ALLOWED');
    }
    const deliveryId = requiredHeader(event.headers, 'x-github-delivery');
    const eventName = requiredHeader(event.headers, 'x-github-event');
    const signature = requiredHeader(event.headers, 'x-hub-signature-256');
    const body = decodeBody(event);
    if (!verifySignature(body, signature, dependency.webhookSecret)) {
      writeLog('warn', {
        event: 'github_webhook_rejected',
        requestId,
        safeErrorCode: 'WEBHOOK_SIGNATURE_INVALID',
      });
      return response(401, requestId, 'WEBHOOK_SIGNATURE_INVALID');
    }
    if (eventName === 'ping') {
      uuidSchema.parse(deliveryId);
      writeLog('info', {
        event: 'github_webhook_ping_accepted',
        requestId,
        upstreamRequestId: deliveryId,
        outcome: 'ping',
      });
      return acceptedResponse(200, requestId);
    }

    const envelope = githubWebhookEnvelopeSchema.parse({
      schemaVersion: '1.0',
      deliveryId,
      eventName,
      payloadDigest: createHash('sha256').update(body).digest('hex'),
      receivedAt: (dependency.now?.() ?? new Date()).toISOString(),
      bodyBase64: body.toString('base64'),
    });
    await dependency.enqueue(envelope);
    writeLog('info', {
      event: 'github_webhook_accepted',
      requestId,
      upstreamRequestId: envelope.deliveryId,
      outcome: envelope.eventName,
    });
    return acceptedResponse(202, requestId);
  } catch (error) {
    const safeCode =
      error instanceof WebhookRequestError ? error.safeCode : 'WEBHOOK_REJECTED';
    const status = error instanceof WebhookRequestError ? error.status : 400;
    writeLog('warn', {
      event: 'github_webhook_rejected',
      requestId,
      safeErrorCode: safeCode,
    });
    return response(status, requestId, safeCode);
  }
}

function acceptedResponse(statusCode: number, requestId: string): JsonResponse {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({ accepted: true, requestId }),
  };
}

class WebhookRequestError extends Error {
  public constructor(
    public readonly safeCode: string,
    public readonly status: number,
  ) {
    super('The webhook request is invalid.');
    this.name = 'WebhookRequestError';
  }
}

function requiredHeader(
  headers: Record<string, string | undefined>,
  name: string,
): string {
  const value = Object.entries(headers).find(
    ([header]) => header.toLowerCase() === name,
  )?.[1];
  if (!value) throw new WebhookRequestError('WEBHOOK_HEADERS_INVALID', 400);
  return value;
}

function decodeBody(event: APIGatewayProxyEventV2): Buffer {
  if (event.body === undefined) {
    throw new WebhookRequestError('WEBHOOK_BODY_INVALID', 400);
  }
  let body: Buffer;
  try {
    if (event.isBase64Encoded) {
      if (!isCanonicalBase64(event.body)) {
        throw new WebhookRequestError('WEBHOOK_BODY_INVALID', 400);
      }
      body = Buffer.from(event.body, 'base64');
    } else {
      body = Buffer.from(event.body, 'utf8');
    }
  } catch {
    throw new WebhookRequestError('WEBHOOK_BODY_INVALID', 400);
  }
  if (body.byteLength === 0 || body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    throw new WebhookRequestError('WEBHOOK_BODY_INVALID', 413);
  }
  return body;
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  if (
    !signature.startsWith(SIGNATURE_PREFIX) ||
    !/^[a-f0-9]{64}$/u.test(signature.slice(SIGNATURE_PREFIX.length))
  ) {
    return false;
  }
  const provided = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return (
    provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected)
  );
}

function response(statusCode: number, requestId: string, code: string): JsonResponse {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({
      error: {
        code,
        message: 'The webhook request could not be accepted.',
        requestId,
      },
    }),
  };
}
