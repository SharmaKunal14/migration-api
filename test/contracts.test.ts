import { describe, expect, it } from 'vitest';

import {
  agentResultEnvelopeSchema,
  demoRunRequestSchema,
  migrationPlanSchema,
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
