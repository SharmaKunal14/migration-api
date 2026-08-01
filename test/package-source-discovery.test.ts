import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  normalizeNpmPackageNames,
  PackageSourceDiscoveryError,
} from '@migration/package-source-discovery';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0021_stage_8a_package_source_discovery.sql',
    import.meta.url,
  ),
  'utf8',
);
const scanControl = readFileSync(
  new URL('../services/repository-scan-control/src/handler.ts', import.meta.url),
  'utf8',
);

describe('npm package source discovery', () => {
  it('normalizes unique package names deterministically', () => {
    expect(
      normalizeNpmPackageNames(['zod', '@supabase/supabase-js', 'zod', 'react']),
    ).toEqual(['@supabase/supabase-js', 'react', 'zod']);
  });

  it.each(['', '../package', '@scope', 'package name', 'https://example.com'])(
    'rejects invalid package name %j',
    packageName => {
      expect(() => normalizeNpmPackageNames([packageName])).toThrow(
        new PackageSourceDiscoveryError('PACKAGE_SOURCE_NAME_INVALID'),
      );
    },
  );

  it('rejects an unbounded discovery batch', () => {
    const packageNames = Array.from(
      { length: 10_001 },
      (_, index) => `pkg-${String(index)}`,
    );
    expect(() => normalizeNpmPackageNames(packageNames)).toThrow(
      new PackageSourceDiscoveryError('PACKAGE_SOURCE_DISCOVERY_LIMIT_EXCEEDED'),
    );
  });

  it('keeps trust promotion outside the repository scan runtime', () => {
    expect(migration).toContain("'pending_registry_lookup'");
    expect(migration).toContain(
      'revoke all on package_source_mappings from anon, authenticated, app_runtime;',
    );
    expect(migration).toContain(
      'grant execute on function observe_npm_package_sources(text[], timestamptz)',
    );
    expect(migration).toContain("vendor.trust_state = 'trusted'");
    expect(migration).toContain("source.trust_state = 'trusted'");
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete)[\s\S]*package_source_mappings[\s\S]*to app_runtime/iu,
    );
  });

  it('records mappings as part of successful repository scan persistence', () => {
    expect(scanControl).toContain('await observeNpmPackageSources(');
    expect(scanControl).toContain(
      'inventoryResult.observations.map(observation => observation.packageName)',
    );
  });
});
