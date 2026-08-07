import { describe, expect, it } from 'vitest';

import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

import {
  packageEvidenceRecommendations,
  packageSourceCandidatesForReview,
} from '../apps/web/src/package-evidence-recommendations.js';

const candidate = (
  sourceKind: PublicPackageSourceCandidate['sourceKind'],
  canonicalUrl: string,
  reviewState: PublicPackageSourceCandidate['reviewState'] = 'pending_review',
  discoveryMethod: PublicPackageSourceCandidate['discoveryMethod'] = 'npm_registry_metadata',
): PublicPackageSourceCandidate => ({
  id: crypto.randomUUID(),
  sourceKind,
  canonicalUrl,
  canonicalDomain: new URL(canonicalUrl).hostname,
  reviewState,
  discoveryMethod,
  proposalReasonCode:
    discoveryMethod !== 'npm_registry_metadata'
      ? 'OPERATOR_ADDITION'
      : sourceKind === 'homepage'
        ? 'NPM_HOMEPAGE_DECLARATION'
        : sourceKind === 'sdk_repository_release'
          ? 'NPM_REPOSITORY_DECLARATION'
          : sourceKind === 'package_registry_release'
            ? 'NPM_REGISTRY_AUTHORITATIVE'
            : sourceKind === 'release_feed'
              ? 'NPM_REPOSITORY_RELEASES_DERIVED'
              : sourceKind === 'changelog'
                ? 'NPM_REPOSITORY_CHANGELOG_DERIVED'
                : 'NPM_REPOSITORY_MIGRATION_DERIVED',
  proposalNote:
    discoveryMethod === 'operator_addition' ? 'Verified on the publisher site.' : null,
  supersedesCandidateId: null,
  rejectionReasonCode: null,
  reviewedAt: reviewState === 'approved' ? '2026-08-06T00:00:00.000Z' : null,
  version: 1,
  canPromote: sourceKind !== 'homepage',
});

const mapping = (
  candidates: readonly PublicPackageSourceCandidate[],
): PublicPackageSourceMapping => ({
  id: crypto.randomUUID(),
  packageName: 'fastify',
  status: 'mapped',
  latestVersion: '5.11.2',
  latestDeprecated: false,
  resolvedAt: '2026-08-06T00:00:00.000Z',
  evidenceDigest: 'a'.repeat(64),
  vendorSlug: 'fastify',
  vendorName: 'Fastify',
  vendorId: crypto.randomUUID(),
  apiProductId: crypto.randomUUID(),
  disabledReasonCode: null,
  disabledAt: null,
  repositoryUsage: {
    total: 1,
    direct: 1,
    development: 0,
    optional: 0,
    peer: 0,
  },
  guidanceRefreshAvailable: false,
  version: 1,
  candidates,
});

describe('package evidence recommendations', () => {
  it('does not ask operators to approve guessed document paths', () => {
    const candidates = [
      candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      candidate('release_feed', 'https://github.com/fastify/fastify/releases'),
      candidate(
        'migration_guide',
        'https://github.com/fastify/fastify/blob/HEAD/MIGRATION.md',
      ),
      candidate('package_registry_release', 'https://registry.npmjs.org/fastify'),
      candidate(
        'changelog',
        'https://github.com/fastify/fastify/blob/HEAD/CHANGELOG.md',
      ),
    ];

    expect(
      packageSourceCandidatesForReview(candidates).map(item => item.sourceKind),
    ).toEqual(['package_registry_release', 'sdk_repository_release']);
  });

  it('shows exact operator-added migration documents before the release fallback', () => {
    const candidates = [
      candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      candidate('release_feed', 'https://github.com/fastify/fastify/releases'),
      candidate(
        'migration_guide',
        'https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/',
        'pending_review',
        'operator_addition',
      ),
      candidate('package_registry_release', 'https://registry.npmjs.org/fastify'),
      candidate(
        'changelog',
        'https://github.com/fastify/fastify/blob/main/docs/Reference/LTS.md',
        'pending_review',
        'operator_addition',
      ),
    ];

    expect(
      packageSourceCandidatesForReview(candidates).map(item => item.sourceKind),
    ).toEqual([
      'package_registry_release',
      'sdk_repository_release',
      'migration_guide',
    ]);
  });

  it('does not replace rejected exact guidance with generic release history', () => {
    const candidates = [
      candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      candidate('release_feed', 'https://github.com/fastify/fastify/releases'),
      candidate(
        'migration_guide',
        'https://github.com/fastify/fastify/blob/HEAD/MIGRATION.md',
        'rejected',
        'operator_addition',
      ),
      candidate('package_registry_release', 'https://registry.npmjs.org/fastify'),
      candidate(
        'changelog',
        'https://github.com/fastify/fastify/blob/HEAD/CHANGELOG.md',
        'rejected',
        'operator_addition',
      ),
    ];

    expect(
      packageSourceCandidatesForReview(candidates).map(item => item.sourceKind),
    ).toEqual(['package_registry_release', 'sdk_repository_release']);
  });

  it('shows only three migration-oriented recommendations', () => {
    const recommendations = packageEvidenceRecommendations(
      mapping([
        candidate(
          'migration_guide',
          'https://fastify.dev/docs/latest/Guides/Migration-Guide-V5/',
          'approved',
        ),
        candidate('changelog', 'https://github.com/fastify/fastify/releases'),
        candidate('homepage', 'https://fastify.dev/'),
        candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      ]),
    );

    expect(recommendations).toHaveLength(3);
    expect(recommendations.map(item => item.id)).toEqual([
      'direct-migration_guide',
      'repository-target-release',
      'repository-compatibility-search',
    ]);
    expect(recommendations[0]?.verification).toBe('confirmed');
    expect(recommendations[1]?.verification).toBe('suggested');
  });

  it('uses scoped publisher locations instead of generic npm history', () => {
    const recommendations = packageEvidenceRecommendations(
      mapping([
        candidate('homepage', 'https://fastify.dev/'),
        candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      ]),
    );

    expect(recommendations).toHaveLength(3);
    expect(recommendations.map(item => item.id)).toEqual([
      'repository-migration-search',
      'repository-target-release',
      'repository-compatibility-search',
    ]);
    expect(recommendations.every(item => !item.href.includes('npmjs.com'))).toBe(true);
    expect(recommendations[0]?.href).toContain('/fastify/fastify/search?');
    expect(recommendations[0]?.href).toContain('%22v5%22');
    expect(recommendations[1]?.href).toBe(
      'https://github.com/fastify/fastify/releases',
    );
  });

  it('does not pad missing recommendations with low-value package history', () => {
    const recommendations = packageEvidenceRecommendations(
      mapping([candidate('homepage', 'https://fastify.dev/', 'approved')]),
    );

    expect(recommendations).toEqual([]);
  });

  it('ignores rejected lookalike repositories', () => {
    const recommendations = packageEvidenceRecommendations(
      mapping([
        candidate(
          'sdk_repository_release',
          'https://github.com/attacker/lookalike',
          'rejected',
        ),
        candidate(
          'sdk_repository_release',
          'https://github.com/fastify/fastify',
          'approved',
        ),
      ]),
    );

    expect(recommendations).toHaveLength(3);
    expect(recommendations.every(item => !item.href.includes('attacker'))).toBe(true);
  });
});
