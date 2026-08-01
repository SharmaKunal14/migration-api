import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0022_stage_8b_npm_registry_resolution.sql',
    import.meta.url,
  ),
  'utf8',
);
const claimAmbiguityFix = readFileSync(
  new URL(
    '../supabase/migrations/0023_fix_package_source_claim_ambiguity.sql',
    import.meta.url,
  ),
  'utf8',
);
const handler = readFileSync(
  new URL('../services/package-source-resolver/src/handler.ts', import.meta.url),
  'utf8',
);
const compute = readFileSync(
  new URL('../infra/terraform/environments/development/compute.tf', import.meta.url),
  'utf8',
);
const iam = readFileSync(
  new URL('../infra/terraform/environments/development/iam.tf', import.meta.url),
  'utf8',
);

describe('Stage 8B npm source resolution boundary', () => {
  it('claims bounded work with leases and skip-locked concurrency', () => {
    expect(migration).toContain('for update skip locked');
    expect(migration).toContain('p_limit > 10');
    expect(migration).toContain('p_lease_seconds > 300');
    expect(migration).toContain('mapping.attempt_count < 5');
    expect(migration).toContain("resolver_now - interval '1 hour'");
    expect(migration).toContain('clock_timestamp()');
  });

  it('qualifies claim columns that conflict with PL/pgSQL output variables', () => {
    expect(claimAmbiguityFix).toContain(
      'update package_source_resolution_runs as resolution_run',
    );
    expect(claimAmbiguityFix).toContain('where resolution_run.mapping_id = claimed.id');
    expect(claimAmbiguityFix).toContain("and resolution_run.status = 'running'");
    expect(claimAmbiguityFix).not.toContain('where mapping_id = claimed.id');
  });

  it('stores candidates as untrusted pending review records', () => {
    expect(migration).toContain("review_state text not null default 'pending_review'");
    expect(migration).toContain("set status = 'needs_review'");
    expect(migration).not.toMatch(
      /insert into vendor_sources|set\s+trust_state\s*=\s*'trusted'/iu,
    );
  });

  it('exposes procedures rather than table mutation to the runtime role', () => {
    expect(migration).toContain(
      'revoke all on package_source_resolution_runs from public, anon, authenticated, app_runtime;',
    );
    expect(migration).toContain(
      'revoke all on package_source_candidates from public, anon, authenticated, app_runtime;',
    );
    expect(migration).toContain('to app_runtime;');
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete)[\s\S]*package_source_(?:resolution_runs|candidates)[\s\S]*to app_runtime/iu,
    );
  });

  it('pins registry origin and persists encrypted, checksummed normalized evidence', () => {
    expect(compute).toContain('NPM_REGISTRY_ORIGIN  = "https://registry.npmjs.org"');
    expect(handler).toContain("ServerSideEncryption: 'aws:kms'");
    expect(handler).toContain('ChecksumSHA256:');
    expect(handler).toContain("'package-source'");
    expect(iam).toContain('actions   = ["s3:PutObject"]');
    expect(iam).toContain('/env/development/package-source/npm/*');
  });

  it('runs a single bounded scheduled resolver with an exact input contract', () => {
    expect(compute).toContain('reserved_concurrent_executions = 1');
    expect(compute).toContain('schedule_expression          = "rate(5 minutes)"');
    expect(compute).toContain('input    = jsonencode({ operation = "resolve_due" })');
    expect(handler).toContain('const BATCH_SIZE = 5;');
    expect(handler).toContain('const LEASE_SECONDS = 120;');
  });
});
