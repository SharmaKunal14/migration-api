import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

export interface PackageEvidenceRecommendation {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly verification: 'confirmed' | 'verify';
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

function candidateRank(candidate: PublicPackageSourceCandidate): number {
  return candidate.reviewState === 'approved'
    ? 0
    : candidate.reviewState === 'pending_review'
      ? 1
      : 2;
}

function preferredCandidate(
  mapping: PublicPackageSourceMapping,
  sourceKind: PublicPackageSourceCandidate['sourceKind'],
): PublicPackageSourceCandidate | undefined {
  return mapping.candidates
    .filter(
      candidate =>
        candidate.sourceKind === sourceKind && candidate.reviewState !== 'rejected',
    )
    .sort((left, right) => candidateRank(left) - candidateRank(right))[0];
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
    verification: candidate.reviewState === 'approved' ? 'confirmed' : 'verify',
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
    const candidate = preferredCandidate(mapping, sourceKind);
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

  const repository = preferredCandidate(mapping, 'sdk_repository_release');
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
        verification: 'verify',
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
        verification: 'verify',
      });
    }
  }

  const homepage = preferredCandidate(mapping, 'homepage');
  if (homepage) {
    add(
      recommendationFromCandidate(
        'publisher-documentation',
        'Official package documentation',
        homepage,
      ),
    );
  }

  if (repository) {
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
