import { describe, expect, it } from 'vitest';

import {
  InvalidModelOutputError,
  parseMigrationPlanOutput,
} from '@migration/model-gateway';

import { validPlan } from './fixtures/migration-plan.js';

describe('model output validation', () => {
  it('accepts a schema-valid migration plan', () => {
    expect(parseMigrationPlanOutput(JSON.stringify(validPlan))).toEqual(validPlan);
  });

  it.each([
    [undefined, 'MODEL_OUTPUT_MISSING'],
    ['not-json', 'MODEL_OUTPUT_INVALID_JSON'],
    [JSON.stringify({ ...validPlan, changes: [] }), 'MODEL_OUTPUT_SCHEMA_INVALID'],
  ] as const)('classifies rejected output without retaining it', (output, safeCode) => {
    let thrown: unknown;
    try {
      parseMigrationPlanOutput(output);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidModelOutputError);
    if (!(thrown instanceof InvalidModelOutputError)) {
      throw new Error('Expected InvalidModelOutputError.');
    }
    expect(thrown.safeCode).toBe(safeCode);
    if (output) {
      expect(thrown.message).not.toContain(output);
    }
  });
});
