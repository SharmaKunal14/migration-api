import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { packageReleasePilotBackfillRequestSchema } from '@migration/contracts';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const migration = source('supabase/migrations/0032_pilot_current_release_backfill.sql');
const vendorFetcherGrant = source(
  'supabase/migrations/0033_vendor_fetcher_release_detection_read.sql',
);
const workflowRetry = source(
  'supabase/migrations/0034_pilot_release_workflow_retry.sql',
);
const dispatchReader = source(
  'supabase/migrations/0035_pilot_backfill_dispatch_reader.sql',
);
const dispatcher = source('services/outbox-dispatcher/src/handler.ts');
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

  it('lets the downstream fetcher read only the detection evidence it consumes', () => {
    expect(vendorFetcherGrant).toContain('grant select (');
    expect(vendorFetcherGrant).toContain('vendor_release_id');
    expect(vendorFetcherGrant).toContain('source_id');
    expect(vendorFetcherGrant).toContain('evidence_object_key');
    expect(vendorFetcherGrant).toContain('evidence_digest');
    expect(vendorFetcherGrant).toContain(
      'on package_release_detections to app_runtime',
    );
    expect(vendorFetcherGrant).not.toContain(
      'grant select on package_release_detections',
    );
  });

  it('requeues only a terminal workflow through an audited operator operation', () => {
    expect(workflowRetry).toContain(
      'create function requeue_current_package_release_pilot_backfill',
    );
    expect(workflowRetry).toContain('if not is_platform_operator');
    expect(workflowRetry).toContain(
      'current_outbox.workflow_execution_arn is distinct from',
    );
    expect(workflowRetry).toContain('delivered_at = null');
    expect(workflowRetry).toContain("'package_release.pilot_backfill_requeued'");
    expect(workflowRetry).toContain('grant execute on function');
    expect(dispatcher).toContain(
      '`release-intelligence-${event.payload.correlationId}`',
    );
  });

  it('loads retry state through an operator-bounded function without broader table grants', () => {
    expect(dispatchReader).toContain(
      'create function load_package_release_pilot_backfill_dispatch',
    );
    expect(dispatchReader).toContain('if not is_platform_operator');
    expect(dispatchReader).toContain('inner join release_intelligence_outbox');
    expect(dispatchReader).toContain('grant execute on function');
    expect(dispatchReader).not.toContain('grant select on package_release_detections');
    expect(repository).toContain('from load_package_release_pilot_backfill_dispatch(');
  });

  it('keeps the operator interaction bounded and explains the derived authority', () => {
    expect(web).toContain('Ingest current release');
    expect(web).toContain('No version or source URL can be entered');
    expect(web).toContain('requestPackageReleasePilotBackfill');
  });
});
