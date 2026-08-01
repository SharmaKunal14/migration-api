import { sql, type Transaction } from 'kysely';

import type { AppDatabase, Database } from '@migration/database';

type PackageReleasePollingDatabase = AppDatabase | Transaction<Database>;

export interface ClaimedNpmPackageSource {
  sourceId: string;
  apiProductId: string;
  packageName: string;
  canonicalUrl: string;
  pollRunId: string;
  previousEtag: string | null;
  previousVersion: string | null;
}

export type PackageSourcePollOutcome =
  'baseline' | 'not_modified' | 'unchanged' | 'release_detected' | 'inconsistent';

export async function claimDueNpmPackageSources(
  database: PackageReleasePollingDatabase,
  input: {
    workerId: string;
    correlationId: string;
    limit: number;
    leaseSeconds: number;
  },
): Promise<ClaimedNpmPackageSource[]> {
  const result = await sql<ClaimedNpmPackageSource>`
    select
      source_id as "sourceId",
      api_product_id as "apiProductId",
      package_name as "packageName",
      canonical_url as "canonicalUrl",
      poll_run_id as "pollRunId",
      previous_etag as "previousEtag",
      previous_version as "previousVersion"
    from claim_due_npm_package_sources(
      ${input.workerId}::uuid,
      ${input.correlationId}::uuid,
      ${input.limit}::integer,
      ${input.leaseSeconds}::integer
    )
  `.execute(database);
  return result.rows;
}

export async function completeNpmPackageSourcePoll(
  database: PackageReleasePollingDatabase,
  input: {
    sourceId: string;
    pollRunId: string;
    workerId: string;
    outcome: PackageSourcePollOutcome;
    evidenceObjectKey: string | null;
    evidenceDigest: string | null;
    metadataDigest: string | null;
    observedVersion: string | null;
    observedPublishedAt: Date | null;
    latestDeprecated: boolean | null;
    registryEtag: string | null;
  },
): Promise<void> {
  await sql`
    select complete_npm_package_source_poll(
      ${input.sourceId}::uuid,
      ${input.pollRunId}::uuid,
      ${input.workerId}::uuid,
      ${input.outcome},
      ${input.evidenceObjectKey},
      ${input.evidenceDigest},
      ${input.metadataDigest},
      ${input.observedVersion},
      ${input.observedPublishedAt}::timestamptz,
      ${input.latestDeprecated},
      ${input.registryEtag}
    )
  `.execute(database);
}

export async function failNpmPackageSourcePoll(
  database: PackageReleasePollingDatabase,
  input: {
    sourceId: string;
    pollRunId: string;
    workerId: string;
    safeErrorCode: string;
    retryable: boolean;
  },
): Promise<boolean> {
  const result = await sql<{ shouldAlert: boolean }>`
    select fail_npm_package_source_poll(
      ${input.sourceId}::uuid,
      ${input.pollRunId}::uuid,
      ${input.workerId}::uuid,
      ${input.safeErrorCode},
      ${input.retryable}
    ) as "shouldAlert"
  `.execute(database);
  return result.rows[0]?.shouldAlert ?? false;
}
