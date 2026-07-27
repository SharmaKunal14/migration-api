import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0015_fix_artifact_object_key_regex.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Stage 5B artifact object key regression', () => {
  it('removes the unsupported PostgreSQL repetition bound', () => {
    expect(migration).not.toContain('[A-Za-z0-9._/-]{1,512}');
    expect(migration).toContain('[A-Za-z0-9._/-]+$');
    expect(migration).toContain('length(object_key) between 1 and 1024');
  });

  it('finds exactly one affected constraint before replacing it', () => {
    expect(migration).toContain("'migration_artifacts'::regclass");
    expect(migration).toContain("'{1,512}'");
    expect(migration).toContain('if constraint_count <> 1 then');
    expect(migration).toContain('add constraint migration_artifacts_object_key_check');
  });

  it('retains the object key trust-boundary checks', () => {
    expect(migration).toContain("object_key !~ '^/'");
    expect(migration).toContain("object_key !~ '//'");
    expect(migration).toContain("object_key !~ '(^|/)\\.\\.?(/|$)'");
    expect(migration).toContain(String.raw`object_key !~ '\\'`);
    expect(migration).toContain("object_key !~ '[[:cntrl:]]'");
  });
});
