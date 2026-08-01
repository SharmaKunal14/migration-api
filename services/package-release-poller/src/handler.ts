import { createHash, randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { gt, lt } from 'semver';
import { z } from 'zod';

import {
  packageReleasePollerConfigSchema,
  parseConfig,
  type PackageReleasePollerConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import {
  isRetryableNpmRegistryError,
  NpmRegistryError,
  npmRegistryPackageUrl,
  npmRegistrySafeErrorCode,
  pollNpmPackageRelease,
  type NpmPackageReleasePoll,
} from '@migration/npm-registry';
import { safeErrorCode, writeLog } from '@migration/observability';
import {
  claimDueNpmPackageSources,
  completeNpmPackageSourcePoll,
  failNpmPackageSourcePoll,
  type PackageSourcePollOutcome,
} from '@migration/package-release-polling';

const BATCH_SIZE = 5;
const LEASE_SECONDS = 180;
const eventSchema = z.object({ operation: z.literal('poll_due') }).strict();

interface ObjectStore {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface PackageReleasePollerDependencies {
  readonly config: PackageReleasePollerConfig;
  readonly database: AppDatabase;
  readonly s3: ObjectStore;
  readonly pollPackage: (
    packageName: string,
    previousEtag: string | null,
  ) => Promise<NpmPackageReleasePoll>;
  readonly id: () => string;
  readonly claim: typeof claimDueNpmPackageSources;
  readonly complete: typeof completeNpmPackageSourcePoll;
  readonly fail: typeof failNpmPackageSourcePoll;
}

export interface PackageReleasePollerResult {
  claimed: number;
  succeeded: number;
  failed: number;
  releasesDetected: number;
  inconsistencies: number;
}

class PackageReleasePollError extends Error {
  public constructor(
    public readonly safeCode: 'PACKAGE_SOURCE_TRUST_BOUNDARY_INVALID',
  ) {
    super('The trusted package source did not match the fixed npm registry origin.');
    this.name = 'PackageReleasePollError';
  }
}

let cachedDependencies: PackageReleasePollerDependencies | undefined;

async function dependencies(): Promise<PackageReleasePollerDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(packageReleasePollerConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
    pollPackage: (packageName, previousEtag): Promise<NpmPackageReleasePoll> =>
      pollNpmPackageRelease(packageName, {
        registryOrigin: config.NPM_REGISTRY_ORIGIN,
        previousEtag,
        timeoutMs: 15_000,
      }),
    id: randomUUID,
    claim: claimDueNpmPackageSources,
    complete: completeNpmPackageSourcePoll,
    fail: failNpmPackageSourcePoll,
  };
  return cachedDependencies;
}

export async function handler(
  event: unknown,
  context: Context,
): Promise<PackageReleasePollerResult> {
  return handlePackageReleasePolling(event, await dependencies(), context.awsRequestId);
}

function pollOutcome(
  previousVersion: string | null,
  observedVersion: string,
): PackageSourcePollOutcome {
  if (previousVersion === null) return 'baseline';
  if (previousVersion === observedVersion) return 'unchanged';
  if (gt(observedVersion, previousVersion)) return 'release_detected';
  if (lt(observedVersion, previousVersion)) return 'inconsistent';
  return 'inconsistent';
}

function pollSafeError(error: unknown): {
  safeCode: string;
  retryable: boolean;
} {
  if (error instanceof NpmRegistryError) {
    return {
      safeCode: npmRegistrySafeErrorCode(error),
      retryable: isRetryableNpmRegistryError(error),
    };
  }
  if (error instanceof PackageReleasePollError) {
    return { safeCode: error.safeCode, retryable: false };
  }
  return { safeCode: safeErrorCode(error), retryable: true };
}

export async function handlePackageReleasePolling(
  event: unknown,
  dependency: PackageReleasePollerDependencies,
  requestId: string,
): Promise<PackageReleasePollerResult> {
  eventSchema.parse(event);
  const workerId = dependency.id();
  const correlationId = dependency.id();
  const claimed = await dependency.claim(dependency.database, {
    workerId,
    correlationId,
    limit: BATCH_SIZE,
    leaseSeconds: LEASE_SECONDS,
  });

  let succeeded = 0;
  let failed = 0;
  let releasesDetected = 0;
  let inconsistencies = 0;

  for (const source of claimed) {
    try {
      const expectedUrl = npmRegistryPackageUrl(
        source.packageName,
        dependency.config.NPM_REGISTRY_ORIGIN,
      );
      if (source.canonicalUrl !== expectedUrl) {
        throw new PackageReleasePollError('PACKAGE_SOURCE_TRUST_BOUNDARY_INVALID');
      }

      const poll = await dependency.pollPackage(
        source.packageName,
        source.previousEtag,
      );
      if (poll.status === 'not_modified') {
        await dependency.complete(dependency.database, {
          sourceId: source.sourceId,
          pollRunId: source.pollRunId,
          workerId,
          outcome: 'not_modified',
          evidenceObjectKey: null,
          evidenceDigest: null,
          metadataDigest: null,
          observedVersion: null,
          observedPublishedAt: null,
          latestDeprecated: null,
          registryEtag: poll.registryEtag,
        });
        succeeded += 1;
        continue;
      }

      const outcome = pollOutcome(source.previousVersion, poll.latestVersion);
      const body = Buffer.from(poll.responseBody);
      const digestBytes = createHash('sha256').update(body).digest();
      const evidenceDigest = digestBytes.toString('hex');
      if (evidenceDigest !== poll.responseDigest) {
        throw new PackageReleasePollError('PACKAGE_SOURCE_TRUST_BOUNDARY_INVALID');
      }
      const evidenceObjectKey = [
        'env',
        dependency.config.APP_ENVIRONMENT,
        'package-release',
        'npm',
        'source',
        source.sourceId,
        'poll',
        source.pollRunId,
        'metadata.json',
      ].join('/');

      await dependency.s3.send(
        new PutObjectCommand({
          Bucket: dependency.config.ARTIFACT_BUCKET,
          Key: evidenceObjectKey,
          Body: body,
          ContentType: 'application/json',
          ChecksumSHA256: digestBytes.toString('base64'),
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
          Metadata: {
            'evidence-kind': 'npm-packument',
            'source-id': source.sourceId,
            'poll-run-id': source.pollRunId,
            digest: evidenceDigest,
          },
        }),
      );

      await dependency.complete(dependency.database, {
        sourceId: source.sourceId,
        pollRunId: source.pollRunId,
        workerId,
        outcome,
        evidenceObjectKey,
        evidenceDigest,
        metadataDigest: poll.responseDigest,
        observedVersion: poll.latestVersion,
        observedPublishedAt:
          poll.publishedAt === null ? null : new Date(poll.publishedAt),
        latestDeprecated: poll.latestDeprecated,
        registryEtag: poll.registryEtag,
      });
      succeeded += 1;
      if (outcome === 'release_detected') releasesDetected += 1;
      if (outcome === 'inconsistent') inconsistencies += 1;
      writeLog(outcome === 'inconsistent' ? 'error' : 'info', {
        event: 'npm_package_release_poll_succeeded',
        requestId,
        correlationId,
        outcome,
      });
    } catch (error) {
      const failure = pollSafeError(error);
      let shouldAlert = false;
      try {
        shouldAlert = await dependency.fail(dependency.database, {
          sourceId: source.sourceId,
          pollRunId: source.pollRunId,
          workerId,
          safeErrorCode: failure.safeCode,
          retryable: failure.retryable,
        });
      } catch (recordingError) {
        writeLog('error', {
          event: 'npm_package_release_poll_failure_recording_failed',
          requestId,
          correlationId,
          safeErrorCode: safeErrorCode(recordingError),
        });
      }
      failed += 1;
      writeLog('error', {
        event: shouldAlert
          ? 'npm_package_release_poll_exhausted'
          : 'npm_package_release_poll_failed',
        requestId,
        correlationId,
        safeErrorCode: failure.safeCode,
      });
    }
  }

  const result = {
    claimed: claimed.length,
    succeeded,
    failed,
    releasesDetected,
    inconsistencies,
  };
  writeLog('info', {
    event: 'npm_package_release_poll_batch_completed',
    requestId,
    correlationId,
    outcome: `${String(succeeded)}/${String(claimed.length)}`,
  });
  return result;
}
