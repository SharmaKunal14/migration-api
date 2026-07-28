import { createHash } from 'node:crypto';

import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type {
  GithubInstallationInventory,
  GithubWebhookEnvelope,
} from '@migration/contracts';

import {
  createGithubInventoryProvider,
  handleReconciliationBatch,
  requireRepositoryOrganisation,
  type GithubInventoryProvider,
  type GithubReconciliationRepository,
} from '../services/github-reconciler/src/handler.js';

const deliveryId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const linkedInstallationId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const organisationId = '12a906c7-f7df-4c65-9137-70bcf17eec86';

const inventory: GithubInstallationInventory = {
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
};

class FakeRepository implements GithubReconciliationRepository {
  public readonly beginDeliveryMock = vi.fn<
    GithubReconciliationRepository['beginDelivery']
  >(() => Promise.resolve('process'));
  public readonly resolveInstallationMock = vi.fn<
    GithubReconciliationRepository['resolveInstallation']
  >(() => Promise.resolve({ id: linkedInstallationId, organisationId }));
  public readonly completeInventoryMock = vi.fn<
    GithubReconciliationRepository['completeInventory']
  >(() => Promise.resolve());
  public readonly completeLifecycleMock = vi.fn<
    GithubReconciliationRepository['completeLifecycle']
  >(() => Promise.resolve());
  public readonly completePullRequestMock = vi.fn<
    GithubReconciliationRepository['completePullRequest']
  >(() => Promise.resolve('reconciled'));
  public readonly completeWithoutReconciliationMock = vi.fn<
    GithubReconciliationRepository['completeWithoutReconciliation']
  >(() => Promise.resolve());
  public readonly markDeliveryFailedMock = vi.fn<
    GithubReconciliationRepository['markDeliveryFailed']
  >(() => Promise.resolve());

  public beginDelivery(
    input: Parameters<GithubReconciliationRepository['beginDelivery']>[0],
  ): ReturnType<GithubReconciliationRepository['beginDelivery']> {
    return this.beginDeliveryMock(input);
  }

  public resolveInstallation(
    githubInstallationId: string,
  ): ReturnType<GithubReconciliationRepository['resolveInstallation']> {
    return this.resolveInstallationMock(githubInstallationId);
  }

  public completeInventory(
    requestedDeliveryId: string,
    installation: Parameters<GithubReconciliationRepository['completeInventory']>[1],
    requestedInventory: GithubInstallationInventory,
  ): ReturnType<GithubReconciliationRepository['completeInventory']> {
    return this.completeInventoryMock(
      requestedDeliveryId,
      installation,
      requestedInventory,
    );
  }

  public completeLifecycle(
    requestedDeliveryId: string,
    githubInstallationId: string,
    status: 'removed' | 'suspended',
  ): ReturnType<GithubReconciliationRepository['completeLifecycle']> {
    return this.completeLifecycleMock(
      requestedDeliveryId,
      githubInstallationId,
      status,
    );
  }

  public completePullRequest(
    requestedDeliveryId: string,
    installation: Parameters<GithubReconciliationRepository['completePullRequest']>[1],
    lifecycle: Parameters<GithubReconciliationRepository['completePullRequest']>[2],
  ): ReturnType<GithubReconciliationRepository['completePullRequest']> {
    return this.completePullRequestMock(requestedDeliveryId, installation, lifecycle);
  }

  public completeWithoutReconciliation(
    requestedDeliveryId: string,
  ): ReturnType<GithubReconciliationRepository['completeWithoutReconciliation']> {
    return this.completeWithoutReconciliationMock(requestedDeliveryId);
  }

  public markDeliveryFailed(
    requestedDeliveryId: string,
    code: string,
  ): ReturnType<GithubReconciliationRepository['markDeliveryFailed']> {
    return this.markDeliveryFailedMock(requestedDeliveryId, code);
  }
}

