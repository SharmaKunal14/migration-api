import { describe, expect, it } from 'vitest';

import {
  agentResultEnvelopeSchema,
  demoRunRequestSchema,
  githubInstallationInventorySchema,
  githubWebhookEnvelopeSchema,
  migrationPlanSchema,
  repositoryScanWorkflowInputSchema,
  repositoryAcquisitionResultSchema,
  workflowInputSchema,
} from '@migration/contracts';

import { validPlan } from './fixtures/migration-plan.js';

describe('runtime contracts', () => {
  it('accepts the strict demo request', () => {
    expect(
      demoRunRequestSchema.parse({
        scenarioId: 'orbitchat-typescript-v1-v2',
      }),
    ).toEqual({ scenarioId: 'orbitchat-typescript-v1-v2' });
  });

  it('rejects unknown demo request fields', () => {
    expect(() =>
      demoRunRequestSchema.parse({
        scenarioId: 'orbitchat-typescript-v1-v2',
        repositoryId: 'untrusted',
      }),
    ).toThrow();
  });

  it('accepts identifier-only workflow input', () => {
    expect(
      workflowInputSchema.parse({
        schemaVersion: '1.0',
        organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        agentRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
        correlationId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
        expectedVersion: 1,
      }),
    ).toBeDefined();
  });

  it('rejects source in workflow input', () => {
    expect(() =>
      workflowInputSchema.parse({
        schemaVersion: '1.0',
        organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        agentRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
        correlationId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
        expectedVersion: 1,
        source: 'must not enter workflow history',
      }),
    ).toThrow();
  });

  it('accepts identifier-only repository scan workflow input', () => {
    expect(
      repositoryScanWorkflowInputSchema.parse({
        schemaVersion: '1.0',
        organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        repositoryId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
        repositoryScanId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
        correlationId: '30a75bfd-6a69-4368-a341-10362df73007',
        expectedVersion: 1,
      }),
    ).toBeDefined();
  });

  it('requires exact snapshot evidence only for successful repository acquisition', () => {
    const result = {
      schemaVersion: '1.0',
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      repositoryId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      repositoryScanId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
      status: 'succeeded',
      safeErrorCode: null,
      snapshot: {
        commitSha: 'a'.repeat(40),
        objectKey: 'env/development/org/example/snapshot.tar.gz',
        digest: 'b'.repeat(64),
        bytes: 1024,
        fileCount: 2,
        expiresAt: '2026-08-02T00:00:00.000Z',
      },
      inventory: {
        manifests: ['package.json'],
        lockfiles: [],
        observations: [],
      },
    } as const;
    expect(repositoryAcquisitionResultSchema.parse(result)).toEqual(result);
    expect(() =>
      repositoryAcquisitionResultSchema.parse({
        ...result,
        status: 'failed',
        safeErrorCode: 'SOURCE_FETCHER_FAILED',
      }),
    ).toThrow();
    expect(() =>
      repositoryAcquisitionResultSchema.parse({
        ...result,
        status: 'succeeded',
        snapshot: null,
        inventory: null,
      }),
    ).toThrow();
  });

  it('constrains webhook envelopes to allowlisted GitHub events', () => {
    const envelope = {
      schemaVersion: '1.0',
      deliveryId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      eventName: 'installation',
      payloadDigest: 'a'.repeat(64),
      receivedAt: '2026-07-25T00:00:00.000Z',
      bodyBase64: 'e30=',
    };
    expect(githubWebhookEnvelopeSchema.parse(envelope)).toEqual(envelope);
    expect(() =>
      githubWebhookEnvelopeSchema.parse({ ...envelope, eventName: 'workflow_run' }),
    ).toThrow();
  });

  it('requires a bounded, unique, internally consistent repository inventory', () => {
    const repository = {
      githubRepositoryId: '67890',
      owner: 'acme',
      name: 'widget',
      fullName: 'acme/widget',
      defaultBranch: 'main',
      visibility: 'private',
      archived: false,
    } as const;
    const inventory = {
      installation: {
        installationId: '12345',
        accountId: '45678',
        accountLogin: 'acme',
        accountType: 'Organisation',
        status: 'active',
      },
      repositories: [repository],
    };

    expect(githubInstallationInventorySchema.parse(inventory)).toEqual(inventory);
    expect(() =>
      githubInstallationInventorySchema.parse({
        ...inventory,
        repositories: [repository, repository],
      }),
    ).toThrow();
    expect(() =>
      githubInstallationInventorySchema.parse({
        ...inventory,
        repositories: [{ ...repository, fullName: 'other/widget' }],
      }),
    ).toThrow();
    expect(
      githubInstallationInventorySchema.parse({
        installation: { ...inventory.installation, status: 'suspended' },
        repositories: [],
      }),
    ).toBeDefined();
    expect(() =>
      githubInstallationInventorySchema.parse({
        installation: { ...inventory.installation, status: 'removed' },
        repositories: [repository],
      }),
    ).toThrow();
  });

  it('requires all seven confirmed changes and evidence references', () => {
    expect(migrationPlanSchema.parse(validPlan)).toEqual(validPlan);
    expect(() =>
      migrationPlanSchema.parse({
        ...validPlan,
        changes: validPlan.changes.slice(0, 6),
      }),
    ).toThrow();
    expect(() =>
      migrationPlanSchema.parse({
        ...validPlan,
        changes: [...validPlan.changes.slice(0, 6), validPlan.changes[0]],
      }),
    ).toThrow();
    expect(() =>
      migrationPlanSchema.parse({
        ...validPlan,
        evidence: [...validPlan.evidence.slice(0, 6), validPlan.evidence[0]],
      }),
    ).toThrow();
  });

  it('requires result and terminal state to agree', () => {
    const base = {
      schemaVersion: '1.0',
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      agentRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      model: {
        provider: 'openai',
        requestedModel: 'gpt-5.6-sol',
        returnedModel: 'gpt-5.6-sol',
        reasoningEffort: 'medium',
        requestId: null,
      },
      usage: {
        modelCalls: 1,
        toolCalls: 1,
        iterations: 1,
        inputTokens: 100,
        outputTokens: 100,
        durationMs: 1000,
      },
      actions: [],
    } as const;
    expect(
      agentResultEnvelopeSchema.parse({
        ...base,
        terminal: { code: 'completed', safeErrorCode: null },
        result: validPlan,
      }),
    ).toBeDefined();
    expect(() =>
      agentResultEnvelopeSchema.parse({
        ...base,
        terminal: {
          code: 'infrastructure_failed',
          safeErrorCode: 'AGENT_FAILED',
        },
        result: validPlan,
      }),
    ).toThrow();
  });
});
