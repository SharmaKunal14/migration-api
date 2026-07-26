import { createHash, randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
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

interface VendorFetcherDependencies {
  readonly database: AppDatabase;
  readonly s3: S3Client;
  readonly retrieve: typeof retrieveVendorSource;
  readonly now: () => Date;
}

interface ReleaseContext {
  readonly releaseId: string;
  readonly version: string;
  readonly sourceDigest: string;
  readonly processingState: 'registered' | 'fetched' | 'validated' | 'rejected';
  readonly productId: string;
  readonly vendorSlug: string;
  readonly officialDomains: readonly string[];
  readonly sources: readonly {
    id: string;
    sourceKey: string;
    canonicalUrl: string;
    expectedMediaTypes: readonly string[];
  }[];
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

  try {
    const acquired: AcquiredSource[] = [];
    const allowedDomains = new Set(context.officialDomains);
    for (const source of context.sources) {
      const evidence = await dependencies.retrieve({
        sourceKey: source.sourceKey,
        canonicalUrl: source.canonicalUrl,
        expectedMediaTypes: source.expectedMediaTypes,
        allowedDomains,
      });
      if (
        source.sourceKey === 'release_metadata' &&
        evidence.digest !== context.sourceDigest
      ) {
        throw new VendorEvidenceError('VENDOR_RELEASE_SOURCE_DIGEST_MISMATCH');
      }
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
    }

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
    await writeResult(config, dependencies.s3, result);
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
    writeLog('error', {
      event: 'vendor_ingestion_failed',
      requestId: run.id,
      correlationId: config.CORRELATION_ID,
      safeErrorCode: code,
    });
    throw new VendorEvidenceError(code);
  }
}

async function loadReleaseContext(
  database: AppDatabase,
  releaseId: string,
): Promise<ReleaseContext> {
  const release = await database
    .selectFrom('vendorReleases as release')
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
    .select([
      'release.id as releaseId',
      'release.version',
      'release.sourceDigest',
      'release.processingState',
      'product.id as productId',
      'vendor.slug as vendorSlug',
      'vendor.officialDomains',
      'vendor.trustState as vendorTrustState',
      'product.status as productStatus',
    ])
    .where('release.id', '=', releaseId)
    .executeTakeFirst();
  if (
    release?.vendorTrustState !== 'trusted' ||
    release.productStatus !== 'active' ||
    release.processingState === 'rejected'
  ) {
    throw new VendorEvidenceError('VENDOR_RELEASE_NOT_FETCHABLE');
  }
  const sources = await database
    .selectFrom('vendorSources')
    .select([
      'id',
      'sourceKey',
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
    sources.some(source => !release.officialDomains.includes(source.canonicalDomain))
  ) {
    throw new VendorEvidenceError('VENDOR_SOURCE_CATALOGUE_INVALID');
  }
  return { ...release, sources };
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
