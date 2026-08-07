import { createHash, randomUUID } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { Transaction } from 'kysely';

import { parseConfig, vendorFetcherConfigSchema } from '@migration/config';
import {
  vendorIngestionResultSchema,
  type VendorIngestionResult,
} from '@migration/contracts';
import { createDatabase, type AppDatabase, type Database } from '@migration/database';
import { safeErrorCode, writeLog } from '@migration/observability';
import {
  retrieveVendorSource,
  VendorEvidenceError,
  type RetrievedVendorSource,
} from '@migration/vendor-intelligence';

const RESULT_MEDIA_TYPE = 'application/json';
const STALE_RUN_MS = 20 * 60 * 1000;
const MAX_REGISTRY_PACKUMENT_BYTES = 32 * 1024 * 1024;
const MAX_NORMALIZED_REGISTRY_EVIDENCE_BYTES = 64 * 1024;
const MAX_MIGRATION_GUIDANCE_SOURCES = 3;

const migrationEvidencePriority = new Map<ReleaseEvidenceSource['sourceKind'], number>([
  ['migration_guide', 0],
  ['changelog', 1],
  ['release_feed', 2],
  ['api_definition', 3],
]);

interface VendorFetcherDependencies {
  readonly database: AppDatabase;
  readonly s3: S3Client;
  readonly retrieve: typeof retrieveVendorSource;
  readonly now: () => Date;
}

export interface ReleaseEvidenceSource {
  readonly id: string;
  readonly sourceKey: string;
  readonly sourceKind:
    | 'package_registry_release'
    | 'migration_guide'
    | 'changelog'
    | 'release_feed'
    | 'api_definition'
    | 'sdk_repository_release';
  readonly canonicalUrl: string;
  readonly canonicalDomain: string;
  readonly expectedMediaTypes: readonly string[];
}

interface ReleaseContext {
  readonly releaseId: string;
  readonly version: string;
  readonly sourceVersion: string;
  readonly sourceDigest: string;
  readonly processingState: 'registered' | 'fetched' | 'validated' | 'rejected';
  readonly productId: string;
  readonly packageIdentifier: string;
  readonly vendorSlug: string;
  readonly officialDomains: readonly string[];
  readonly detectedRegistryEvidence: {
    readonly sourceId: string;
    readonly objectKey: string;
    readonly digest: string;
  } | null;
  readonly sources: readonly ReleaseEvidenceSource[];
}

interface AcquiredSource {
  readonly definition: ReleaseContext['sources'][number];
  readonly evidence: RetrievedVendorSource;
  readonly objectKey: string;
}

async function main(): Promise<void> {
  const config = parseConfig(vendorFetcherConfigSchema);
  const database = await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN);
  try {
    await ingestVendorRelease(config, {
      database,
      s3: new S3Client({ region: config.AWS_REGION }),
      retrieve: retrieveVendorSource,
      now: () => new Date(),
    });
  } finally {
    await database.destroy();
  }
}

