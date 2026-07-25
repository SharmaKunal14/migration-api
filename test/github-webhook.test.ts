import { createHmac } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { GithubWebhookEnvelope } from '@migration/contracts';
import type { GithubWebhookConfig } from '@migration/config';

import { handleWebhook } from '../services/github-webhook/src/handler.js';

const webhookSecret = 'stage-two-test-secret-with-at-least-32-bytes';
const requestId = '30a75bfd-6a69-4368-a341-10362df73007';
const deliveryId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const config: GithubWebhookConfig = {
  APP_ENVIRONMENT: 'development',
  AWS_REGION: 'ap-southeast-2',
  GITHUB_WEBHOOK_QUEUE_URL:
    'https://sqs.ap-southeast-2.amazonaws.com/123456789012/github-webhooks',
  GITHUB_WEBHOOK_SECRET_ARN:
    'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:github-webhook',
};

function event(
  body: string,
  signature = `sha256=${createHmac('sha256', webhookSecret).update(body).digest('hex')}`,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/github/webhooks',
    rawPath: '/v1/github/webhooks',
    rawQueryString: '',
    headers: {
      'x-github-delivery': deliveryId,
      'x-github-event': 'installation',
      'x-hub-signature-256': signature,
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api',
      domainName: 'example.test',
      domainPrefix: 'example',
      http: {
        method: 'POST',
        path: '/v1/github/webhooks',
        protocol: 'HTTP/1.1',
        sourceIp: '192.0.2.1',
        userAgent: 'GitHub-Hookshot/example',
      },
      requestId,
      routeKey: 'POST /v1/github/webhooks',
      stage: '$default',
      time: '25/Jul/2026:00:00:00 +0000',
      timeEpoch: 1784937600000,
    },
    isBase64Encoded: false,
    body,
  };
}

function dependencies(
  enqueue: (envelope: GithubWebhookEnvelope) => Promise<void>,
): Parameters<typeof handleWebhook>[1] {
  return {
    config,
    webhookSecret,
    enqueue,
    now: (): Date => new Date('2026-07-25T00:00:00.000Z'),
  };
}

describe('GitHub raw webhook trust boundary', () => {
  it('verifies the raw body and enqueues a bounded envelope', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>(
      (): Promise<void> => Promise.resolve(),
    );
    const body = JSON.stringify({ action: 'created', installation: { id: 123 } });
    const response = await handleWebhook(event(body), dependencies(enqueue));

    expect(response.statusCode).toBe(202);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({
      schemaVersion: '1.0',
      deliveryId,
      eventName: 'installation',
      payloadDigest: 'c5e567e7f0b49cb6992107c054280feda9d8faefac86bb65c7257c4c0f7947f7',
      receivedAt: '2026-07-25T00:00:00.000Z',
      bodyBase64: Buffer.from(body).toString('base64'),
    });
  });

  it('rejects a forged signature before enqueueing', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>();
    const response = await handleWebhook(
      event('{"action":"created"}', `sha256=${'0'.repeat(64)}`),
      dependencies(enqueue),
    );
    expect(response.statusCode).toBe(401);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts GitHub ping after signature verification without enqueueing', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>();
    const request = event('{"zen":"keep it logically awesome"}');
    request.headers['x-github-event'] = 'ping';
    const response = await handleWebhook(request, dependencies(enqueue));
    expect(response.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects unsupported events after signature verification', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>();
    const request = event('{"action":"requested"}');
    request.headers['x-github-event'] = 'workflow_run';
    const response = await handleWebhook(request, dependencies(enqueue));
    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies without enqueueing', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>();
    const response = await handleWebhook(
      event('x'.repeat(160 * 1024 + 1)),
      dependencies(enqueue),
    );
    expect(response.statusCode).toBe(413);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects malformed base64 without enqueueing', async () => {
    const enqueue = vi.fn<(envelope: GithubWebhookEnvelope) => Promise<void>>();
    const request = event('{}');
    request.isBase64Encoded = true;
    request.body = 'not base64';
    const response = await handleWebhook(request, dependencies(enqueue));
    expect(response.statusCode).toBe(400);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
