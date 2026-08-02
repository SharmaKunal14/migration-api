import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const migration = source(
  'supabase/migrations/0030_stage_8f_generic_release_ingestion.sql',
);
const compute = source('infra/terraform/environments/development/compute.tf');
const iam = source('infra/terraform/environments/development/iam.tf');
const dispatcher = source('services/outbox-dispatcher/src/handler.ts');
const repository = source('services/api/src/repository.ts');
const web = source('apps/web/src/app.tsx');

describe('Stage 8F generic release ingestion', () => {
  it('registers only trusted fixed-origin npm detections and emits one durable event', () => {
    expect(migration).toContain('create table release_intelligence_outbox');
    expect(migration).toContain('create function register_detected_package_release()');
    expect(migration).toContain("source.source_kind = 'package_registry_release'");
    expect(migration).toContain("source.canonical_domain = 'registry.npmjs.org'");
    expect(migration).toContain("source.trust_state = 'trusted'");
    expect(migration).toContain("vendor.trust_state = 'trusted'");
    expect(migration).toContain("new.status := 'suppressed'");
    expect(migration).toContain("'release-intelligence:' || existing_release.id::text");
    expect(migration).toContain('on conflict (aggregate_id) do nothing');
    expect(migration).toContain('state.last_observed_version into new.source_version');
    expect(migration).toContain(
      "tg_op = 'UPDATE' and old.vendor_release_id is not null",
    );
    expect(migration).toContain('new.evidence_digest := old.evidence_digest');
    expect(migration).toContain(
      'Do not overwrite its authority or let one collision abort polling.',
    );
  });

  it('keeps runtime outbox writes narrow and blocks ambiguous review in two layers', () => {
    expect(migration).toContain('grant update (');
    expect(migration).not.toContain(
      'grant select, update on release_intelligence_outbox to app_runtime',
    );
    expect(migration).toContain('migration_specifications_reviewed_certainty_check');
    expect(migration).toContain('@.certainty == "ambiguous"');
    expect(repository).toContain('MIGRATION_SPECIFICATION_AMBIGUOUS');
    expect(repository).toContain(
      "parsed.data.changes.some(change => change.certainty === 'ambiguous')",
    );
  });

  it('dispatches the durable event through ingestion and generic intelligence', () => {
    expect(dispatcher).toContain("kind: 'release_intelligence'");
    expect(dispatcher).toContain('releaseIntelligenceOutbox');
    expect(compute).toContain('RELEASE_INTELLIGENCE_STATE_MACHINE_ARN');
    expect(compute).toContain('aws_sfn_state_machine.vendor_ingestion.arn');
    expect(compute).toContain(
      'Resource       = "arn:aws:states:::states:startExecution.sync:2"',
    );
    expect(compute).toContain(
      'StateMachineArn = aws_sfn_state_machine.change_intelligence.arn',
    );
    expect(compute).toContain('actions   = ["states:StartExecution"]');
    expect(compute).toContain('"states:DescribeExecution", "states:StopExecution"');
  });

  it('scopes the ingestion worker to immutable registry evidence', () => {
    expect(iam).toContain('sid       = "ReadDetectedRegistryEvidence"');
    expect(iam).toContain(
      '/env/development/package-release/npm/source/*/poll/*/metadata.json',
    );
    expect(iam).toContain(
      'actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]',
    );
  });

  it('provides an operator queue and explains its authority boundary', () => {
    expect(web).toContain('/operator/migration-specifications');
    expect(web).toContain('Approve migration guidance');
    expect(web).toContain('Drafts with ambiguous changes stay blocked.');
    expect(web).toContain('does not modify code or create a pull request.');
  });
});