export async function ingestVendorRelease(
  config: ReturnType<typeof vendorFetcherConfigSchema.parse>,
  dependencies: VendorFetcherDependencies,
): Promise<void> {
  const context = await loadReleaseContext(
    dependencies.database,
    config.VENDOR_RELEASE_ID,
  );
  const run = await beginRun(
    dependencies.database,
    context,
    config.CORRELATION_ID,
    dependencies.now(),
  );
  if (run.alreadySucceeded) {
    writeLog('info', {
      event: 'vendor_ingestion_duplicate',
      requestId: run.id,
      correlationId: config.CORRELATION_ID,
      outcome: 'succeeded',
    });
    return;
  }

  let failureStage = 'retrieve_source';
  try {
    const acquired: AcquiredSource[] = [];
    const allowedDomains = new Set(context.officialDomains);
    for (const source of context.sources) {
      const usesDetectedRegistryEvidence =
        context.detectedRegistryEvidence?.sourceId === source.id;
      const evidence = usesDetectedRegistryEvidence
        ? await readDetectedRegistryEvidence(
            dependencies.s3,
            config.ARTIFACT_BUCKET,
            config.APP_ENVIRONMENT,
            context.detectedRegistryEvidence,
            source,
            {
              packageIdentifier: context.packageIdentifier,
              sourceVersion: context.sourceVersion,
              targetVersion: context.version,
            },
          )
        : await dependencies.retrieve({
            sourceKey: source.sourceKey,
            canonicalUrl: source.canonicalUrl,
            expectedMediaTypes: source.expectedMediaTypes,
            allowedDomains,
          });
      if (
        !usesDetectedRegistryEvidence &&
        source.sourceKey === 'release_metadata' &&
        evidence.digest !== context.sourceDigest
      ) {
        throw new VendorEvidenceError('VENDOR_RELEASE_SOURCE_DIGEST_MISMATCH');
      }
      failureStage = 'store_source';
      const objectKey = sourceObjectKey(
        config.APP_ENVIRONMENT,
        context.vendorSlug,
        context.productId,
        context.releaseId,
        source.id,
        evidence.digest,
      );
      await putImmutableObject(dependencies.s3, {
        bucket: config.ARTIFACT_BUCKET,
        key: objectKey,
        body: evidence.bytes,
        mediaType: evidence.mediaType,
        kmsKeyArn: config.ARTIFACT_KMS_KEY_ARN,
        metadata: {
          digest: evidence.digest,
          'vendor-release-id': context.releaseId,
          'vendor-source-id': source.id,
        },
      });
      acquired.push({ definition: source, evidence, objectKey });
      failureStage = 'retrieve_source';
    }

    failureStage = 'build_bundle';
    const manifest = JSON.stringify({
      schemaVersion: '1.0',
      vendorReleaseId: context.releaseId,
      vendorSlug: context.vendorSlug,
      productId: context.productId,
      version: context.version,
      sources: acquired
        .map(item => ({
          vendorSourceId: item.definition.id,
          sourceKey: item.definition.sourceKey,
          canonicalUrl: item.evidence.canonicalUrl,
          finalUrl: item.evidence.finalUrl,
          objectKey: item.objectKey,
          digest: item.evidence.digest,
          bytes: item.evidence.bytes.byteLength,
          mediaType: item.evidence.mediaType,
          etag: item.evidence.etag,
        }))
        .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey)),
    });
    const manifestBytes = Buffer.from(manifest, 'utf8');
    const manifestDigest = digest(manifestBytes);
    const manifestKey = bundleObjectKey(
      config.APP_ENVIRONMENT,
      context.vendorSlug,
      context.productId,
      context.releaseId,
      manifestDigest,
    );
    failureStage = 'store_bundle';
    await putImmutableObject(dependencies.s3, {
      bucket: config.ARTIFACT_BUCKET,
      key: manifestKey,
      body: manifestBytes,
      mediaType: RESULT_MEDIA_TYPE,
      kmsKeyArn: config.ARTIFACT_KMS_KEY_ARN,
      metadata: {
        digest: manifestDigest,
        'vendor-release-id': context.releaseId,
      },
    });

    const result = vendorIngestionResultSchema.parse({
      schemaVersion: '1.0',
      vendorReleaseId: context.releaseId,
      ingestionRunId: run.id,
      status: 'succeeded',
      safeErrorCode: null,
      bundle: {
        objectKey: manifestKey,
        digest: manifestDigest,
        bytes: manifestBytes.byteLength,
        sources: acquired.map(item => ({
          vendorSourceId: item.definition.id,
          sourceKey: item.definition.sourceKey,
          canonicalUrl: item.evidence.canonicalUrl,
          objectKey: item.objectKey,
          digest: item.evidence.digest,
          bytes: item.evidence.bytes.byteLength,
          mediaType: item.evidence.mediaType,
          etag: item.evidence.etag,
        })),
      },
    });
    if (!result.bundle) {
      throw new VendorEvidenceError('VENDOR_INGESTION_RESULT_INVALID');
    }
    failureStage = 'write_result';
    await writeResult(config, dependencies.s3, result);
    failureStage = 'persist_success';
    await persistSuccess(
      dependencies.database,
      context,
      run.id,
      acquired,
      result.bundle,
      dependencies.now(),
    );
    writeLog('info', {
      event: 'vendor_ingestion_completed',
      requestId: run.id,
      correlationId: config.CORRELATION_ID,
      outcome: acquired.length.toString(),
    });
  } catch (error) {
    const code = classifyFailure(error);
    writeLog('error', {
      event: 'vendor_ingestion_failed',
      requestId: run.id,
      correlationId: config.CORRELATION_ID,
      safeErrorCode: code,
      errorClass: classifyErrorClass(error),
      failureStage,
    });
    await persistFailure(dependencies.database, run.id, code, dependencies.now());
    const result = vendorIngestionResultSchema.parse({
      schemaVersion: '1.0',
      vendorReleaseId: context.releaseId,
      ingestionRunId: run.id,
      status: 'failed',
      safeErrorCode: code,
      bundle: null,
    });
    await writeResult(config, dependencies.s3, result);
    throw new VendorEvidenceError(code);
  }
}

