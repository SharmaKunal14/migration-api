import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { migrationAcquisitionResultSchema } from '@migration/contracts';

const compute = read('infra/terraform/environments/development/compute.tf');
const iam = read('infra/terraform/environments/development/iam.tf');
const broker = read('services/github-token-broker/src/handler.ts');
const fetcher = read('workers/source-fetcher/src/main.ts');
const control = read('services/workflow-control/src/handler.ts');
const migration = read(
  'supabase/migrations/0014_stage_5b_exact_source_acquisition.sql',
);

describe('Stage 5B exact source acquisition', () => {
  it('uses a strict migration result contract', () => {
    const valid = migrationAcquisitionResultSchema.parse({
      schemaVersion: '1.0',
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      repositoryId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      migrationRunId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      approvalId: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
      status: 'stale',
      safeErrorCode: 'MIGRATION_SNAPSHOT_DIGEST_MISMATCH',
      snapshot: null,
    });
    expect(valid.status).toBe('stale');
    expect(() =>
      migrationAcquisitionResultSchema.parse({
        ...valid,
        status: 'succeeded',
      }),
    ).toThrow();
  });

  it('binds the token and archive to the migration run and approved commit', () => {
    expect(broker).toContain('issue_migration_repository_read_token');
    expect(broker).toContain("run.currentStage', '=', 'acquiring'");
    expect(broker).toContain("permissions: { contents: 'read' }");
    expect(fetcher).toContain('access.commitSha');
    expect(fetcher).toContain('normalized.digest !== access.snapshotDigest');
    expect(fetcher).not.toContain('exec(');
  });

  it('runs the existing hardened fetcher and ingests before planning', () => {
    expect(compute).toContain('Resource       = "arn:aws:states:::ecs:runTask.sync"');
    expect(compute).toContain('Value = "migration"');
    expect(compute).toContain('IngestMigrationAcquisition');
    expect(control).toContain("currentStage: 'planning'");
    expect(control).toContain('isMigrationApprovalStale');
  });

  it('scopes storage access to acquisition prefixes and persists immutable evidence', () => {
    expect(iam).toContain('/run/*/input/*');
    expect(iam).toContain('/input/acquisition-result.json');
    expect(migration).toContain("'source_snapshot'");
    expect(migration).toContain('migration_artifacts_source_snapshot_run_unique');
    expect(migration).toContain("'source_acquired'");
  });

  it('discovers pre-existing generated constraint names from the catalog', () => {
    expect(migration).toContain('from pg_constraint as constraint_definition');
    expect(migration).toContain('pg_get_constraintdef');
    expect(migration).not.toContain('drop constraint migration_artifacts_bytes_check');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
