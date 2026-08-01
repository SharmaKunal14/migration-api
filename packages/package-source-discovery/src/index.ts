import { sql, type Transaction } from 'kysely';

import type { AppDatabase, Database } from '@migration/database';

const MAX_PACKAGES_PER_OBSERVATION = 10_000;
const npmPackageNamePattern =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

type PackageSourceDatabase = AppDatabase | Transaction<Database>;

export interface ClaimedNpmPackageSourceMapping {
  mappingId: string;
  packageName: string;
  resolutionRunId: string;
  attempt: number;
}

export interface NpmPackageSourceCandidateInput {
  sourceKind:
    | 'package_registry_release'
    | 'sdk_repository_release'
    | 'homepage'
    | 'issue_tracker';
  canonicalUrl: string;
  canonicalDomain: string;
}

export class PackageSourceDiscoveryError extends Error {
  public constructor(
    public readonly safeCode:
      'PACKAGE_SOURCE_DISCOVERY_LIMIT_EXCEEDED' | 'PACKAGE_SOURCE_NAME_INVALID',
  ) {
    super('Package source discovery could not be recorded safely.');
    this.name = 'PackageSourceDiscoveryError';
  }
}

export function normalizeNpmPackageNames(packageNames: readonly string[]): string[] {
  if (packageNames.length > MAX_PACKAGES_PER_OBSERVATION) {
    throw new PackageSourceDiscoveryError('PACKAGE_SOURCE_DISCOVERY_LIMIT_EXCEEDED');
  }

  const uniqueNames = new Set<string>();
  for (const packageName of packageNames) {
    if (
      packageName.length < 1 ||
      packageName.length > 214 ||
      !npmPackageNamePattern.test(packageName)
    ) {
      throw new PackageSourceDiscoveryError('PACKAGE_SOURCE_NAME_INVALID');
    }
    uniqueNames.add(packageName);
  }
  return [...uniqueNames].sort((left, right) => left.localeCompare(right));
}

export async function observeNpmPackageSources(
  database: PackageSourceDatabase,
  packageNames: readonly string[],
  observedAt: Date,
): Promise<void> {
  const normalizedNames = normalizeNpmPackageNames(packageNames);
  if (normalizedNames.length === 0) return;

  await sql`
    select observe_npm_package_sources(
      ${normalizedNames}::text[],
      ${observedAt}::timestamptz
    )
  `.execute(database);
}

export async function claimNpmPackageSourceMappings(
  database: PackageSourceDatabase,
  input: {
    workerId: string;
    correlationId: string;
    limit: number;
    leaseSeconds: number;
  },
): Promise<ClaimedNpmPackageSourceMapping[]> {
  const result = await sql<ClaimedNpmPackageSourceMapping>`
    select
      mapping_id as "mappingId",
      package_name as "packageName",
      resolution_run_id as "resolutionRunId",
      attempt
    from claim_npm_package_source_mappings(
      ${input.workerId}::uuid,
      ${input.correlationId}::uuid,
      ${input.limit}::integer,
      ${input.leaseSeconds}::integer
    )
  `.execute(database);
  return result.rows;
}

export async function completeNpmPackageSourceResolution(
  database: PackageSourceDatabase,
  input: {
    mappingId: string;
    resolutionRunId: string;
    workerId: string;
    evidenceObjectKey: string;
    evidenceDigest: string;
    latestVersion: string;
    latestDeprecated: boolean;
    registryEtag: string | null;
    candidates: readonly NpmPackageSourceCandidateInput[];
  },
): Promise<void> {
  await sql`
    select complete_npm_package_source_resolution(
      ${input.mappingId}::uuid,
      ${input.resolutionRunId}::uuid,
      ${input.workerId}::uuid,
      ${input.evidenceObjectKey},
      ${input.evidenceDigest},
      ${input.latestVersion},
      ${input.latestDeprecated},
      ${input.registryEtag},
      ${JSON.stringify(input.candidates)}::jsonb
    )
  `.execute(database);
}

export async function failNpmPackageSourceResolution(
  database: PackageSourceDatabase,
  input: {
    mappingId: string;
    resolutionRunId: string;
    workerId: string;
    safeErrorCode: string;
  },
): Promise<void> {
  await sql`
    select fail_npm_package_source_resolution(
      ${input.mappingId}::uuid,
      ${input.resolutionRunId}::uuid,
      ${input.workerId}::uuid,
      ${input.safeErrorCode}
    )
  `.execute(database);
}