async function loadReleaseContext(
  database: AppDatabase,
  releaseId: string,
): Promise<ReleaseContext> {
  // Evidence refresh creates a new immutable release revision, not a duplicate
  // registry detection. Reuse only the detection bound to this exact version route.
  const release = await database
    .selectFrom('vendorReleases as release')
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
    .leftJoin('packageReleaseDetections as detection', join =>
      join
        .onRef('detection.apiProductId', '=', 'release.apiProductId')
        .onRef('detection.version', '=', 'release.version')
        .onRef('detection.sourceVersion', '=', 'release.sourceCompatibility')
        .on('detection.latestDeprecated', '=', false)
        .on('detection.status', '=', 'detected')
        .on('detection.vendorReleaseId', 'is not', null),
    )
    .select([
      'release.id as releaseId',
      'release.version',
      'release.sourceCompatibility as sourceVersion',
      'release.sourceDigest',
      'release.processingState',
      'product.id as productId',
      'product.canonicalIdentifier as packageIdentifier',
      'vendor.slug as vendorSlug',
      'vendor.officialDomains',
      'vendor.trustState as vendorTrustState',
      'product.status as productStatus',
      'detection.vendorReleaseId as detectedVendorReleaseId',
      'detection.sourceId as detectedSourceId',
      'detection.evidenceObjectKey as detectedEvidenceObjectKey',
      'detection.evidenceDigest as detectedEvidenceDigest',
    ])
    .where('release.id', '=', releaseId)
    .executeTakeFirst();
  if (
    release?.vendorTrustState !== 'trusted' ||
    release.productStatus !== 'active' ||
    release.sourceVersion === null ||
    release.processingState === 'rejected'
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_NOT_FETCHABLE');
  }
  const sources = await database
    .selectFrom('vendorSources')
    .select([
      'id',
      'sourceKey',
      'sourceKind',
      'canonicalUrl',
      'expectedMediaTypes',
      'canonicalDomain',
    ])
    .where('apiProductId', '=', release.productId)
    .where('trustState', '=', 'trusted')
    .orderBy('sourceKey', 'asc')
    .limit(50)
    .execute();
  if (
    sources.length === 0 ||
    sources.some(source => !release.officialDomains.includes(source.canonicalDomain)) ||
    (release.detectedSourceId !== null &&
      !sources.some(source => source.id === release.detectedSourceId))
  ) {
    throw new VendorEvidenceError('VENDOR_SOURCE_CATALOGUE_INVALID');
  }
  const selectedSources = selectReleaseEvidenceSources(
    sources,
    release.detectedSourceId,
  );
  if (
    selectedSources.length === 0 ||
    (release.detectedSourceId !== null &&
      !selectedSources.some(source => source.id === release.detectedSourceId))
  ) {
    throw new VendorEvidenceError('VENDOR_SOURCE_CATALOGUE_INVALID');
  }
  const detectedRegistryEvidence =
    release.detectedSourceId &&
    release.detectedEvidenceObjectKey &&
    release.detectedEvidenceDigest
      ? {
          sourceId: release.detectedSourceId,
          objectKey: release.detectedEvidenceObjectKey,
          digest: release.detectedEvidenceDigest,
        }
      : null;
  if (
    release.detectedVendorReleaseId === release.releaseId &&
    release.sourceDigest !== detectedRegistryEvidence?.digest
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_SOURCE_DIGEST_MISMATCH');
  }
  return {
    ...release,
    sourceVersion: release.sourceVersion,
    detectedRegistryEvidence,
    sources: selectedSources,
  };
}

/**
 * Keep machine-readable registry evidence plus at most three sources that can
 * directly explain an upgrade. Generic repository roots are identity evidence,
 * not migration guidance, and are intentionally excluded from model input.
 */
