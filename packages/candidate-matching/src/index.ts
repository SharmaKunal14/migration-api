import { satisfies, subset, valid, validRange } from 'semver';
import { sql, type Transaction } from 'kysely';

import type { AppDatabase, Database } from '@migration/database';

const MAX_REPOSITORIES_PER_RECONCILIATION = 1_000;

type CandidateDatabase = AppDatabase | Transaction<Database>;

interface DependencyVersion {
  readonly declaredRange: string;
  readonly resolvedVersion: string | null;
}

interface CandidateObservation extends DependencyVersion {
  readonly id: string;
  readonly dependencyKind: 'dependency' | 'development' | 'optional' | 'peer';
  readonly manifestPath: string;
}

export interface CandidateReconciliationSummary {
  readonly matchedRepositories: number;
  readonly unmatchedRepositories: number;
}

export class CandidateMatchingError extends Error {
  public constructor(
    public readonly safeCode:
      'CANDIDATE_RECONCILIATION_LIMIT_EXCEEDED' | 'SOURCE_COMPATIBILITY_INVALID',
  ) {
    super('Migration candidates could not be reconciled safely.');
    this.name = 'CandidateMatchingError';
  }
}

export function dependencyMatchesSourceCompatibility(
  dependency: DependencyVersion,
  sourceCompatibility: string,
): boolean {
  if (!validRange(sourceCompatibility)) {
    throw new CandidateMatchingError('SOURCE_COMPATIBILITY_INVALID');
  }
  if (dependency.resolvedVersion !== null) {
    return (
      valid(dependency.resolvedVersion) !== null &&
      satisfies(dependency.resolvedVersion, sourceCompatibility, {
        includePrerelease: false,
      })
    );
  }
  if (!validRange(dependency.declaredRange)) {
    return false;
  }
  return subset(dependency.declaredRange, sourceCompatibility, {
    includePrerelease: false,
  });
}

export async function reconcileCandidatesForSpecification(
  database: CandidateDatabase,
  specificationId: string,
  detectedAt: Date,
): Promise<CandidateReconciliationSummary> {
  const specification = await database
    .selectFrom('migrationSpecifications as specification')
    .innerJoin(
      'vendorReleases as release',
      'release.id',
      'specification.vendorReleaseId',
    )
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .select([
      'specification.id',
      'specification.sourceCompatibility',
      'specification.targetVersion',
      'release.apiProductId',
      'product.canonicalIdentifier',
    ])
    .where('specification.id', '=', specificationId)
    .where('specification.trustState', 'in', ['reviewed', 'vendor_verified'])
    .executeTakeFirstOrThrow();

  requireValidSourceCompatibility(specification.sourceCompatibility);
  const latestSpecification = await database
    .selectFrom('migrationSpecifications as candidateSpecification')
    .innerJoin(
      'vendorReleases as candidateRelease',
      'candidateRelease.id',
      'candidateSpecification.vendorReleaseId',
    )
    .select('candidateSpecification.id')
    .where('candidateSpecification.trustState', 'in', ['reviewed', 'vendor_verified'])
    .where('candidateRelease.apiProductId', '=', specification.apiProductId)
    .where(
      'candidateSpecification.sourceCompatibility',
      '=',
      specification.sourceCompatibility,
    )
    .where('candidateSpecification.targetVersion', '=', specification.targetVersion)
    .orderBy('candidateRelease.revision', 'desc')
    .orderBy('candidateSpecification.revision', 'desc')
    .orderBy('candidateSpecification.createdAt', 'desc')
    .orderBy('candidateSpecification.id', 'desc')
    .executeTakeFirstOrThrow();
  if (latestSpecification.id !== specificationId) {
    return { matchedRepositories: 0, unmatchedRepositories: 0 };
  }

  const snapshots = await database
    .selectFrom('repositorySnapshots as snapshot')
    .innerJoin('repositories as repository', 'repository.id', 'snapshot.repositoryId')
    .innerJoin(
      'githubInstallations as installation',
      'installation.id',
      'repository.installationId',
    )
    .distinctOn('snapshot.repositoryId')
    .select(['snapshot.id', 'snapshot.repositoryId'])
    .where('snapshot.status', '=', 'available')
    .where('snapshot.expiresAt', '>', detectedAt)
    .where('repository.selected', '=', true)
    .where('repository.enabled', '=', true)
    .where('repository.archived', '=', false)
    .where('installation.status', '=', 'active')
    .orderBy('snapshot.repositoryId', 'asc')
    .orderBy('snapshot.updatedAt', 'desc')
    .orderBy('snapshot.id', 'desc')
    .limit(MAX_REPOSITORIES_PER_RECONCILIATION + 1)
    .execute();
  if (snapshots.length > MAX_REPOSITORIES_PER_RECONCILIATION) {
    throw new CandidateMatchingError('CANDIDATE_RECONCILIATION_LIMIT_EXCEEDED');
  }

  const snapshotIds = snapshots.map(snapshot => snapshot.id);
  const observations =
    snapshotIds.length === 0
      ? []
      : await database
          .selectFrom('dependencyObservations')
          .select([
            'id',
            'repositorySnapshotId',
            'dependencyKind',
            'manifestPath',
            'declaredRange',
            'resolvedVersion',
          ])
          .where('repositorySnapshotId', 'in', snapshotIds)
          .where('packageName', '=', specification.canonicalIdentifier)
          .orderBy('manifestPath', 'asc')
          .orderBy('id', 'asc')
          .execute();

  const observationsBySnapshot = new Map<string, CandidateObservation[]>();
  for (const observation of observations) {
    const existing = observationsBySnapshot.get(observation.repositorySnapshotId);
    const candidate = {
      id: observation.id,
      dependencyKind: observation.dependencyKind,
      manifestPath: observation.manifestPath,
      declaredRange: observation.declaredRange,
      resolvedVersion: observation.resolvedVersion,
    };
    if (existing) {
      existing.push(candidate);
    } else {
      observationsBySnapshot.set(observation.repositorySnapshotId, [candidate]);
    }
  }

  const existingCandidateRepositories = await database
    .selectFrom('migrationCandidates as candidate')
    .innerJoin(
      'migrationSpecifications as existingSpecification',
      'existingSpecification.id',
      'candidate.migrationSpecificationId',
    )
    .innerJoin(
      'vendorReleases as existingRelease',
      'existingRelease.id',
      'existingSpecification.vendorReleaseId',
    )
    .select('candidate.repositoryId')
    .distinct()
    .where('candidate.status', '=', 'open')
    .where('existingRelease.apiProductId', '=', specification.apiProductId)
    .execute();

  const snapshotsByRepository = new Map(
    snapshots.map(snapshot => [snapshot.repositoryId, snapshot]),
  );
  const repositoryIds = new Set([
    ...snapshots.map(snapshot => snapshot.repositoryId),
    ...existingCandidateRepositories.map(candidate => candidate.repositoryId),
  ]);
  let matchedRepositories = 0;
  let unmatchedRepositories = 0;
  for (const repositoryId of repositoryIds) {
    const snapshot = snapshotsByRepository.get(repositoryId);
    const observation = snapshot
      ? selectMatchingObservation(
          observationsBySnapshot.get(snapshot.id) ?? [],
          specification.sourceCompatibility,
        )
      : undefined;
    await reconcileCandidate(
      database,
      repositoryId,
      specificationId,
      observation?.id ?? null,
      detectedAt,
    );
    if (observation) {
      matchedRepositories += 1;
    } else {
      unmatchedRepositories += 1;
    }
  }
  return { matchedRepositories, unmatchedRepositories };
}

