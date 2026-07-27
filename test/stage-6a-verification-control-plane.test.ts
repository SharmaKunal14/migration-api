import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationVerificationPreparedInputSchema,
  migrationVerificationResultSchema,
  verificationTerminalOutcomeSchema,
} from '@migration/contracts';

const organisationId = '07a17d5a-820d-4199-93d9-4e71b1c2d4f5';
const repositoryId = 'fb88f567-56f6-4151-8a42-c84981f49ec6';
const migrationRunId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const approvalId = '8955ed33-d1d8-4fdb-bd48-3a0835562934';
const verificationAttemptId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const patchAttemptId = '12a906c7-f7df-4c65-9137-70bcf17eec86';
const snapshotArtifactId = '32b9664f-12c0-4276-aea5-46938b6f5a97';
const patchArtifactId = '51862bc4-9e1a-49a9-a4bf-376eae3f52b6';
const validationArtifactId = '74218edf-4836-4b41-8f6c-1525c5fa1075';

const prepared = {
  status: 'ready',
  schemaVersion: '1.0',
  organisationId,
  repositoryId,
  migrationRunId,
  approvalId,
  verificationAttemptId,
  attemptNumber: 1,
  patchAttemptId,
  baseCommitSha: 'a'.repeat(40),
  snapshot: {
    artifactId: snapshotArtifactId,
    objectKey: `env/development/org/${organisationId}/run/${migrationRunId}/input/source/snapshot.tar.gz`,
    digest: 'b'.repeat(64),
  },
  patch: {
    artifactId: patchArtifactId,
    objectKey: `env/development/org/${organisationId}/run/${migrationRunId}/agent/proposal.diff`,
    digest: 'c'.repeat(64),
    validationArtifactId,
    validationObjectKey: `env/development/org/${organisationId}/run/${migrationRunId}/agent/patch-validation.json`,
    validationDigest: 'd'.repeat(64),
  },
  authority: {
    verificationPolicyVersion: 'typescript-default-1.0',
    verificationProfile: {
      schemaVersion: '1.0',
      profiles: [
        {
          profile: 'typescript_static',
          availability: 'available',
          commandIds: ['npm.typecheck'],
        },
        {
          profile: 'typescript_unit',
          availability: 'available',
          commandIds: ['npm.test'],
        },
      ],
    },
    verificationProfileDigest: 'e'.repeat(64),
  },
} as const;

const passedResult = {
  schemaVersion: '1.0',
  organisationId,
  repositoryId,
  migrationRunId,
  approvalId,
  verificationAttemptId,
  attemptNumber: 1,
  patchAttemptId,
  baseCommitSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  patchDigest: 'c'.repeat(64),
  patchValidationDigest: 'd'.repeat(64),
  verificationPolicyVersion: 'typescript-default-1.0',
  verificationProfileDigest: 'e'.repeat(64),
  outcome: 'passed',
  safeErrorCode: null,
  commands: [
    {
      commandId: 'npm.typecheck',
      status: 'passed',
      exitCode: 0,
      signal: null,
      durationMs: 1_000,
      stdoutTruncated: false,
      stderrTruncated: false,
    },
  ],
  artifacts: {
    stdout: {
      objectKey: `env/development/org/${organisationId}/run/${migrationRunId}/verification/attempt-1/stdout.log`,
      digest: 'f'.repeat(64),
      bytes: 128,
    },
    stderr: null,
  },
  startedAt: '2026-07-27T00:00:00.000Z',
  completedAt: '2026-07-27T00:00:01.000Z',
} as const;

