import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  packageEvidenceRefreshRequestSchema,
  packageSourceCandidateAdditionRequestSchema,
  packageSourceCandidateReplacementRequestSchema,
  packageSourceCandidateReviewRequestSchema,
  packageSourceMappingStateRequestSchema,
} from '@migration/contracts';

const evidenceRefreshMigration = readFileSync(
  new URL(
    '../supabase/migrations/0036_source_suggestions_and_evidence_refresh.sql',
    import.meta.url,
  ),
  'utf8',
);
const evidenceRefreshDigestFixMigration = readFileSync(
  new URL(
    '../supabase/migrations/0037_fix_evidence_refresh_digest_resolution.sql',
    import.meta.url,
  ),
  'utf8',
);
const evidenceRefreshBuiltinDigestMigration = readFileSync(
  new URL(
    '../supabase/migrations/0038_use_builtin_sha256_for_evidence_refresh.sql',
    import.meta.url,
  ),
  'utf8',
);

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
const exactApprovalMigration = readFileSync(
  new URL(
    '../supabase/migrations/0026_stage_8c_exact_source_approval.sql',
    import.meta.url,
  ),
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
const sourceRecommendations = readFileSync(
  new URL('../apps/web/src/package-evidence-recommendations.ts', import.meta.url),
  'utf8',
);

describe('stage 8C package source review', () => {
  it('proposes bounded GitHub evidence locations without trusting or fetching them', () => {
    expect(evidenceRefreshMigration).toContain(
      'create function propose_github_package_evidence_candidates()',
    );
    expect(evidenceRefreshMigration).toContain("repository_root || '/releases'");
    expect(evidenceRefreshMigration).toContain(
      "repository_root || '/blob/HEAD/CHANGELOG.md'",
    );
    expect(evidenceRefreshMigration).toContain(
      "repository_root || '/blob/HEAD/MIGRATION.md'",
    );
    expect(evidenceRefreshMigration).toContain("'pending_review'");
    expect(evidenceRefreshMigration).not.toContain(
      "repository_root || '/releases', 'github.com', new.evidence_digest,\n      'approved'",
    );
  });

  it('accepts only bounded operator additions and queues immutable evidence revisions', () => {
    expect(
      packageSourceCandidateAdditionRequestSchema.safeParse({
        expectedMappingVersion: 5,
        sourceKind: 'migration_guide',
        canonicalUrl: 'https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/',
        proposalNote: 'Linked from the Fastify documentation navigation.',
      }).success,
    ).toBe(true);
    expect(
      packageSourceCandidateAdditionRequestSchema.safeParse({
        expectedMappingVersion: 5,
        sourceKind: 'migration_guide',
        canonicalUrl: 'http://169.254.169.254/latest/meta-data',
        proposalNote: 'unsafe',
      }).success,
    ).toBe(false);
    expect(
      packageEvidenceRefreshRequestSchema.safeParse({ expectedMappingVersion: 6 })
        .success,
    ).toBe(true);
    expect(evidenceRefreshMigration).toContain(
      'create function request_package_evidence_refresh(',
    );
    expect(evidenceRefreshMigration).toContain("'registered', 'draft'");
    expect(evidenceRefreshMigration).toContain(
      "'previous_vendor_release_id', current_release.id",
    );
    expect(evidenceRefreshMigration).toContain(
      'no newly trusted evidence source is available',
    );
  });

  it('resolves pgcrypto from the trusted Supabase extensions schema', () => {
    expect(evidenceRefreshDigestFixMigration).toContain(
      'alter function request_package_evidence_refresh(uuid, uuid, integer, uuid)',
    );
    expect(evidenceRefreshDigestFixMigration).toContain(
      'set search_path = extensions, public, pg_temp',
    );
  });

  it('uses PostgreSQL SHA-256 without extension schema privileges', () => {
    expect(evidenceRefreshBuiltinDigestMigration).toContain('pg_catalog.sha256(');
    expect(evidenceRefreshBuiltinDigestMigration).toContain(
      'set search_path = public, pg_temp',
    );
    expect(evidenceRefreshBuiltinDigestMigration).not.toContain('digest(');
  });
  it('accepts bounded approvals and rejects source URL substitution', () => {
    expect(
      packageSourceCandidateReviewRequestSchema.safeParse({
        decision: 'approve',
        expectedCandidateVersion: 1,
        expectedMappingVersion: 1,
        pollIntervalSeconds: 86_400,
      }).success,
    ).toBe(true);
    expect(
      packageSourceCandidateReviewRequestSchema.safeParse({
        decision: 'approve',
        expectedCandidateVersion: 1,
        expectedMappingVersion: 1,
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

  it('keeps provenance and usage available without putting them in the primary flow', () => {
    expect(repository).toContain('count(distinct latest.repository_id)::text as total');
    expect(repository).toContain("snapshot.status = 'available'");
    expect(repository).toContain('repository.selected');
    expect(operatorUi).toContain('Technical details and controls');
    expect(operatorUi).toContain('Registry checked');
    expect(operatorUi).toContain('Dependency use');
    expect(operatorUi).toContain('source-review-link');
  });

  it('renders per-source progress without blocking unrelated cards', () => {
    expect(operatorUi).toContain('className="source-confirm-button"');
    expect(operatorUi).toContain('className="source-reject-button"');
    expect(operatorUi).toContain('candidateReviewOperations[candidate.id]');
    expect(operatorUi).toContain('disabled={reviewOperation !== undefined}');
    expect(operatorUi).toContain("reviewOperation === 'queued_approve'");
    expect(operatorUi).toContain("reviewOperation === 'queued_reject'");
    expect(operatorUi).toContain('currentMappingVersion.current');
    expect(operatorStyles).toContain('.source-confirm-button:disabled');
    expect(operatorStyles).toContain('cursor: not-allowed');
    expect(operatorStyles).toContain(".source-confirm-button[aria-busy='true']");
  });

  it('keeps the normal review path short without weakening explicit trust', () => {
    expect(operatorUi).toContain('Confirm source');
    expect(operatorUi).toContain('Not official');
    expect(operatorUi).toContain('Add the exact official page');
    expect(operatorUi).toContain('The npm registry is the standard version feed');
    expect(operatorUi).not.toContain('Confirm the package publisher');
    expect(operatorUi).not.toContain('Official website domain');
    expect(exactApprovalMigration).toContain("'approval_scope', 'exact_url'");
    expect(exactApprovalMigration).toContain(
      'array[current_candidate.canonical_domain]',
    );
    expect(exactApprovalMigration).toContain('current_candidate.canonical_url');
    expect(exactApprovalMigration).not.toContain('p_official_domains');
  });

  it('shows confirmed packages one evidence panel and one context-aware next action', () => {
    expect(operatorUi).toContain('Migration evidence · up to 3 exact resources');
    expect(operatorUi).toContain('Generic homepages and');
    expect(operatorUi).toContain(
      'repository roots are deliberately excluded from migration analysis.',
    );
    expect(operatorUi).toContain("mapping.status === 'mapped' && pendingCount === 0");
    expect(operatorUi).toContain('Suggested search');
    expect(operatorUi).toContain('Find page ↗');
    expect(operatorUi).not.toContain("'Verify'");
    expect(operatorUi).toContain('source-next-action');
    expect(operatorUi).toContain('mapping.guidanceRefreshAvailable');
    expect(operatorUi).toContain("? 'Re-run migration analysis'");
    expect(operatorUi).toContain(": 'Analyze the current upgrade'");
    expect(operatorUi).not.toContain('Regenerate blocked guidance');
    expect(operatorUi).not.toContain('Pilot an existing release');
    expect(operatorStyles).toContain(
      'grid-template-columns: repeat(3, minmax(0, 1fr))',
    );
  });

  it('keeps partially reviewed packages in the operator queue', () => {
    expect(operatorUi).toContain(
      "loadPackageSourceMappings(session.access_token, 'mapped')",
    );
    expect(operatorUi).toContain(
      'packageSourceCandidatesForReview(mapping.candidates)',
    );
    expect(sourceRecommendations).toContain('candidate.canPromote &&');
    expect(sourceRecommendations).toContain(
      "candidate.reviewState === 'pending_review'",
    );
    expect(operatorUi).toContain("status === 'mapped'");
  });

  it('limits approval work to three migration-useful source types', () => {
    expect(sourceRecommendations).toContain("'package_registry_release'");
    expect(sourceRecommendations).toContain("'changelog'");
    expect(sourceRecommendations).toContain("'migration_guide'");
    expect(sourceRecommendations).toContain("'release_feed'");
    expect(sourceRecommendations).toContain("'sdk_repository_release'");
    expect(sourceRecommendations).toContain('.slice(0, 3)');
    expect(operatorUi).toContain(
      'packageSourceCandidatesForReview(mapping.candidates)',
    );
    expect(operatorUi).toContain('candidatesNeedingReview.map(candidate =>');
  });

  it('does not misreport unrelated database permission failures as operator denial', () => {
    expect(repository).toContain("failureStage = 'approval_function'");
    expect(repository).toContain("failureStage = 'idempotency_write'");
    expect(repository).toContain("failureStage = 'result_reload'");
    expect(repository).toContain("postgresErrorMessage(error) ?? ''");
    expect(repository).toContain('packageSourceReviewPermissionCode(failureStage)');
  });

  it('leaves authoritative review locking inside the security-definer function', () => {
    const preflightStart = repository.indexOf("failureStage = 'candidate_load'");
    const approvalStart = repository.indexOf("failureStage = 'approval_function'");
    expect(preflightStart).toBeGreaterThanOrEqual(0);
    expect(approvalStart).toBeGreaterThan(preflightStart);
    expect(repository.slice(preflightStart, approvalStart)).not.toContain(
      '.forUpdate()',
    );
    expect(exactApprovalMigration).toContain('for update;');
  });
});