export function selectReleaseEvidenceSources(
  sources: readonly ReleaseEvidenceSource[],
  detectedSourceId: string | null,
): readonly ReleaseEvidenceSource[] {
  const registrySources = sources
    .filter(source => source.sourceKind === 'package_registry_release')
    .sort((left, right) => {
      const leftDetected = left.id === detectedSourceId ? 0 : 1;
      const rightDetected = right.id === detectedSourceId ? 0 : 1;
      return (
        leftDetected - rightDetected || left.sourceKey.localeCompare(right.sourceKey)
      );
    })
    .slice(0, 1);
  const guidanceSources = sources
    .filter(
      source =>
        migrationEvidencePriority.has(source.sourceKind) &&
        !isGenericGithubReleaseHistory(source),
    )
    .sort(
      (left, right) =>
        (migrationEvidencePriority.get(left.sourceKind) ?? Number.MAX_SAFE_INTEGER) -
          (migrationEvidencePriority.get(right.sourceKind) ??
            Number.MAX_SAFE_INTEGER) || left.sourceKey.localeCompare(right.sourceKey),
    )
    .slice(0, MAX_MIGRATION_GUIDANCE_SOURCES);
  return [...registrySources, ...guidanceSources];
}

function isGenericGithubReleaseHistory(source: ReleaseEvidenceSource): boolean {
  if (source.sourceKind !== 'release_feed') return false;
  const url = new URL(source.canonicalUrl);
  return url.hostname === 'github.com' && /\/releases\/?$/u.test(url.pathname);
}

export async function readDetectedRegistryEvidence(
  s3: S3Client,
  bucket: string,
  environment: string,
  evidence: NonNullable<ReleaseContext['detectedRegistryEvidence']>,
  source: ReleaseContext['sources'][number],
  release: {
    readonly packageIdentifier: string;
    readonly sourceVersion: string;
    readonly targetVersion: string;
  },
): Promise<RetrievedVendorSource> {
  const prefix = `env/${environment}/package-release/npm/source/${source.id}/poll/`;
  if (
    source.id !== evidence.sourceId ||
    !evidence.objectKey.startsWith(prefix) ||
    !/\/poll\/[0-9a-f-]{36}\/metadata\.json$/u.test(evidence.objectKey)
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: evidence.objectKey,
      ChecksumMode: 'ENABLED',
    }),
  );
  if (
    !object.Body ||
    !object.ContentLength ||
    object.ContentLength > MAX_REGISTRY_PACKUMENT_BYTES ||
    object.ContentType?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
    object.Metadata?.digest !== evidence.digest ||
    object.Metadata['source-id'] !== source.id
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  const bytes = await object.Body.transformToByteArray();
  const evidenceDigest = digest(bytes);
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_REGISTRY_PACKUMENT_BYTES ||
    bytes.byteLength !== object.ContentLength ||
    evidenceDigest !== evidence.digest ||
    (object.ChecksumSHA256 !== undefined &&
      object.ChecksumSHA256 !== Buffer.from(evidenceDigest, 'hex').toString('base64'))
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  const normalizedBytes = normalizeRegistryEvidence(bytes, evidence.digest, release);
  return {
    canonicalUrl: source.canonicalUrl,
    finalUrl: source.canonicalUrl,
    bytes: normalizedBytes,
    digest: digest(normalizedBytes),
    mediaType: 'application/json',
    etag: null,
  };
}

