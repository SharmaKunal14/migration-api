import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationAgentCheckpointSchema,
  migrationExecutionPlanSchema,
  migrationPatchManifestSchema,
  migrationPatchValidationResultSchema,
} from '@migration/contracts';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0013_stage_5a_patch_control_plane.sql',
    import.meta.url,
  ),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../supabase/migrations/0013_stage_5a_patch_control_plane.down.sql',
    import.meta.url,
  ),
  'utf8',
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

const plan = {
  schemaVersion: '1.0',
  binding,
  attemptNumber: 1,
  trust: {
    status: 'proposed',
    generatedBy: 'migration_agent',
  },
  summary: 'Migrate the approved OrbitChat call sites and dependency metadata.',
  files: [
    {
      path: 'src/orbitchat-client.ts',
      operation: 'modify',
      changeCategory: 'direct_usage',
      rationale: 'Use the reviewed OrbitChat v2 request and response contract.',
      evidenceChangeIds: ['C-01', 'C-02', 'C-03'],
      transformationIds: ['C-01', 'C-02', 'C-03'],
    },
    {
      path: 'package.json',
      operation: 'modify',
      changeCategory: 'dependency_manifest',
      rationale: 'Move the approved dependency from OrbitChat v1 to v2.',
      evidenceChangeIds: ['C-07'],
      transformationIds: [],
    },
  ],
  unresolved: [
    {
      code: 'NOTIFICATION_DEFAULT_UNRESOLVED',
      summary: 'The default notification behaviour still requires human judgement.',
    },
  ],
  verificationProfiles: ['typescript_static', 'typescript_unit'],
} as const;

const patchManifest = {
  schemaVersion: '1.0',
  proposalStatus: 'unvalidated',
  binding,
  attemptNumber: 1,
  planDigest: 'e'.repeat(64),
  patchDigest: 'f'.repeat(64),
  patchBytes: 4_096,
  changedFiles: 2,
  addedLines: 8,
  deletedLines: 7,
  files: [
    {
      path: 'src/orbitchat-client.ts',
      operation: 'modify',
      changeCategory: 'direct_usage',
      beforeDigest: '1'.repeat(64),
      afterDigest: '2'.repeat(64),
      hunkCount: 2,
      addedLines: 6,
      deletedLines: 6,
    },
    {
      path: 'package.json',
      operation: 'modify',
      changeCategory: 'dependency_manifest',
      beforeDigest: '3'.repeat(64),
      afterDigest: '4'.repeat(64),
      hunkCount: 1,
      addedLines: 2,
      deletedLines: 1,
    },
  ],
} as const;

const policyChecks = [
  'base_binding',
  'diff_structure',
  'path_safety',
  'allowed_paths',
  'forbidden_paths',
  'binary_files',
  'change_budget',
] as const;

