import type {
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
} from '@migration/contracts';

export interface PackageEvidenceRecommendation {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly provenance: string;
  readonly href: string;
  readonly action: 'Open' | 'Search';
}

export function packageEvidenceRecommendations(
  mapping: PublicPackageSourceMapping,
): readonly PackageEvidenceRecommendation[] {
  const recommendations: PackageEvidenceRecommendation[] = [];
  const seenUrls = new Set<string>();
  const add = (recommendation: PackageEvidenceRecommendation): void => {
    if (seenUrls.has(recommendation.href)) return;
    seenUrls.add(recommendation.href);
    recommendations.push(recommendation);
  };
  const preferredCandidate = (
    sourceKind: PublicPackageSourceCandidate['sourceKind'],
  ): PublicPackageSourceCandidate | undefined =>
    mapping.candidates
      .filter(candidate => candidate.sourceKind === sourceKind)
      .sort((left, right) => {
        const rank = (candidate: PublicPackageSourceCandidate): number =>
          candidate.reviewState === 'approved'
            ? 0
            : candidate.reviewState === 'pending_review'
              ? 1
              : 2;
        return rank(left) - rank(right);
      })[0];

  const homepage = preferredCandidate('homepage');
  if (homepage) {
    add({
      id: 'publisher-documentation',
      title: 'Publisher documentation',
      description:
        'Look for an upgrade guide, migration guide, or versioned documentation.',
      provenance: 'Website declared by the package publisher in npm metadata.',
      href: homepage.canonicalUrl,
      action: 'Open',
    });
  }

  const repository = preferredCandidate('sdk_repository_release');
  if (repository) {
    const repositoryUrl = new URL(repository.canonicalUrl);
    if (repositoryUrl.hostname === 'github.com') {
      const repositoryRoot = `${repositoryUrl.origin}${repositoryUrl.pathname.replace(/\/$/u, '')}`;
      const migrationSearch = new URL(`${repositoryRoot}/search`);
      migrationSearch.searchParams.set(
        'q',
        `${mapping.latestVersion ?? ''} migration upgrade breaking changelog`.trim(),
      );
      migrationSearch.searchParams.set('type', 'code');
      add({
        id: 'repository-migration-search',
        title: 'Repository migration search',
        description:
          'Search the publisher-declared repository for migration, upgrade, breaking-change, and changelog documents.',
        provenance: 'Search is restricted to the repository declared in npm metadata.',
        href: migrationSearch.toString(),
        action: 'Search',
      });
      add({
        id: 'repository-releases',
        title: 'Official repository releases',
        description:
          'Inspect release notes for the target major version and links to detailed guidance.',
        provenance:
          'Release history derived from the publisher-declared GitHub repository.',
        href: `${repositoryRoot}/releases`,
        action: 'Open',
      });
    } else {
      add({
        id: 'publisher-repository',
        title: 'Publisher source repository',
        description:
          'Search the repository for migration guides, changelogs, tags, and release notes.',
        provenance: 'Repository declared by the package publisher in npm metadata.',
        href: repository.canonicalUrl,
        action: 'Open',
      });
    }
  }

  const npmPackagePath = mapping.packageName
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const npmPackageUrl = `https://www.npmjs.com/package/${npmPackagePath}`;
  add({
    id: 'npm-version-history',
    title: 'npm version history',
    description:
      'Confirm the target version and inspect publisher links associated with the package.',
    provenance: 'Fixed npm package identity discovered from the repository scan.',
    href: `${npmPackageUrl}?activeTab=versions`,
    action: 'Open',
  });
  add({
    id: 'npm-package-page',
    title: 'npm package page',
    description:
      'Check the package README and publisher-provided homepage and repository links.',
    provenance: 'Fixed npm package identity discovered from the repository scan.',
    href: npmPackageUrl,
    action: 'Open',
  });
  add({
    id: 'npm-package-code',
    title: 'Published package contents',
    description:
      'Inspect the published package for bundled migration notes or a changelog.',
    provenance: 'Package contents published under this exact npm package identity.',
    href: `${npmPackageUrl}?activeTab=code`,
    action: 'Open',
  });

  return recommendations;
}
