import { sql, type Transaction } from 'kysely';

import type { AppDatabase, Database } from '@migration/database';

const MAX_PACKAGES_PER_OBSERVATION = 10_000;
const npmPackageNamePattern =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;

type PackageSourceDatabase = AppDatabase | Transaction<Database>;

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