function normalizeRegistryEvidence(
  rawBytes: Uint8Array,
  rawDigest: string,
  release: {
    readonly packageIdentifier: string;
    readonly sourceVersion: string;
    readonly targetVersion: string;
  },
): Uint8Array {
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(rawBytes).toString('utf8'));
  } catch {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  const packument = record(document);
  const distTags = record(packument?.['dist-tags']);
  const versions = record(packument?.versions);
  const sourceMetadata = record(versions?.[release.sourceVersion]);
  const targetMetadata = record(versions?.[release.targetVersion]);
  if (
    packument?.name !== release.packageIdentifier ||
    distTags?.latest !== release.targetVersion ||
    sourceMetadata?.version !== release.sourceVersion ||
    targetMetadata?.version !== release.targetVersion
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  const normalized = Buffer.from(
    JSON.stringify({
      schemaVersion: '1.0',
      packageIdentifier: release.packageIdentifier,
      sourceVersion: release.sourceVersion,
      targetVersion: release.targetVersion,
      publishedAt: boundedString(record(packument.time)?.[release.targetVersion], 100),
      rawEvidenceDigest: rawDigest,
      source: summarizePackageVersion(sourceMetadata),
      target: summarizePackageVersion(targetMetadata),
    }),
    'utf8',
  );
  if (
    normalized.byteLength === 0 ||
    normalized.byteLength > MAX_NORMALIZED_REGISTRY_EVIDENCE_BYTES
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_REGISTRY_EVIDENCE_INVALID');
  }
  return normalized;
}

function summarizePackageVersion(metadata: Record<string, unknown>): unknown {
  return {
    version: metadata.version,
    deprecated: boundedString(metadata.deprecated, 2_000),
    license: boundedString(metadata.license, 500),
    type: boundedString(metadata.type, 100),
    engines: boundedStringRecord(metadata.engines, 25, 200),
    dependencies: boundedStringRecord(metadata.dependencies, 200, 500),
    peerDependencies: boundedStringRecord(metadata.peerDependencies, 200, 500),
  };
}

function boundedStringRecord(
  value: unknown,
  maximumEntries: number,
  maximumValueLength: number,
): { readonly entries: Record<string, string>; readonly total: number } | null {
  const input = record(value);
  if (!input) return null;
  const allEntries = Object.entries(input).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const entries: Record<string, string> = {};
  for (const [key, candidate] of allEntries.slice(0, maximumEntries)) {
    if (key.length <= 214 && typeof candidate === 'string') {
      entries[key] = candidate.slice(0, maximumValueLength);
    }
  }
  return { entries, total: allEntries.length };
}

function boundedString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' ? value.slice(0, maximumLength) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function beginRun(
  database: AppDatabase,
  context: ReleaseContext,
  correlationId: string,
  now: Date,
): Promise<{ readonly id: string; readonly alreadySucceeded: boolean }> {
  return database.transaction().execute(async transaction => {
    const release = await transaction
      .selectFrom('vendorReleases')
      .select(['processingState'])
      .where('id', '=', context.releaseId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const existing = await transaction
      .selectFrom('vendorIngestionRuns')
      .select(['id', 'status', 'attempt', 'updatedAt'])
      .where('vendorReleaseId', '=', context.releaseId)
      .forUpdate()
      .executeTakeFirst();
    if (release.processingState === 'validated' && existing?.status === 'succeeded') {
      return { id: existing.id, alreadySucceeded: true };
    }
    if (
      existing?.status === 'running' &&
      now.getTime() - existing.updatedAt.getTime() < STALE_RUN_MS
    ) {
      throw new VendorEvidenceError('VENDOR_INGESTION_IN_PROGRESS');
    }
    if (existing && existing.attempt >= 10) {
      throw new VendorEvidenceError('VENDOR_INGESTION_RETRY_EXHAUSTED');
    }
    if (existing) {
      await transaction
        .updateTable('vendorIngestionRuns')
        .set(expression => ({
          status: 'running',
          attempt: expression('attempt', '+', 1),
          safeErrorCode: null,
          correlationId,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }))
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow();
      return { id: existing.id, alreadySucceeded: false };
    }
    const id = randomUUID();
    await transaction
      .insertInto('vendorIngestionRuns')
      .values({
        id,
        vendorReleaseId: context.releaseId,
        status: 'running',
        attempt: 1,
        safeErrorCode: null,
        correlationId,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return { id, alreadySucceeded: false };
  });
}

async function persistSuccess(
  database: AppDatabase,
  context: ReleaseContext,
  runId: string,
  acquired: readonly AcquiredSource[],
  bundle: NonNullable<VendorIngestionResult['bundle']>,
  now: Date,
): Promise<void> {
  await database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('vendorIngestionRuns')
      .select('status')
      .where('id', '=', runId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (run.status !== 'running') {
      throw new VendorEvidenceError('VENDOR_INGESTION_STATE_CONFLICT');
    }
    for (const item of acquired) {
      await persistEvidenceItem(transaction, context.releaseId, item, now);
      await transaction
        .updateTable('vendorSources')
        .set({
          lastDigest: item.evidence.digest,
          lastEtag: item.evidence.etag,
          lastCheckedAt: now,
          updatedAt: now,
        })
        .where('id', '=', item.definition.id)
        .executeTakeFirstOrThrow();
    }
    const releaseUpdate = await transaction
      .updateTable('vendorReleases')
      .set({
        evidenceObjectKey: bundle.objectKey,
        evidenceDigest: bundle.digest,
        processingState: 'validated',
      })
      .where('id', '=', context.releaseId)
      .where('processingState', 'in', ['registered', 'fetched'])
      .executeTakeFirstOrThrow();
    if (releaseUpdate.numUpdatedRows !== 1n) {
      throw new VendorEvidenceError('VENDOR_INGESTION_STATE_CONFLICT');
    }
    const runUpdate = await transaction
      .updateTable('vendorIngestionRuns')
      .set({
        status: 'succeeded',
        safeErrorCode: null,
        completedAt: now,
        updatedAt: now,
      })
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
    if (runUpdate.numUpdatedRows !== 1n) {
      throw new VendorEvidenceError('VENDOR_INGESTION_STATE_CONFLICT');
    }
  });
}

async function persistEvidenceItem(
  transaction: Transaction<Database>,
  releaseId: string,
  item: AcquiredSource,
  now: Date,
): Promise<void> {
  const existing = await transaction
    .selectFrom('vendorEvidenceItems')
    .select(['digest', 'objectKey'])
    .where('vendorReleaseId', '=', releaseId)
    .where('vendorSourceId', '=', item.definition.id)
    .executeTakeFirst();
  if (existing) {
    if (
      existing.digest !== item.evidence.digest ||
      existing.objectKey !== item.objectKey
    ) {
      throw new VendorEvidenceError('VENDOR_EVIDENCE_IMMUTABILITY_CONFLICT');
    }
    return;
  }
  await transaction
    .insertInto('vendorEvidenceItems')
    .values({
      id: randomUUID(),
      vendorReleaseId: releaseId,
      vendorSourceId: item.definition.id,
      canonicalUrl: item.evidence.canonicalUrl,
      objectKey: item.objectKey,
      digest: item.evidence.digest,
      bytes: item.evidence.bytes.byteLength,
      mediaType: item.evidence.mediaType,
      etag: item.evidence.etag,
      retrievedAt: now,
      createdAt: now,
    })
    .executeTakeFirstOrThrow();
}

async function persistFailure(
  database: AppDatabase,
  runId: string,
  code: string,
  now: Date,
): Promise<void> {
  await database
    .updateTable('vendorIngestionRuns')
    .set({
      status: 'failed',
      safeErrorCode: code,
      completedAt: now,
      updatedAt: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .executeTakeFirst();
}

interface ImmutableObjectInput {
  readonly bucket: string;
  readonly key: string;
  readonly body: Uint8Array;
  readonly mediaType: string;
  readonly kmsKeyArn: string;
  readonly metadata: Readonly<Record<string, string>>;
}

async function putImmutableObject(
  s3: S3Client,
  input: ImmutableObjectInput,
): Promise<void> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentLength: input.body.byteLength,
        ContentType: input.mediaType,
        IfNoneMatch: '*',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: input.kmsKeyArn,
        Metadata: input.metadata,
      }),
    );
  } catch (error) {
    if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) {
      return;
    }
    throw error;
  }
}

