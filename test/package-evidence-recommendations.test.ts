import { describe, expect, it } from 'vitest';

import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

import { packageEvidenceRecommendations } from '../apps/web/src/package-evidence-recommendations.js';

const candidate = (
  sourceKind: PublicPackageSourceCandidate['sourceKind'],
  canonicalUrl: string,
  reviewState: PublicPackageSourceCandidate['reviewState'] = 'pending_review',
): PublicPackageSourceCandidate => ({
  id: crypto.randomUUID(),
  sourceKind,
  canonicalUrl,
  canonicalDomain: new URL(canonicalUrl).hostname,
  reviewState,
  discoveryMethod: 'npm_registry_metadata',
  proposalReasonCode:
    sourceKind === 'homepage'
      ? 'NPM_HOMEPAGE_DECLARATION'
      : sourceKind === 'sdk_repository_release'
        ? 'NPM_REPOSITORY_DECLARATION'
        : 'NPM_REGISTRY_AUTHORITATIVE',
  proposalNote: null,
  supersedesCandidateId: null,
  rejectionReasonCode: null,
  reviewedAt: null,
  version: 1,
  canPromote: sourceKind !== 'homepage',
});

const mapping = (
  candidates: readonly PublicPackageSourceCandidate[],
  packageName = 'fastify',
): PublicPackageSourceMapping => ({
  id: crypto.randomUUID(),
  packageName,
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
  it('ranks publisher-declared documentation and repository searches first', () => {
    const recommendations = packageEvidenceRecommendations(
      mapping([
        candidate('homepage', 'https://fastify.dev/'),
        candidate('sdk_repository_release', 'https://github.com/fastify/fastify'),
      ]),
    );

    expect(recommendations.slice(0, 3).map(item => item.id)).toEqual([
      'publisher-documentation',
      'repository-migration-search',
      'repository-releases',
    ]);
    expect(recommendations[1]?.href).toMatch(
      /^https:\/\/github\.com\/fastify\/fastify\/search\?/u,
    );
    expect(recommendations[1]?.href).toContain('type=code');
    expect(recommendations[2]?.href).toBe(
      'https://github.com/fastify/fastify/releases',
    );
  });

  it('always supplies three bounded npm investigation paths as a fallback', () => {
    const recommendations = packageEvidenceRecommendations(mapping([], '@types/node'));

    expect(recommendations).toHaveLength(3);
    expect(
      recommendations.every(item => new URL(item.href).protocol === 'https:'),
    ).toBe(true);
    expect(
      recommendations.every(item => new URL(item.href).hostname === 'www.npmjs.com'),
    ).toBe(true);
    expect(recommendations[0]?.href).toContain('/package/%40types/node');
  });

  it('prefers an approved repository declaration over a rejected one', () => {
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

    expect(recommendations[0]?.href).toContain('/fastify/fastify/');
    expect(recommendations.some(item => item.href.includes('attacker'))).toBe(false);
  });
});
