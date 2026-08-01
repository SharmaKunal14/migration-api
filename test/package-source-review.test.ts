import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  packageSourceCandidateReplacementRequestSchema,
  packageSourceCandidateReviewRequestSchema,
  packageSourceMappingStateRequestSchema,
} from '@migration/contracts';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0024_stage_8c_package_source_review.sql',
    import.meta.url,
  ),
  'utf8',
);
const operatorReadMigration = readFileSync(
  new URL('../supabase/migrations/0025_stage_8c_operator_reads.sql', import.meta.url),
  'utf8',
);
const repository = readFileSync(
  new URL('../services/api/src/repository.ts', import.meta.url),
  'utf8',
);
const operatorUi = readFileSync(
  new URL('../apps/web/src/app.tsx', import.meta.url),
  'utf8',
);
const operatorStyles = readFileSync(
  new URL('../apps/web/src/styles.css', import.meta.url),
  'utf8',
);

describe('stage 8C package source review', () => {
  it('accepts bounded approvals and rejects source URL substitution', () => {
    expect(
      packageSourceCandidateReviewRequestSchema.safeParse({
        decision: 'approve',
        expectedCandidateVersion: 1,
        expectedMappingVersion: 1,
        catalog: {
          mode: 'new_vendor',
          vendorSlug: 'orbitchat',
          vendorName: 'OrbitChat',
          officialDomains: ['orbitchat.example'],
        },
        approveCandidateDomain: false,
        pollIntervalSeconds: 86_400,
      }).success,
    ).toBe(true);
    expect(
      packageSourceCandidateReviewRequestSchema.safeParse({
        decision: 'approve',
        expectedCandidateVersion: 1,
        expectedMappingVersion: 1,
        catalog: {
          mode: 'new_vendor',
          vendorSlug: 'orbitchat',
          vendorName: 'OrbitChat',
          officialDomains: ['orbitchat.example'],
        },
        approveCandidateDomain: false,
        pollIntervalSeconds: 86_400,
        canonicalUrl: 'https://attacker.example/source',
      }).success,
    ).toBe(false);
  });

  it('requires an active operator, locks versions, and preserves evidence identity', () => {
    expect(migration).toContain('if not is_platform_operator(p_operator_user_id)');
    expect(migration).toContain('for update;');
    expect(migration).toContain(
      'current_candidate.version <> p_expected_candidate_version',
    );
    expect(migration).toContain(
      'current_candidate.evidence_digest is distinct from current_mapping.registry_metadata_digest',
    );
    expect(migration).toContain('current_candidate.canonical_url');
  });

  it('records review audit events and exposes only the procedure to runtime', () => {
    expect(migration).toContain("'package_source_candidate.' || case p_decision");
    expect(migration).toContain('insert into platform_audit_events');
    expect(migration).toContain(
      'revoke all on function review_package_source_candidate',
    );
    expect(migration).toContain(
      'grant execute on function review_package_source_candidate',
    );
    expect(migration).not.toContain('grant insert on package_source_candidates');
    expect(migration).not.toContain('grant update on package_source_candidates');
  });

  it('allows the runtime API to read only the global source-review tables', () => {
    expect(operatorReadMigration).toContain('grant select on');
    expect(operatorReadMigration).toContain('package_source_mappings');
    expect(operatorReadMigration).toContain('package_source_candidates');
    expect(operatorReadMigration).toContain('package_source_mapping_controls');
    expect(operatorReadMigration).not.toMatch(/grant\s+(?:insert|update|delete)/u);
    expect(operatorReadMigration).not.toContain('repositories');
    expect(operatorReadMigration).not.toContain('dependency_observations');
  });

  it('requires explicit domain promotion and keeps npm registry domains separate', () => {
    expect(migration).toContain(
      "current_candidate.canonical_domain <> 'registry.npmjs.org'",
    );
    expect(migration).toContain('if not p_approve_candidate_domain then');
    expect(migration).toContain("'candidate_domain_added', domain_added");
    expect(migration).not.toContain('array[current_candidate.canonical_domain]');
  });

  it('preserves replacement provenance and audit history', () => {
    expect(
      packageSourceCandidateReplacementRequestSchema.safeParse({
        expectedCandidateVersion: 1,
        expectedMappingVersion: 1,
        sourceKind: 'changelog',
        canonicalUrl: 'https://docs.orbitchat.example/changelog',
        proposalNote: 'The vendor documentation links this changelog.',
      }).success,
    ).toBe(true);
    expect(migration).toContain("discovery_method = 'operator_replacement'");
    expect(migration).toContain("rejection_reason_code = 'REPLACED'");
    expect(migration).toContain("'package_source_candidate.replaced'");
  });

  it('disables mappings and their currently pollable trusted sources reversibly', () => {
    expect(
      packageSourceMappingStateRequestSchema.safeParse({
        action: 'disable',
        expectedMappingVersion: 1,
        disabledReasonCode: 'SECURITY_CONCERN',
      }).success,
    ).toBe(true);
    expect(migration).toContain('package_source_mapping_disabled_sources');
    expect(migration).toContain("set trust_state = 'disabled'");
    expect(migration).toContain(
      'set trust_state = disabled_source.previous_trust_state',
    );
    expect(migration).toContain("'package_source_mapping.disabled'");
  });

  it('returns privacy-safe latest-snapshot usage aggregates and complete evidence fields', () => {
    expect(repository).toContain('count(distinct latest.repository_id)::text as total');
    expect(repository).toContain("snapshot.status = 'available'");
    expect(repository).toContain('repository.selected');
    expect(operatorUi).toContain('Registry evidence retrieved');
    expect(operatorUi).toContain('Repositories using package');
    expect(operatorUi).toContain('Proposed because:');
    expect(operatorUi).toContain('Release feed');
    expect(operatorUi).toContain('Migration documentation');
  });

  it('renders review decisions as neutral controls and shows progress only while active', () => {
    expect(operatorUi).toContain('className="review-decision-button"');
    expect(operatorUi).toContain("busyOperation.action === 'approve'");
    expect(operatorUi).toContain("busyOperation.action === 'reject'");
    expect(operatorStyles).toContain('.review-decision-button:disabled');
    expect(operatorStyles).toContain('cursor: not-allowed');
    expect(operatorStyles).toContain(".review-decision-button[aria-busy='true']");
  });

  it('keeps the normal review path short without weakening explicit trust', () => {
    expect(operatorUi).toContain('Confirm the package publisher');
    expect(operatorUi).toContain('Publisher name');
    expect(operatorUi).toContain('Official website domain');
    expect(operatorUi).toContain('Advanced catalogue settings');
    expect(operatorUi).toContain('Use a different official URL');
    expect(operatorUi).toContain('is an official');
    expect(operatorUi).toContain('domain for this publisher');
    expect(operatorUi).not.toContain('Poll interval (seconds)');
    expect(operatorUi).not.toContain('Catalog binding');
  });
});
