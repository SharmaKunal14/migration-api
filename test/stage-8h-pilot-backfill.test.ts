import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { packageReleasePilotBackfillRequestSchema } from '@migration/contracts';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const migration = source('supabase/migrations/0032_pilot_current_release_backfill.sql');
const repository = source('services/api/src/repository.ts');
const web = source('apps/web/src/app.tsx');

describe('Stage 8H current release pilot backfill', () => {
  it('accepts only an optimistic mapping revision from the operator', () => {
    expect(
      packageReleasePilotBackfillRequestSchema.safeParse({
        expectedMappingVersion: 3,
      }).success,
    ).toBe(true);
    expect(
      packageReleasePilotBackfillRequestSchema.safeParse({
        expectedMappingVersion: 3,
        sourceVersion: '1.0.0',
        targetVersion: '9.9.9',
        sourceUrl: 'https://attacker.example/package',
      }).success,
    ).toBe(false);
  });

  it('derives one current direct-dependency version and reuses trusted poll evidence', () => {
    expect(migration).toContain('if not is_platform_operator(p_operator_user_id)');
    expect(migration).toContain("observation.dependency_kind = 'dependency'");
    expect(migration).toContain('array_agg(distinct observation.resolved_version');
    expect(migration).toContain('cardinality(observed_versions) <> 1');
    expect(migration).toContain("run.status = 'succeeded'");
    expect(migration).toContain(
      'run.observed_version = current_mapping.latest_version',
    );
    expect(migration).toContain("source.canonical_domain = 'registry.npmjs.org'");
  });

  it('registers through the existing release trigger and records operator provenance', () => {
    expect(migration).toContain('insert into package_release_detections');
    expect(migration).toContain("'package_release.pilot_backfill_requested'");
    expect(migration).toContain('insert into platform_audit_events');
    expect(migration).toContain('grant execute on function');
    expect(migration).not.toContain('grant insert on package_release_detections');
    expect(repository).toContain("action', '=', 'package_release:pilot_backfill'");
  });

  it('keeps the operator interaction bounded and explains the derived authority', () => {
    expect(web).toContain('Ingest current release');
    expect(web).toContain('No version or source URL can be entered');
    expect(web).toContain('requestPackageReleasePilotBackfill');
  });
});
