import { createHash, randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { z } from 'zod';

import {
  packageSourceResolverConfigSchema,
  parseConfig,
  type PackageSourceResolverConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import {
  NpmRegistryError,
  resolveNpmPackageMetadata,
  npmRegistrySafeErrorCode,
  type NpmPackageResolution,
} from '@migration/npm-registry';
import { safeErrorCode, writeLog } from '@migration/observability';
import {
  claimNpmPackageSourceMappings,
  completeNpmPackageSourceResolution,
  failNpmPackageSourceResolution,
} from '@migration/package-source-discovery';

const BATCH_SIZE = 5;
const LEASE_SECONDS = 120;
const eventSchema = z.object({ operation: z.literal('resolve_due') }).strict();

interface ObjectStore {
  send(command: PutObjectCommand): Promise<unknown>;
}

export interface ResolverDependencies {
  readonly config: PackageSourceResolverConfig;
  readonly database: AppDatabase;
  readonly s3: ObjectStore;
  readonly resolvePackage: (packageName: string) => Promise<NpmPackageResolution>;
  readonly id: () => string;
  readonly now: () => Date;
  readonly claim: typeof claimNpmPackageSourceMappings;
  readonly complete: typeof completeNpmPackageSourceResolution;
  readonly fail: typeof failNpmPackageSourceResolution;
}

export interface PackageSourceResolverResult {
  claimed: number;
  succeeded: number;
  failed: number;
}

let cachedDependencies: ResolverDependencies | undefined;

async function dependencies(): Promise<ResolverDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(packageSourceResolverConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
    resolvePackage: (packageName): Promise<NpmPackageResolution> =>
      resolveNpmPackageMetadata(packageName, {
        registryOrigin: config.NPM_REGISTRY_ORIGIN,
      }),
    id: randomUUID,
    now: (): Date => new Date(),
    claim: claimNpmPackageSourceMappings,
    complete: completeNpmPackageSourceResolution,
    fail: failNpmPackageSourceResolution,
  };
  return cachedDependencies;
}

export async function handler(
  event: unknown,
  context: Context,
): Promise<PackageSourceResolverResult> {
  return handlePackageSourceResolution(
    event,
    await dependencies(),
    context.awsRequestId,
  );
}

export async function handlePackageSourceResolution(
  event: unknown,
  dependency: ResolverDependencies,
  requestId: string,
): Promise<PackageSourceResolverResult> {
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
  for (const mapping of claimed) {
    try {
      const resolution = await dependency.resolvePackage(mapping.packageName);
      const evidence = {
        schemaVersion: '1.0',
        ecosystem: 'npm',
        packageName: resolution.packageName,
        registryUrl: resolution.registryUrl,
        latestVersion: resolution.latestVersion,
        deprecated: resolution.deprecated,
        registryEtag: resolution.registryEtag,
        candidates: resolution.candidates,
        observedAt: dependency.now().toISOString(),
      } as const;
      const body = Buffer.from(JSON.stringify(evidence), 'utf8');
      const digestBytes = createHash('sha256').update(body).digest();
      const digest = digestBytes.toString('hex');
      const objectKey = [
        'env',
        dependency.config.APP_ENVIRONMENT,
        'package-source',
        'npm',
        'mapping',
        mapping.mappingId,
        'resolution',
        mapping.resolutionRunId,
        'metadata.json',
      ].join('/');

      await dependency.s3.send(
        new PutObjectCommand({
          Bucket: dependency.config.ARTIFACT_BUCKET,
          Key: objectKey,
          Body: body,
          ContentType: 'application/json',
          ChecksumSHA256: digestBytes.toString('base64'),
          ServerSideEncryption: 'aws:kms',
          SSEKMSKeyId: dependency.config.ARTIFACT_KMS_KEY_ARN,
          Metadata: {
            'schema-version': '1.0',
            'mapping-id': mapping.mappingId,
            'resolution-run-id': mapping.resolutionRunId,
            digest,
          },
        }),
      );

      await dependency.complete(dependency.database, {
        mappingId: mapping.mappingId,
        resolutionRunId: mapping.resolutionRunId,
        workerId,
        evidenceObjectKey: objectKey,
        evidenceDigest: digest,
        latestVersion: resolution.latestVersion,
        latestDeprecated: resolution.deprecated,
        registryEtag: resolution.registryEtag,
        candidates: resolution.candidates,
      });
      succeeded += 1;
      writeLog('info', {
        event: 'npm_package_resolution_succeeded',
        requestId,
        correlationId,
        outcome: String(resolution.candidates.length),
      });
    } catch (error) {
      const resolverErrorCode =
        error instanceof NpmRegistryError
          ? npmRegistrySafeErrorCode(error)
          : safeErrorCode(error);
      await dependency.fail(dependency.database, {
        mappingId: mapping.mappingId,
        resolutionRunId: mapping.resolutionRunId,
        workerId,
        safeErrorCode: resolverErrorCode,
      });
      failed += 1;
      writeLog('error', {
        event: 'npm_package_resolution_failed',
        requestId,
        correlationId,
        safeErrorCode: resolverErrorCode,
      });
    }
  }

  const result = { claimed: claimed.length, succeeded, failed };
  writeLog('info', {
    event: 'npm_package_resolution_batch_completed',
    requestId,
    correlationId,
    outcome: `${String(result.succeeded)}/${String(result.claimed)}`,
  });
  return result;
}