describe('Stage 6A verification control plane', () => {
  it('binds preparation to exact approved source, patch, policy, and profile evidence', () => {
    expect(migrationVerificationPreparedInputSchema.parse(prepared)).toEqual(prepared);
    expect(() =>
      migrationVerificationPreparedInputSchema.parse({
        ...prepared,
        patch: {
          ...prepared.patch,
          digest: 'not-a-digest',
        },
      }),
    ).toThrow();
    expect(() =>
      migrationVerificationPreparedInputSchema.parse({
        ...prepared,
        authority: {
          ...prepared.authority,
          verificationProfile: {
            schemaVersion: '1.0',
            profiles: [
              {
                profile: 'typescript_static',
                availability: 'unavailable',
                commandIds: ['npm.typecheck'],
              },
            ],
          },
        },
      }),
    ).toThrow();
  });

  it('never classifies incomplete, failed, unavailable, or timed-out checks as passed', () => {
    expect(migrationVerificationResultSchema.parse(passedResult).outcome).toBe(
      'passed',
    );
    expect(verificationTerminalOutcomeSchema.options).toEqual([
      'passed',
      'failed',
      'partial',
      'unavailable',
      'timed_out',
      'policy_rejected',
      'infrastructure_failed',
    ]);
    for (const outcome of [
      'partial',
      'unavailable',
      'infrastructure_failed',
    ] as const) {
      expect(
        migrationVerificationResultSchema.parse({
          ...passedResult,
          outcome,
          safeErrorCode: 'VERIFICATION_DID_NOT_PASS',
        }).outcome,
      ).toBe(outcome);
    }
    for (const [outcome, commandStatus, exitCode] of [
      ['failed', 'failed', 1],
      ['timed_out', 'timed_out', null],
      ['policy_rejected', 'policy_rejected', null],
    ] as const) {
      expect(
        migrationVerificationResultSchema.parse({
          ...passedResult,
          outcome,
          safeErrorCode: 'VERIFICATION_DID_NOT_PASS',
          commands: [
            {
              ...passedResult.commands[0],
              status: commandStatus,
              exitCode,
            },
          ],
        }).outcome,
      ).toBe(outcome);
    }
    expect(() =>
      migrationVerificationResultSchema.parse({
        ...passedResult,
        commands: [
          {
            ...passedResult.commands[0],
            status: 'failed',
            exitCode: 1,
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      migrationVerificationResultSchema.parse({
        ...passedResult,
        outcome: 'partial',
      }),
    ).toThrow();
    expect(() =>
      migrationVerificationResultSchema.parse({
        ...passedResult,
        completedAt: '2026-07-26T23:59:59.000Z',
      }),
    ).toThrow();
  });

  it('creates immutable tenant-bound attempts and append-only terminal results', () => {
    const migration = read(
      'supabase/migrations/0017_stage_6a_verification_control_plane.sql',
    );
    const rollback = read(
      'supabase/migrations/0017_stage_6a_verification_control_plane.down.sql',
    );

    expect(migration).toContain('create table verification_attempts');
    expect(migration).toContain('create table verification_attempt_results');
    expect(migration).toContain('patch_attempts_verification_binding_unique unique');
    expect(migration).toMatch(
      /foreign key \(\s*migration_run_id,\s*organisation_id,\s*approval_id,\s*base_commit_sha\s*\)/u,
    );
    expect(migration).toMatch(
      /foreign key \(\s*patch_attempt_id,\s*organisation_id,\s*migration_run_id,\s*patch_artifact_id,\s*patch_digest,\s*patch_validation_artifact_id,\s*patch_validation_digest\s*\)/u,
    );
    expect(migration).toContain('verification_attempts_immutable');
    expect(migration).toContain('verification_attempt_results_immutable');
    expect(migration).toContain("outcome = 'passed'");
    expect(migration).toContain('safe_error_code is null');
    expect(migration).toContain(
      "artifact_type = 'source_snapshot' and bytes between 1 and 268435456",
    );
    expect(migration).toContain(
      "artifact_type = 'source_snapshot' and media_type = 'application/gzip'",
    );
    expect(migration).not.toMatch(/grant select, insert, update on\s+verification_/u);
    expect(rollback).toContain('drop table if exists verification_attempt_results');
    expect(rollback).toContain('drop table if exists verification_attempts');
  });

  it('prepares exactly one attempt before retaining the closed verifier boundary', () => {
    const compute = read('infra/terraform/environments/development/compute.tf');
    const control = read('services/workflow-control/src/handler.ts');
    const verifierState = compute.slice(
      compute.indexOf('RunVerifier = {'),
      compute.indexOf('CheckRepairBudget = {'),
    );

    expect(verifierState).toContain('operation    = "prepare_migration_verification"');
    expect(verifierState).toContain('EvaluateVerificationPreparation');
    expect(verifierState).toContain('CheckVerifierCapability');
    expect(verifierState).toContain(
      'operation    = "evaluate_migration_stage_capability"',
    );
    expect(verifierState).not.toContain('ecs:runTask.sync');
    expect(control).toContain('async function prepareMigrationVerification(');
    expect(control).toContain(".where('patchAttemptId', '=', source.patchAttemptId)");
    expect(control).toContain("eventType: 'verification_prepared'");
    expect(control).toContain('migrationApprovalVerificationProfileSchema.parse');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
