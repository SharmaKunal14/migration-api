import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

export interface PackageEvidenceRecommendation {
  readonly id: string;
  readonly title: string;
  readonly purpose: string;
  readonly href: string;
  readonly verification: 'confirmed' | 'suggested';
}

const migrationReviewSourceKinds = [
  'package_registry_release',
  'sdk_repository_release',
  'migration_guide',
  'changelog',
  'release_feed',
] as const satisfies readonly PublicPackageSourceCandidate['sourceKind'][];

const guessedDocumentReasonCodes = new Set<
  PublicPackageSourceCandidate['proposalReasonCode']
>([
  'NPM_REPOSITORY_RELEASES_DERIVED',
  'NPM_REPOSITORY_CHANGELOG_DERIVED',
  'NPM_REPOSITORY_MIGRATION_DERIVED',
]);

function isUsefulReviewCandidate(candidate: PublicPackageSourceCandidate): boolean {
  if (
    candidate.discoveryMethod === 'npm_registry_metadata' &&
    guessedDocumentReasonCodes.has(candidate.proposalReasonCode)
  ) {
    return false;
  }
  return migrationReviewSourceKinds.includes(
    candidate.sourceKind as (typeof migrationReviewSourceKinds)[number],
  );
}

export function packageSourceCandidatesForReview(
  candidates: readonly PublicPackageSourceCandidate[],
): readonly PublicPackageSourceCandidate[] {
  const priority = new Map<PublicPackageSourceCandidate['sourceKind'], number>(
    migrationReviewSourceKinds.map((sourceKind, index) => [sourceKind, index]),
  );
  return candidates
    .filter(
      candidate =>
        candidate.canPromote &&
        candidate.reviewState === 'pending_review' &&
        isUsefulReviewCandidate(candidate) &&
        priority.has(candidate.sourceKind),
    )
    .sort(
      (left, right) =>
        (priority.get(left.sourceKind) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.sourceKind) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 3);
}

const directSourceKinds = [
  'migration_guide',
  'changelog',
  'release_feed',
] as const satisfies readonly PublicPackageSourceCandidate['sourceKind'][];

const directSourceTitles: Record<(typeof directSourceKinds)[number], string> = {
  migration_guide: 'Migration guide for this major version',
  changelog: 'Changelog covering this upgrade',
  release_feed: 'Release notes for the target version',
};

const directSourcePurposes: Record<(typeof directSourceKinds)[number], string> = {
  migration_guide: 'Concrete code and configuration changes required by the upgrade.',
  changelog: 'Breaking changes, removals, and deprecations across the version route.',
  release_feed:
    'Target-version behavior, compatibility, and release-specific warnings.',
};

function approvedCandidate(
  mapping: PublicPackageSourceMapping,
  sourceKind: PublicPackageSourceCandidate['sourceKind'],
): PublicPackageSourceCandidate | undefined {
  return mapping.candidates.find(
    candidate =>
      candidate.sourceKind === sourceKind && candidate.reviewState === 'approved',
  );
}

function declaredRepositoryCandidate(
  mapping: PublicPackageSourceMapping,
): PublicPackageSourceCandidate | undefined {
  return mapping.candidates.find(
    candidate =>
      candidate.sourceKind === 'sdk_repository_release' &&
      candidate.reviewState !== 'rejected' &&
      candidate.discoveryMethod === 'npm_registry_metadata',
  );
}

function recommendationFromCandidate(
  id: string,
  sourceKind: (typeof directSourceKinds)[number],
  title: string,
  candidate: PublicPackageSourceCandidate,
): PackageEvidenceRecommendation {
  return {
    id,
    title,
    purpose: directSourcePurposes[sourceKind],
    href: candidate.canonicalUrl,
    verification: 'confirmed',
  };
}

function targetMajor(version: string | null): string | null {
  const match = /^(?:v)?(\d+)(?:\.|$)/u.exec(version ?? '');
  return match?.[1] ? `v${match[1]}` : null;
}

function repositorySearch(repositoryRoot: string, query: string): string {
  const search = new URL(`${repositoryRoot}/search`);
  search.searchParams.set('q', query);
  search.searchParams.set('type', 'code');
  return search.toString();
}

export function packageEvidenceRecommendations(
  mapping: PublicPackageSourceMapping,
): readonly PackageEvidenceRecommendation[] {
  const recommendations: PackageEvidenceRecommendation[] = [];
  const seenUrls = new Set<string>();
  const add = (recommendation: PackageEvidenceRecommendation): void => {
    if (recommendations.length === 3 || seenUrls.has(recommendation.href)) return;
    seenUrls.add(recommendation.href);
    recommendations.push(recommendation);
  };

  for (const sourceKind of directSourceKinds) {
    const candidate = approvedCandidate(mapping, sourceKind);
    if (candidate) {
      add(
        recommendationFromCandidate(
          `direct-${sourceKind}`,
          sourceKind,
          directSourceTitles[sourceKind],
          candidate,
        ),
      );
    }
  }

  const repository = declaredRepositoryCandidate(mapping);
  if (repository && recommendations.length < 3) {
    const repositoryUrl = new URL(repository.canonicalUrl);
    if (repositoryUrl.hostname === 'github.com') {
      const repositoryRoot = `${repositoryUrl.origin}${repositoryUrl.pathname.replace(/\/$/u, '')}`;
      const major = targetMajor(mapping.latestVersion);
      if (!approvedCandidate(mapping, 'migration_guide')) {
        add({
          id: 'repository-migration-search',
          title: `Find the official ${major ?? 'major-version'} migration guide`,
          purpose:
            "Use the publisher's exact instructions for crossing this major version.",
          href: repositorySearch(
            repositoryRoot,
            `"migration guide" "${major ?? mapping.latestVersion ?? 'upgrade'}"`,
          ),
          verification: 'suggested',
        });
      }
      if (
        !approvedCandidate(mapping, 'changelog') &&
        !approvedCandidate(mapping, 'release_feed')
      ) {
        add({
          id: 'repository-target-release',
          title: 'Find target release notes or a versioned changelog',
          purpose:
            'Confirm target-specific breaking changes, removals, and deprecations.',
          href: `${repositoryRoot}/releases`,
          verification: 'suggested',
        });
      }
      add({
        id: 'repository-compatibility-search',
        title: 'Find runtime and compatibility requirements',
        purpose:
          'Confirm supported runtimes, peer dependencies, and platform prerequisites.',
        href: repositorySearch(
          repositoryRoot,
          `"${major ?? mapping.latestVersion ?? 'latest'}" ("Node.js" OR "runtime" OR "compatibility" OR "peerDependencies")`,
        ),
        verification: 'suggested',
      });
    }
  }

  return recommendations;
}
