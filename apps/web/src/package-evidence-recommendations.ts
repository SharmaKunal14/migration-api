import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

export interface PackageEvidenceRecommendation {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly verification: 'confirmed' | 'suggested';
}

const migrationReviewSourceKinds = [
  'package_registry_release',
  'changelog',
  'migration_guide',
  'release_feed',
  'sdk_repository_release',
] as const satisfies readonly PublicPackageSourceCandidate['sourceKind'][];

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
        candidate.reviewState !== 'rejected' &&
        priority.has(candidate.sourceKind),
    )
    .sort(
      (left, right) =>
        (priority.get(left.sourceKind) ?? Number.MAX_SAFE_INTEGER) -
        (priority.get(right.sourceKind) ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, 3)
    .filter(candidate => candidate.reviewState === 'pending_review');
}

const directSourceKinds = [
  'migration_guide',
  'changelog',
  'release_feed',
] as const satisfies readonly PublicPackageSourceCandidate['sourceKind'][];

const directSourceTitles: Record<(typeof directSourceKinds)[number], string> = {
  migration_guide: 'Official migration guide',
  changelog: 'Official changelog',
  release_feed: 'Target release notes',
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
  title: string,
  candidate: PublicPackageSourceCandidate,
): PackageEvidenceRecommendation {
  return {
    id,
    title,
    href: candidate.canonicalUrl,
    verification: 'confirmed',
  };
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
      const migrationSearch = new URL(`${repositoryRoot}/search`);
      migrationSearch.searchParams.set(
        'q',
        `migration guide upgrade ${mapping.latestVersion ?? ''}`.trim(),
      );
      migrationSearch.searchParams.set('type', 'code');
      add({
        id: 'repository-migration-search',
        title: 'Search official repository for migration guidance',
        href: migrationSearch.toString(),
        verification: 'suggested',
      });

      const releaseSearch = new URL(`${repositoryRoot}/search`);
      releaseSearch.searchParams.set(
        'q',
        `release notes breaking changes ${mapping.latestVersion ?? ''}`.trim(),
      );
      releaseSearch.searchParams.set('type', 'code');
      add({
        id: 'repository-release-search',
        title: 'Search official repository for target-version changes',
        href: releaseSearch.toString(),
        verification: 'suggested',
      });
    }
  }

  const homepage = approvedCandidate(mapping, 'homepage');
  if (homepage) {
    add(
      recommendationFromCandidate(
        'publisher-documentation',
        'Official package documentation',
        homepage,
      ),
    );
  }

  if (repository?.reviewState === 'approved') {
    add(
      recommendationFromCandidate(
        'publisher-repository',
        'Official source repository',
        repository,
      ),
    );
  }

  return recommendations;
}