describe('Stage 5A patch control plane', () => {
  it('accepts a bounded plan tied to immutable approved evidence', () => {
    expect(migrationExecutionPlanSchema.parse(plan)).toEqual(plan);
  });

  it('rejects traversal, duplicate paths, and unbounded plan input', () => {
    expect(() =>
      migrationExecutionPlanSchema.parse({
        ...plan,
        files: [{ ...plan.files[0], path: '../secrets.txt' }],
      }),
    ).toThrow();
    expect(() =>
      migrationExecutionPlanSchema.parse({
        ...plan,
        files: [plan.files[0], plan.files[0]],
      }),
    ).toThrow();
    expect(() =>
      migrationExecutionPlanSchema.parse({
        ...plan,
        hiddenReasoning: 'Do not persist model chain-of-thought.',
      }),
    ).toThrow();
  });

  it('requires internally consistent patch manifests and file operations', () => {
    expect(migrationPatchManifestSchema.parse(patchManifest)).toEqual(patchManifest);
    expect(() =>
      migrationPatchManifestSchema.parse({
        ...patchManifest,
        changedFiles: 1,
      }),
    ).toThrow();
    expect(() =>
      migrationPatchManifestSchema.parse({
        ...patchManifest,
        files: [
          {
            ...patchManifest.files[0],
            operation: 'create',
            beforeDigest: '1'.repeat(64),
          },
        ],
        changedFiles: 1,
        addedLines: 6,
        deletedLines: 6,
      }),
    ).toThrow();
  });

  it('accepts a complete policy decision and rejects contradictory outcomes', () => {
    const accepted = {
      schemaVersion: '1.0',
      binding,
      attemptNumber: 1,
      planDigest: patchManifest.planDigest,
      patchDigest: patchManifest.patchDigest,
      policyVersion: 'typescript-bounded-1.0',
      policyDigest: '5'.repeat(64),
      status: 'accepted',
      safeErrorCode: null,
      checks: policyChecks.map(check => ({
        check,
        outcome: 'passed',
        safeErrorCode: null,
      })),
    } as const;
    expect(migrationPatchValidationResultSchema.parse(accepted)).toEqual(accepted);
    expect(
      migrationPatchValidationResultSchema.parse({
        ...accepted,
        status: 'rejected',
        safeErrorCode: 'PATCH_PATH_FORBIDDEN',
        checks: accepted.checks.map(check =>
          check.check === 'forbidden_paths'
            ? {
                ...check,
                outcome: 'failed',
                safeErrorCode: 'PATCH_PATH_FORBIDDEN',
              }
            : check,
        ),
      }),
    ).toBeDefined();
    expect(() =>
      migrationPatchValidationResultSchema.parse({
        ...accepted,
        status: 'rejected',
        safeErrorCode: 'PATCH_POLICY_REJECTED',
      }),
    ).toThrow();
  });

  it('stores only bounded structured checkpoint state', () => {
    const checkpoint = {
      schemaVersion: '1.0',
      binding,
      attemptNumber: 1,
      sequence: 1,
      phase: 'context',
      lastActionSequence: 0,
      remainingBudget: {
        modelCalls: 3,
        toolCalls: 30,
        iterations: 12,
      },
      planDigest: null,
      patchDigest: null,
    } as const;
    expect(migrationAgentCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(() =>
      migrationAgentCheckpointSchema.parse({
        ...checkpoint,
        prompt: 'Repository source does not belong in a checkpoint row.',
      }),
    ).toThrow();
    expect(() =>
      migrationAgentCheckpointSchema.parse({
        ...checkpoint,
        planDigest: '6'.repeat(64),
      }),
    ).toThrow();
    expect(() =>
      migrationAgentCheckpointSchema.parse({
        ...checkpoint,
        phase: 'patching',
        patchDigest: '7'.repeat(64),
      }),
    ).toThrow();
  });

  it('creates tenant-bound immutable artifact, plan, attempt, and checkpoint tables', () => {
    expect(migration).toContain('create table migration_artifacts');
    expect(migration).toContain('create table migration_plans');
    expect(migration).toContain('create table patch_attempts');
    expect(migration).toContain('create table migration_agent_checkpoints');
    expect(migration).toContain('migration_runs_patch_binding_unique');
    expect(migration).toMatch(
      /foreign key \(migration_run_id, organisation_id\)\s+references migration_runs/u,
    );
    expect(migration).toContain('migration_artifacts_immutable');
    expect(migration).toContain('migration_plans_immutable');
    expect(migration).toContain('patch_attempts_immutable');
    expect(migration).toContain('migration_agent_checkpoints_immutable');
    expect(migration).not.toMatch(/grant select, insert, update on\s+migration_/u);
  });

  it('keeps source and patch bodies out of database rows and supports rollback', () => {
    expect(migration).not.toContain('patch_body');
    expect(migration).not.toContain('source_body');
    expect(migration).not.toContain('prompt');
    expect(migration).not.toContain('reasoning');
    expect(migration).toContain('object_key text not null unique');
    expect(migration).toContain('|| organisation_id::text');
    expect(migration).toContain('|| migration_run_id::text');
    expect(migration).toContain("media_type = 'text/x-diff'");
    expect(migration).toContain('bytes between 1 and 1048576');
    expect(migration).toContain("retention_class in ('workflow_ephemeral', 'audit')");
    expect(rollback).toContain('drop table if exists patch_attempts');
    expect(rollback).toContain('drop table if exists migration_artifacts');
    expect(rollback).toContain(
      'drop constraint if exists migration_runs_patch_binding_unique',
    );
  });
});
