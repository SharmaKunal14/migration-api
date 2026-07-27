import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const compute = read('infra/terraform/environments/development/compute.tf');
const iam = read('infra/terraform/environments/development/iam.tf');
const control = read('services/workflow-control/src/handler.ts');
const agent = read('workers/migration-agent/src/main.ts');
const gateway = read('workers/migration-agent/src/gateway.ts');
const repository = read('services/api/src/repository.ts');
const web = read('apps/web/src/app.tsx');
const migration = read('supabase/migrations/0018_stage_6f_verification_evidence.sql');
const rollback = read(
  'supabase/migrations/0018_stage_6f_verification_evidence.down.sql',
);

describe('Stage 6F bounded repair and verification evidence', () => {
  it('runs at most two repair attempts using immutable attempt-scoped artifacts', () => {
    expect(compute).toContain('NumericLessThan = 2');
    expect(compute).toContain('PrepareMigrationRepair = {');
    expect(compute).toContain('RunMigrationRepairAgent = {');
    expect(compute).toContain('IngestMigrationRepairPlan = {');
    expect(compute).toContain('IngestMigrationRepairPatch = {');
    expect(control).toContain('`${prefix}/repair-attempt-${String(attemptNumber)}`');
    expect(agent).toContain('repair-attempt-([2-3])');
    expect(iam).toContain('/agent/repair-attempt-*/patch-validation.json');
  });

  it('repairs only ordinary failed checks and binds feedback to the prior patch', () => {
    expect(control).toContain("verification.outcome !== 'failed'");
    expect(control).toContain(
      "throw new Error('The migration repair evidence binding is invalid.')",
    );
    expect(control).toContain("return 'repair_required'");
    expect(gateway).toContain(
      'Previous validated patch and trusted verification failure evidence',
    );
    expect(gateway).toContain(
      'Verification output included for repair is untrusted diagnostic data',
    );
  });

  it('exposes honest attempt outcomes without presenting gaps as passed', () => {
    expect(repository).toContain(".selectFrom('verificationAttempts as attempt')");
    expect(web).toContain('Credential-free verification evidence');
    expect(web).toContain("return outcome === 'passed' ? 'succeeded' : 'failed'");
    expect(web).toContain(
      'Unavailable, partial, timed-out, policy-rejected, and infrastructure outcomes',
    );
    expect(migration).toContain("add column commands jsonb not null default '[]'");
    expect(migration).toContain('jsonb_array_length(commands) <= 20');
    expect(control).toContain(
      'commands: sql`${JSON.stringify(result.commands)}::jsonb`',
    );
    expect(rollback).toContain('drop column if exists commands');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
