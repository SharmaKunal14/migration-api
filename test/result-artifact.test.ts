import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { safeErrorCode } from '@migration/observability';

import { validateResultArtifact } from '../services/api/src/handler.js';
import { validPlan } from './fixtures/migration-plan.js';

const organisationId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const runId = 'e4e2d9db-bd1c-4eef-b685-231128724583';

const validEnvelope = {
  schemaVersion: '1.0',
  organisationId,
  agentRunId: runId,
  model: {
    provider: 'openai',
    requestedModel: 'gpt-5.6-sol',
    returnedModel: 'gpt-5.6-sol',
    reasoningEffort: 'medium',
    requestId: '2a3d0a71-f36f-4b60-ab69-07fc397d6da5',
  },
  usage: {
    modelCalls: 2,
    toolCalls: 1,
    iterations: 2,
    inputTokens: 1_535,
    outputTokens: 808,
    durationMs: 13_369,
  },
  actions: [],
  terminal: {
    code: 'completed',
    safeErrorCode: null,
  },
  result: validPlan,
};

function encoded(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function metadata(bytes: Uint8Array): {
  readonly id: string;
  readonly organisationId: string;
  readonly resultBytes: string;
  readonly resultDigest: string;
} {
  return {
    id: runId,
    organisationId,
    resultBytes: String(bytes.byteLength),
    resultDigest: createHash('sha256').update(bytes).digest('hex'),
  };
}

function failureCode(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return safeErrorCode(error);
  }
  throw new Error('Expected result artifact validation to fail.');
}

describe('result artifact validation', () => {
  it('accepts a valid artifact when the database bigint is a decimal string', () => {
    const bytes = encoded(validEnvelope);

    expect(validateResultArtifact(metadata(bytes), bytes)).toEqual(validPlan);
  });

  it('rejects malformed and oversized database byte counts', () => {
    const bytes = encoded(validEnvelope);

    expect(
      failureCode(() =>
        validateResultArtifact({ ...metadata(bytes), resultBytes: '1.5' }, bytes),
      ),
    ).toBe('RESULT_ARTIFACT_METADATA_INVALID');
    expect(
      failureCode(() =>
        validateResultArtifact(
          { ...metadata(bytes), resultBytes: String(1024 * 1024 + 1) },
          bytes,
        ),
      ),
    ).toBe('RESULT_ARTIFACT_TOO_LARGE');
  });

  it('rejects missing or incorrectly sized object content', () => {
    const bytes = encoded(validEnvelope);

    expect(failureCode(() => validateResultArtifact(metadata(bytes), undefined))).toBe(
      'RESULT_ARTIFACT_READ_FAILED',
    );
    expect(
      failureCode(() =>
        validateResultArtifact(
          { ...metadata(bytes), resultBytes: String(bytes.byteLength + 1) },
          bytes,
        ),
      ),
    ).toBe('RESULT_ARTIFACT_SIZE_MISMATCH');
  });

  it('rejects content whose digest does not match persisted metadata', () => {
    const bytes = encoded(validEnvelope);

    expect(
      failureCode(() =>
        validateResultArtifact(
          { ...metadata(bytes), resultDigest: '0'.repeat(64) },
          bytes,
        ),
      ),
    ).toBe('RESULT_ARTIFACT_DIGEST_MISMATCH');
  });

  it('rejects invalid envelopes and ownership mismatches', () => {
    const invalidBytes = encoded({ schemaVersion: 'invalid' });
    expect(
      failureCode(() => validateResultArtifact(metadata(invalidBytes), invalidBytes)),
    ).toBe('RESULT_ARTIFACT_SCHEMA_INVALID');

    const validBytes = encoded(validEnvelope);
    expect(
      failureCode(() =>
        validateResultArtifact(
          {
            ...metadata(validBytes),
            organisationId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
          },
          validBytes,
        ),
      ),
    ).toBe('RESULT_ARTIFACT_OWNERSHIP_MISMATCH');
  });
});