function sqsEvent(
  eventName: GithubWebhookEnvelope['eventName'] = 'installation',
  payload: unknown = { action: 'created', installation: { id: 12345 } },
): SQSEvent {
  const body = Buffer.from(JSON.stringify(payload));
  const envelope: GithubWebhookEnvelope = {
    schemaVersion: '1.0',
    deliveryId,
    eventName,
    payloadDigest: createHash('sha256').update(body).digest('hex'),
    receivedAt: '2026-07-25T00:00:00.000Z',
    bodyBase64: body.toString('base64'),
  };
  return {
    Records: [record(JSON.stringify(envelope))],
  };
}

function record(body: string): SQSRecord {
  return {
    messageId: 'message-id',
    receiptHandle: 'receipt-handle',
    body,
    attributes: {
      ApproximateReceiveCount: '1',
      SentTimestamp: '1784937600000',
      SenderId: 'sender',
      ApproximateFirstReceiveTimestamp: '1784937600000',
    },
    messageAttributes: {},
    md5OfBody: 'not-used',
    eventSource: 'aws:sqs',
    eventSourceARN: 'arn:aws:sqs:ap-southeast-2:123456789012:github-webhooks',
    awsRegion: 'ap-southeast-2',
  };
}

function dependencies(
  repository: FakeRepository,
  provider: GithubInventoryProvider = {
    getInventory: () => Promise.resolve(inventory),
  },
): Parameters<typeof handleReconciliationBatch>[1] {
  return {
    config: {
      APP_ENVIRONMENT: 'development',
      AWS_REGION: 'ap-southeast-2',
      DATABASE_SECRET_ARN:
        'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:database',
      GITHUB_TOKEN_BROKER_FUNCTION_NAME:
        'migration-api-development-github-token-broker',
    },
    repository,
    inventoryProvider: provider,
  };
}