async function writeResult(
  config: ReturnType<typeof vendorFetcherConfigSchema.parse>,
  s3: S3Client,
  result: VendorIngestionResult,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(result), 'utf8');
  await s3.send(
    new PutObjectCommand({
      Bucket: config.ARTIFACT_BUCKET,
      Key: resultObjectKey(
        config.APP_ENVIRONMENT,
        result.vendorReleaseId,
        result.ingestionRunId,
      ),
      Body: body,
      ContentLength: body.byteLength,
      ContentType: RESULT_MEDIA_TYPE,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': '1.0',
        'vendor-release-id': result.vendorReleaseId,
        'ingestion-run-id': result.ingestionRunId,
      },
    }),
  );
}

function classifyFailure(error: unknown): string {
  const code = safeErrorCode(error);
  return code === 'INTERNAL_ERROR' ? 'VENDOR_INGESTION_FAILED' : code;
}

function classifyErrorClass(error: unknown): string {
  if (error instanceof VendorEvidenceError) return 'VendorEvidenceError';
  if (error instanceof S3ServiceException) return 'S3ServiceException';
  return error instanceof Error ? 'Error' : 'UnknownError';
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sourceObjectKey(
  environment: string,
  vendorSlug: string,
  productId: string,
  releaseId: string,
  sourceId: string,
  sourceDigest: string,
): string {
  return `env/${environment}/vendor/${vendorSlug}/product/${productId}/release/${releaseId}/source/${sourceId}/${sourceDigest}`;
}

export function bundleObjectKey(
  environment: string,
  vendorSlug: string,
  productId: string,
  releaseId: string,
  bundleDigest: string,
): string {
  return `env/${environment}/vendor/${vendorSlug}/product/${productId}/release/${releaseId}/bundle/${bundleDigest}.json`;
}

export function resultObjectKey(
  environment: string,
  releaseId: string,
  runId: string,
): string {
  return `env/${environment}/vendor/release/${releaseId}/ingestion/${runId}/result.json`;
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
