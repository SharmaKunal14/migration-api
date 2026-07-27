import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationAgentCheckpointSchema,
  migrationAgentCheckpointSequence,
} from '@migration/contracts';

const migration = read(
  'supabase/migrations/0020_fix_agent_checkpoint_global_sequence.sql',
);
const rollback = read(
  'supabase/migrations/0020_fix_agent_checkpoint_global_sequence.down.sql',
);

const binding = {
  migrationRunId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
  approvalId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
  baseCommitSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  migrationSpecification: {
    id: 'e4e2d9db-bd1c-4eef-b685-231128724583',
    revision: 1,
    digest: 'c'.repeat(64),
  },
  impactReport: {
    id: '12a906c7-f7df-4c65-9137-70bcf17eec86',
    revision: 1,
    digest: 'd'.repeat(64),
  },
} as const;

describe('migration-agent checkpoint global sequencing', () => {
  it('allocates a disjoint three-sequence range to every bounded attempt', () => {
    expect([
      migrationAgentCheckpointSequence(1, 1),
      migrationAgentCheckpointSequence(1, 2),
      migrationAgentCheckpointSequence(1, 3),
    ]).toEqual([1, 2, 3]);
    expect([
      migrationAgentCheckpointSequence(2, 1),
      migrationAgentCheckpointSequence(2, 2),
      migrationAgentCheckpointSequence(2, 3),
    ]).toEqual([4, 5, 6]);
    expect(migrationAgentCheckpointSequence(3, 3)).toBe(9);
    expect(() => migrationAgentCheckpointSequence(2, 0)).toThrow();
    expect(() => migrationAgentCheckpointSequence(11, 1)).toThrow();
  });

  it('rejects a repair checkpoint that reuses the base-attempt range', () => {
    const checkpoint = {
      schemaVersion: '1.0',
      binding,
      attemptNumber: 2,
      sequence: 4,
      phase: 'context',
      lastActionSequence: 0,
      remainingBudget: { modelCalls: 6, toolCalls: 40, iterations: 6 },
      planDigest: null,
      patchDigest: null,
    } as const;
    expect(migrationAgentCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(() =>
      migrationAgentCheckpointSchema.parse({ ...checkpoint, sequence: 1 }),
    ).toThrow();
    expect(() =>
      migrationAgentCheckpointSchema.parse({ ...checkpoint, sequence: 7 }),
    ).toThrow();
  });

  it('adds a database range check without weakening global uniqueness', () => {
    expect(migration).toContain(
      'migration_agent_checkpoints_attempt_sequence_range_check',
    );
    expect(migration).toContain(
      'sequence between ((attempt_number - 1) * 3 + 1) and (attempt_number * 3)',
    );
    expect(migration).not.toContain(
      'drop constraint migration_agent_checkpoints_migration_run_id_sequence_key',
    );
    expect(rollback).toContain(
      'drop constraint if exists\n    migration_agent_checkpoints_attempt_sequence_range_check',
    );
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
