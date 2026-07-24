import { describe, expect, it } from 'vitest';

import {
  agentResultEnvelopeSchema,
  demoRunRequestSchema,
  migrationPlanSchema,
  workflowInputSchema,
  type MigrationPlan,
} from '@migration/contracts';

export const validPlan: MigrationPlan = {
  schemaVersion: '1.0',
  scenarioId: 'orbitchat-typescript-v1-v2',
  packageName: '@orbitchat/sdk',
  sourceCompatibility: '1.x',
  targetVersion: '2.0.0',
  changes: [
    {
      changeId: 'C-01',
      category: 'request',
      summary: 'messages.send becomes messages.create',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-01'],
    },
    {
      changeId: 'C-02',
      category: 'request',
      summary: 'room becomes channelId',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-02'],
    },
    {
      changeId: 'C-03',
      category: 'request',
      summary: 'text becomes content',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-03'],
    },
    {
      changeId: 'C-04',
      category: 'behavior',
      summary:
        'Explicit notify maps to notification.enabled; omission remains unresolved',
      certainty: 'unresolved',
      evidenceIds: ['C-04'],
    },
    {
      changeId: 'C-05',
      category: 'response',
      summary: 'message_id becomes id',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-05'],
    },
    {
      changeId: 'C-06',
      category: 'response',
      summary: 'created_at becomes createdAt',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-06'],
    },
    {
      changeId: 'C-07',
      category: 'runtime',
      summary: 'Node.js 22 is required',
      certainty: 'vendor_confirmed',
      evidenceIds: ['C-07'],
    },
  ],
  evidence: ['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07'].map(
    evidenceId => ({
      evidenceId,
      summary: `Evidence for ${evidenceId}`,
    }),
  ),
  unresolved: ['Notification defaults vary by account policy.'],
  verificationRecommendations: ['typescript_static', 'typescript_unit'],
  reviewerNotes: ['Review notification behavior for the target account.'],
};

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

  it('requires all seven changes and unresolved ambiguity', () => {
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
        changes: validPlan.changes.map(change => ({
          ...change,
          certainty: 'vendor_confirmed',
        })),
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
