import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { dependencyMatchesSourceCompatibility } from '@migration/candidate-matching';
import type { CandidateMatchingError } from '@migration/candidate-matching';

describe('Stage 3D semver matching', () => {
  it('prefers an exact resolved version when one is available', () => {
    expect(
      dependencyMatchesSourceCompatibility(
        {
          declaredRange: 'git+https://github.com/vendor/sdk.git#v1.0.0',
          resolvedVersion: '1.0.0',
        },
        '1.x',
      ),
    ).toBe(true);
    expect(
      dependencyMatchesSourceCompatibility(
        { declaredRange: '^1.0.0', resolvedVersion: '2.0.0' },
        '1.x',
      ),
    ).toBe(false);
  });

  it('matches an unresolved declaration only when its full range is supported', () => {
    expect(
      dependencyMatchesSourceCompatibility(
        { declaredRange: '^1.2.0', resolvedVersion: null },
        '1.x',
      ),
    ).toBe(true);
    expect(
      dependencyMatchesSourceCompatibility(
        { declaredRange: '>=1.0.0', resolvedVersion: null },
        '1.x',
      ),
    ).toBe(false);
    expect(
      dependencyMatchesSourceCompatibility(
        { declaredRange: 'workspace:*', resolvedVersion: null },
        '1.x',
      ),
    ).toBe(false);
  });

  it('fails closed for an invalid specification compatibility range', () => {
    expect(() =>
      dependencyMatchesSourceCompatibility(
        { declaredRange: '^1.0.0', resolvedVersion: null },
        'not-semver',
      ),
    ).toThrow(
      expect.objectContaining<Partial<CandidateMatchingError>>({
        safeCode: 'SOURCE_COMPATIBILITY_INVALID',
      }),
    );
  });
});

describe('Stage 3D database authority', () => {
  const migration = readFileSync(
    new URL('../supabase/migrations/0007_stage_3d.sql', import.meta.url),
    'utf8',
  );

  it('requires an active platform operator and preserves immutable draft content', () => {
    expect(migration).toContain('create table platform_operators');
    expect(migration).toMatch(
      /if not is_platform_operator\(p_operator_user_id\)[\s\S]*errcode = '42501'/iu,
    );
    expect(migration).toContain(
      "(p_specification - 'trust')\n      is distinct from (current_specification.specification - 'trust')",
    );
    expect(migration).toMatch(
      /update vendor_releases[\s\S]*set trust_state = 'reviewed'[\s\S]*trust_state = 'draft'/iu,
    );
    expect(migration).toContain("'migration_specification.reviewed'");
  });

  it('exposes narrow functions instead of direct runtime table mutation', () => {
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete)[\s\S]*migration_(?:specifications|candidates)[\s\S]*to app_runtime/iu,
    );
    expect(migration).toContain(
      'grant execute on function promote_migration_specification(',
    );
    expect(migration).toContain(
      'grant execute on function reconcile_migration_candidate(',
    );
  });

  it('binds candidates to the latest available selected repository snapshot', () => {
    expect(migration).toContain(
      'observation.organisation_id = repository_organisation_id',
    );
    expect(migration).toContain('observation.package_name = product_identifier');
    expect(migration).toMatch(
      /not exists \([\s\S]*from repository_snapshots as newer_snapshot[\s\S]*newer_snapshot\.status = 'available'/iu,
    );
    expect(migration).toContain("installation.status = 'active'");
  });
});