export async function reconcileCandidatesForRepository(
  database: CandidateDatabase,
  repositoryId: string,
  snapshotId: string,
  detectedAt: Date,
): Promise<CandidateReconciliationSummary> {
  const specifications = await database
    .selectFrom('migrationSpecifications as specification')
    .innerJoin(
      'vendorReleases as release',
      'release.id',
      'specification.vendorReleaseId',
    )
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .select([
      'specification.id',
      'specification.sourceCompatibility',
      'product.canonicalIdentifier',
    ])
    .where('specification.trustState', 'in', ['reviewed', 'vendor_verified'])
    .where('product.status', '=', 'active')
    .orderBy('release.apiProductId', 'asc')
    .orderBy('release.revision', 'asc')
    .orderBy('specification.revision', 'asc')
    .orderBy('specification.createdAt', 'asc')
    .orderBy('specification.id', 'asc')
    .limit(1_001)
    .execute();
  if (specifications.length > 1_000) {
    throw new CandidateMatchingError('CANDIDATE_RECONCILIATION_LIMIT_EXCEEDED');
  }

  const observations = await database
    .selectFrom('dependencyObservations')
    .select([
      'id',
      'packageName',
      'dependencyKind',
      'manifestPath',
      'declaredRange',
      'resolvedVersion',
    ])
    .where('repositorySnapshotId', '=', snapshotId)
    .orderBy('manifestPath', 'asc')
    .orderBy('id', 'asc')
    .execute();
  let matchedRepositories = 0;
  let unmatchedRepositories = 0;
  for (const specification of specifications) {
    requireValidSourceCompatibility(specification.sourceCompatibility);
    const observation = selectMatchingObservation(
      observations.filter(
        candidate => candidate.packageName === specification.canonicalIdentifier,
      ),
      specification.sourceCompatibility,
    );
    await reconcileCandidate(
      database,
      repositoryId,
      specification.id,
      observation?.id ?? null,
      detectedAt,
    );
    if (observation) {
      matchedRepositories += 1;
    } else {
      unmatchedRepositories += 1;
    }
  }
  return { matchedRepositories, unmatchedRepositories };
}

function selectMatchingObservation(
  observations: readonly CandidateObservation[],
  sourceCompatibility: string,
): CandidateObservation | undefined {
  return [...observations]
    .sort(
      (left, right) =>
        dependencyKindPriority(left.dependencyKind) -
          dependencyKindPriority(right.dependencyKind) ||
        left.manifestPath.localeCompare(right.manifestPath) ||
        left.id.localeCompare(right.id),
    )
    .find(observation =>
      dependencyMatchesSourceCompatibility(observation, sourceCompatibility),
    );
}

function dependencyKindPriority(
  dependencyKind: CandidateObservation['dependencyKind'],
): number {
  return dependencyKind === 'dependency'
    ? 0
    : dependencyKind === 'optional'
      ? 1
      : dependencyKind === 'peer'
        ? 2
        : 3;
}

function requireValidSourceCompatibility(sourceCompatibility: string): void {
  if (!validRange(sourceCompatibility)) {
    throw new CandidateMatchingError('SOURCE_COMPATIBILITY_INVALID');
  }
}

async function reconcileCandidate(
  database: CandidateDatabase,
  repositoryId: string,
  specificationId: string,
  observationId: string | null,
  detectedAt: Date,
): Promise<void> {
  await sql`
    select reconcile_migration_candidate(
      ${repositoryId}::uuid,
      ${specificationId}::uuid,
      ${observationId}::uuid,
      ${detectedAt}::timestamptz
    )
  `.execute(database);
}
