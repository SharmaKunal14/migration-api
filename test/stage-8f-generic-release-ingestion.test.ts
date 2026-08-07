import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const migration = source(
  'supabase/migrations/0030_stage_8f_generic_release_ingestion.sql',
);
const refreshedDetectionGrant = source(
  'supabase/migrations/0039_allow_refreshed_release_detection_lookup.sql',
);
const evidenceSelection = source(
  'supabase/migrations/0041_prioritize_exact_migration_evidence.sql',
);
const compute = source('infra/terraform/environments/development/compute.tf');
const iam = source('infra/terraform/environments/development/iam.tf');
const dispatcher = source('services/outbox-dispatcher/src/handler.ts');
const repository = source('services/api/src/repository.ts');
const vendorFetcher = source('workers/vendor-fetcher/src/main.ts');
const intelligenceGateway = source('workers/change-intelligence-agent/src/gateway.ts');
const web = source('apps/web/src/app.tsx');
const styles = source('apps/web/src/styles.css');

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

  it('reuses fixed-origin registry evidence when a release revision is refreshed', () => {
    expect(vendorFetcher).toContain(
      ".onRef('detection.apiProductId', '=', 'release.apiProductId')",
    );
    expect(vendorFetcher).toContain(
      ".onRef('detection.version', '=', 'release.version')",
    );
    expect(vendorFetcher).toContain(
      ".onRef('detection.sourceVersion', '=', 'release.sourceCompatibility')",
    );
    expect(vendorFetcher).toContain(".on('detection.vendorReleaseId', 'is not', null)");
    expect(vendorFetcher).toContain(
      'release.detectedVendorReleaseId === release.releaseId',
    );
    for (const column of [
      'api_product_id',
      'version',
      'source_version',
      'latest_deprecated',
      'status',
    ]) {
      expect(refreshedDetectionGrant).toContain(column);
    }
    expect(refreshedDetectionGrant).toContain(
      'on package_release_detections to app_runtime',
    );
    expect(refreshedDetectionGrant).not.toContain(
      'grant select on package_release_detections',
    );
  });

  it('uses exact migration evidence instead of guessed files or repository history', () => {
    expect(evidenceSelection).not.toContain("repository_root || '/releases'");
    expect(evidenceSelection).not.toContain(
      "repository_root || '/blob/HEAD/CHANGELOG.md'",
    );
    expect(evidenceSelection).not.toContain(
      "repository_root || '/blob/HEAD/MIGRATION.md'",
    );
    expect(evidenceSelection).toContain(
      "'migration_guide', 'changelog', 'release_feed', 'api_definition'",
    );
    expect(evidenceSelection).toContain(
      'no newly trusted migration evidence source is available',
    );
    expect(repository).toContain(
      "'migration_guide', 'changelog', 'release_feed', 'api_definition'",
    );
    expect(vendorFetcher).toContain('MAX_MIGRATION_GUIDANCE_SOURCES = 3');
    expect(vendorFetcher).toContain("['migration_guide', 0]");
    expect(vendorFetcher).toContain("['changelog', 1]");
    expect(vendorFetcher).toContain("['release_feed', 2]");
    expect(vendorFetcher).toContain("source.sourceKind === 'package_registry_release'");
    expect(vendorFetcher).not.toContain(
      "migrationEvidencePriority.set('sdk_repository_release'",
    );
  });

  it('does not turn undocumented transitive dependency churn into a blocker', () => {
    expect(intelligenceGateway).toContain(
      'Do not create a change solely because an internal or transitive dependency version changed.',
    );
    expect(intelligenceGateway).toContain(
      'It must not become a blocking ambiguous change unless publisher evidence identifies an affected public API',
    );
    expect(intelligenceGateway).toContain(
      'Use an ambiguous change only when a public migration surface is established',
    );
  });

  it('provides an operator queue and explains its authority boundary', () => {
    expect(web).toContain('/operator/migration-specifications');
    expect(web).toContain('Approve migration guidance');
    expect(web).toContain('Drafts with ambiguous changes stay blocked.');
    expect(web).toContain('does not modify code or create a pull request.');
    expect(web).toContain('className="spec-review-change-list"');
    expect(styles).toContain('.spec-review-change-card');
    expect(styles).toContain('.spec-review-transformations > div');
  });
});