describe('GitHub reconciliation boundary', () => {
  it('retrieves and atomically persists current repository inventory', async () => {
    const repository = new FakeRepository();
    const provider = {
      getInventory: vi.fn<GithubInventoryProvider['getInventory']>(() =>
        Promise.resolve(inventory),
      ),
    };

    await expect(
      handleReconciliationBatch(sqsEvent(), dependencies(repository, provider)),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(repository.beginDeliveryMock).toHaveBeenCalledOnce();
    const delivery = repository.beginDeliveryMock.mock.calls[0]?.[0];
    expect(delivery).toMatchObject({ deliveryId, action: 'created' });
    expect(delivery?.payloadDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(provider.getInventory).toHaveBeenCalledWith(linkedInstallationId);
    expect(repository.completeInventoryMock).toHaveBeenCalledWith(
      deliveryId,
      { id: linkedInstallationId, organisationId },
      inventory,
    );
  });

  it('does not repeat an already processed delivery', async () => {
    const repository = new FakeRepository();
    repository.beginDeliveryMock.mockResolvedValueOnce('duplicate');
    const provider = {
      getInventory: vi.fn<GithubInventoryProvider['getInventory']>(),
    };

    const result = await handleReconciliationBatch(
      sqsEvent(),
      dependencies(repository, provider),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(provider.getInventory).not.toHaveBeenCalled();
  });

  it('reconciles only the immutable identity of a published pull request', async () => {
    const repository = new FakeRepository();
    const result = await handleReconciliationBatch(
      sqsEvent('pull_request', {
        action: 'closed',
        installation: { id: 12345 },
        repository: { id: 67890 },
        pull_request: {
          number: 42,
          node_id: 'PR_kwDOExample',
          html_url: 'https://github.com/acme/widget/pull/42',
          state: 'closed',
          merged: true,
          draft: false,
          head: { ref: 'migration-api/run-e4e2d9db-bd1c-4eef-b685-231128724583' },
          base: { ref: 'main' },
        },
      }),
      dependencies(repository),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(repository.completePullRequestMock).toHaveBeenCalledWith(
      deliveryId,
      { id: linkedInstallationId, organisationId },
      {
        githubRepositoryId: '67890',
        pullRequestNumber: 42,
        pullRequestNodeId: 'PR_kwDOExample',
        pullRequestUrl: 'https://github.com/acme/widget/pull/42',
        headBranch: 'migration-api/run-e4e2d9db-bd1c-4eef-b685-231128724583',
        baseBranch: 'main',
        state: 'merged',
        isDraft: false,
      },
    );
    expect(repository.completeInventoryMock).not.toHaveBeenCalled();
  });

  it('ignores pull requests from an installation that is not linked', async () => {
    const repository = new FakeRepository();
    repository.resolveInstallationMock.mockResolvedValueOnce(undefined);

    const result = await handleReconciliationBatch(
      sqsEvent('pull_request', {
        action: 'opened',
        installation: { id: 99999 },
        repository: { id: 67890 },
        pull_request: {
          number: 42,
          node_id: 'PR_kwDOExample',
          html_url: 'https://github.com/acme/widget/pull/42',
          state: 'open',
          merged: false,
          draft: true,
          head: { ref: 'migration-api/run-e4e2d9db-bd1c-4eef-b685-231128724583' },
          base: { ref: 'main' },
        },
      }),
      dependencies(repository),
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(repository.completeWithoutReconciliationMock).toHaveBeenCalledWith(
      deliveryId,
    );
    expect(repository.completePullRequestMock).not.toHaveBeenCalled();
  });

  it.each([
    ['deleted', 'removed'],
    ['suspend', 'suspended'],
  ] as const)(
    'applies current GitHub state after an installation %s event',
    async (action, status) => {
      const repository = new FakeRepository();
      const provider = {
        getInventory: vi.fn<GithubInventoryProvider['getInventory']>(() =>
          Promise.resolve({
            installation: { ...inventory.installation, status },
            repositories: [],
          }),
        ),
      };

      const result = await handleReconciliationBatch(
        sqsEvent('installation', {
          action,
          installation: { id: 12345 },
        }),
        dependencies(repository, provider),
      );

      expect(result).toEqual({ batchItemFailures: [] });
      expect(repository.completeLifecycleMock).toHaveBeenCalledWith(
        deliveryId,
        '12345',
        status,
      );
      expect(provider.getInventory).toHaveBeenCalledWith(linkedInstallationId);
    },
  );

  it('marks only the failed SQS record for retry', async () => {
    const repository = new FakeRepository();
    const provider: GithubInventoryProvider = {
      getInventory: () =>
        Promise.reject(
          Object.assign(new Error('provider detail'), {
            safeCode: 'GITHUB_INVENTORY_REQUEST_FAILED',
          }),
        ),
    };

    const result = await handleReconciliationBatch(
      sqsEvent(),
      dependencies(repository, provider),
    );

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-id' }],
    });
    expect(repository.markDeliveryFailedMock).toHaveBeenCalledWith(
      deliveryId,
      'GITHUB_INVENTORY_REQUEST_FAILED',
    );
  });

  it('rejects a digest mismatch before writing delivery state', async () => {
    const repository = new FakeRepository();
    const event = sqsEvent();
    const envelope = JSON.parse(event.Records[0]!.body) as GithubWebhookEnvelope;
    event.Records[0]!.body = JSON.stringify({
      ...envelope,
      payloadDigest: '0'.repeat(64),
    });

    const result = await handleReconciliationBatch(event, dependencies(repository));

    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'message-id' }],
    });
    expect(repository.beginDeliveryMock).not.toHaveBeenCalled();
  });

  it('fails closed when the broker returns an invalid inventory payload', async () => {
    const provider = createGithubInventoryProvider(
      {
        send: () =>
          Promise.resolve({
            Payload: Buffer.from(
              JSON.stringify({ token: 'must-not-cross-this-boundary' }),
            ),
          }),
      },
      'migration-api-development-github-token-broker',
    );

    await expect(provider.getInventory(linkedInstallationId)).rejects.toMatchObject({
      safeCode: 'GITHUB_INVENTORY_RESPONSE_INVALID',
    });
  });

  it('rejects moving a numeric GitHub repository ID across tenants', () => {
    expect(() =>
      requireRepositoryOrganisation(
        '30a75bfd-6a69-4368-a341-10362df73007',
        organisationId,
      ),
    ).toThrow(
      expect.objectContaining({
        safeCode: 'GITHUB_REPOSITORY_ALREADY_LINKED',
      }),
    );
  });
});
