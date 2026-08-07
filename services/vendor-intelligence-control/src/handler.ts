import { randomUUID } from 'node:crypto';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { sql } from 'kysely';
import { valid, validRange } from 'semver';
import { z } from 'zod';

import {
  changeIntelligencePreparedInputSchema,
  changeIntelligenceResultSchema,
  changeIntelligenceWorkflowInputSchema,
  type ChangeIntelligencePreparedInput,
  type ChangeIntelligenceResult,
  type ChangeIntelligenceWorkflowInput,
  type MigrationSpecification,
} from '@migration/contracts';
import {
  parseConfig,
  vendorIntelligenceControlConfigSchema,
  type VendorIntelligenceControlConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import { writeLog } from '@migration/observability';

const MAXIMUM_RESULT_BYTES = 1024 * 1024;
const STALE_RUN_MILLISECONDS = 20 * 60 * 1_000;

type TrustedChangeIntelligenceContext = Pick<
  ChangeIntelligencePreparedInput,
  | 'apiProductId'
  | 'vendorSlug'
  | 'vendorName'
  | 'ecosystem'
  | 'packageIdentifier'
  | 'sourceCompatibility'
  | 'targetVersion'
  | 'allowedEvidenceSourceIds'
  | 'specificationSchemaVersion'
  | 'policyVersion'
  | 'requestedModel'
  | 'budget'
>;

const commandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('prepare'),
      workflow: changeIntelligenceWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('finalize'),
      workflow: changeIntelligencePreparedInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_failed'),
      workflow: changeIntelligencePreparedInputSchema,
      safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    })
    .strict(),
]);

interface VendorIntelligenceControlDependencies {
  readonly config: VendorIntelligenceControlConfig;
  readonly database: AppDatabase;
  readonly s3: S3Client;
  readonly now: () => Date;
  readonly id: () => string;
}

let cachedDependencies: VendorIntelligenceControlDependencies | undefined;

async function dependencies(): Promise<VendorIntelligenceControlDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(vendorIntelligenceControlConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
    now: (): Date => new Date(),
    id: randomUUID,
  };
  return cachedDependencies;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  return handleVendorIntelligenceCommand(
    event,
    context.awsRequestId,
    await dependencies(),
  );
}

export async function handleVendorIntelligenceCommand(
  event: unknown,
  requestId: string,
  dependency: VendorIntelligenceControlDependencies,
): Promise<unknown> {
  const command = commandSchema.parse(event);
  if (command.operation === 'prepare') {
    const prepared = await prepareRun(dependency, command.workflow);
    writeLog('info', {
      event: 'change_intelligence_run_prepared',
      requestId,
      correlationId: command.workflow.correlationId,
      agentRunId: prepared.changeIntelligenceRunId,
      outcome: prepared.alreadySucceeded ? 'already_succeeded' : 'running',
    });
    return prepared;
  }
  if (command.operation === 'mark_failed') {
    await markRunFailed(
      dependency.database,
      command.workflow,
      command.safeErrorCode,
      dependency.now(),
    );
    return { status: 'failed' };
  }

  const result = await readResult(dependency, command.workflow);
  const status = await finalizeRun(dependency, command.workflow, result);
  writeLog(status === 'succeeded' ? 'info' : 'warn', {
    event: 'change_intelligence_run_finalized',
    requestId,
    correlationId: command.workflow.correlationId,
    agentRunId: command.workflow.changeIntelligenceRunId,
    outcome: status,
    safeErrorCode: result.safeErrorCode ?? undefined,
  });
  return {
    status,
    safeErrorCode:
      status === 'failed'
        ? (result.safeErrorCode ?? 'CHANGE_INTELLIGENCE_AGENT_FAILED')
        : null,
  };
}

async function prepareRun(
  dependency: VendorIntelligenceControlDependencies,
  workflow: ChangeIntelligenceWorkflowInput,
): Promise<ChangeIntelligencePreparedInput> {
  const now = dependency.now();
  return dependency.database.transaction().execute(async transaction => {
    const release = await transaction
      .selectFrom('vendorReleases as release')
      .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
      .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
      .select([
        'release.id',
        'release.version',
        'release.sourceCompatibility',
        'release.processingState',
        'release.evidenceObjectKey',
        'release.evidenceDigest',
        'product.ecosystem',
        'product.id as apiProductId',
        'product.canonicalIdentifier',
        'product.status as productStatus',
        'vendor.slug as vendorSlug',
        'vendor.name as vendorName',
        'vendor.trustState as vendorTrustState',
      ])
      .where('release.id', '=', workflow.vendorReleaseId)
      .forUpdate()
      .executeTakeFirst();
    if (
      release?.processingState !== 'validated' ||
      !release.evidenceObjectKey ||
      !release.evidenceDigest ||
      !release.sourceCompatibility ||
      !validRange(release.sourceCompatibility) ||
      !valid(release.version) ||
      release.vendorTrustState !== 'trusted' ||
      release.productStatus !== 'active'
    ) {
      throw new VendorIntelligenceControlError('VENDOR_RELEASE_NOT_ANALYSABLE');
    }

    const evidenceSources = await transaction
      .selectFrom('vendorEvidenceItems as item')
      .innerJoin('vendorSources as source', 'source.id', 'item.vendorSourceId')
      .select('item.vendorSourceId')
      .where('item.vendorReleaseId', '=', release.id)
      .where('source.apiProductId', '=', release.apiProductId)
      .where('source.trustState', '=', 'trusted')
      .orderBy('item.vendorSourceId', 'asc')
      .limit(50)
      .execute();
    if (evidenceSources.length === 0) {
      throw new VendorIntelligenceControlError('VENDOR_RELEASE_EVIDENCE_INVALID');
    }
    const context: TrustedChangeIntelligenceContext = {
      apiProductId: release.apiProductId,
      vendorSlug: release.vendorSlug,
      vendorName: release.vendorName,
      ecosystem: release.ecosystem,
      packageIdentifier: release.canonicalIdentifier,
      sourceCompatibility: release.sourceCompatibility,
      targetVersion: release.version,
      allowedEvidenceSourceIds: evidenceSources.map(source => source.vendorSourceId),
      specificationSchemaVersion: '1.0',
      policyVersion: 'stage-8e-v1',
      requestedModel: dependency.config.OPENAI_MODEL,
      budget: {
        maximumModelCalls: dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_MODEL_CALLS,
        maximumToolCalls: dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_TOOL_CALLS,
        maximumIterations: dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_ITERATIONS,
        maximumInputTokens: dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_INPUT_TOKENS,
        maximumOutputTokens:
          dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_OUTPUT_TOKENS,
        maximumWallClockMilliseconds:
          dependency.config.CHANGE_INTELLIGENCE_MAXIMUM_WALL_CLOCK_MILLISECONDS,
      },
    };

    const existing = await transaction
      .selectFrom('changeIntelligenceRuns')
      .select([
        'id',
        'status',
        'attempt',
        'updatedAt',
        'resultObjectKey',
        'migrationSpecificationId',
      ])
      .where('vendorReleaseId', '=', release.id)
      .where('evidenceDigest', '=', release.evidenceDigest)
      .forUpdate()
      .executeTakeFirst();
    if (existing?.status === 'succeeded') {
      if (!existing.migrationSpecificationId) {
        throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_STATE_INVALID');
      }
      const specification = await transaction
        .selectFrom('migrationSpecifications')
        .select('revision')
        .where('id', '=', existing.migrationSpecificationId)
        .executeTakeFirstOrThrow();
      return prepared(
        workflow,
        context,
        existing.id,
        release.evidenceObjectKey,
        release.evidenceDigest,
        specification.revision,
        existing.resultObjectKey,
        true,
      );
    }
    if (
      existing?.status === 'running' &&
      now.getTime() - existing.updatedAt.getTime() < STALE_RUN_MILLISECONDS
    ) {
      throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_IN_PROGRESS');
    }
    if (existing && existing.attempt >= 10) {
      throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_RETRY_EXHAUSTED');
    }

    const latestSpecification = await transaction
      .selectFrom('migrationSpecifications')
      .select('revision')
      .where('vendorReleaseId', '=', release.id)
      .where('sourceCompatibility', '=', release.sourceCompatibility)
      .where('targetVersion', '=', release.version)
      .orderBy('revision', 'desc')
      .executeTakeFirst();
    const specificationRevision = (latestSpecification?.revision ?? 0) + 1;

    if (existing) {
      await transaction
        .updateTable('changeIntelligenceRuns')
        .set(expression => ({
          status: 'running',
          attempt: expression('attempt', '+', 1),
          safeErrorCode: null,
          correlationId: workflow.correlationId,
          requestedModel: dependency.config.OPENAI_MODEL,
          returnedModel: null,
          openaiRequestId: null,
          modelCalls: 0,
          toolCalls: 0,
          iterations: 0,
          inputTokens: 0,
          outputTokens: 0,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }))
        .where('id', '=', existing.id)
        .executeTakeFirstOrThrow();
      return prepared(
        workflow,
        context,
        existing.id,
        release.evidenceObjectKey,
        release.evidenceDigest,
        specificationRevision,
        existing.resultObjectKey,
        false,
      );
    }

    const runId = dependency.id();
    const resultObjectKey = [
      `env/${dependency.config.APP_ENVIRONMENT}/change-intelligence`,
      `release/${release.id}`,
      `run/${runId}/result.json`,
    ].join('/');
    await transaction
      .insertInto('changeIntelligenceRuns')
      .values({
        id: runId,
        vendorReleaseId: release.id,
        evidenceDigest: release.evidenceDigest,
        status: 'running',
        attempt: 1,
        safeErrorCode: null,
        correlationId: workflow.correlationId,
        resultObjectKey,
        migrationSpecificationId: null,
        requestedModel: dependency.config.OPENAI_MODEL,
        returnedModel: null,
        openaiRequestId: null,
        modelCalls: 0,
        toolCalls: 0,
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      })
      .executeTakeFirstOrThrow();
    return prepared(
      workflow,
      context,
      runId,
      release.evidenceObjectKey,
      release.evidenceDigest,
      specificationRevision,
      resultObjectKey,
      false,
    );
  });
}

function prepared(
  workflow: ChangeIntelligenceWorkflowInput,
  context: TrustedChangeIntelligenceContext,
  runId: string,
  evidenceObjectKey: string,
  evidenceDigest: string,
  specificationRevision: number,
  resultObjectKey: string,
  alreadySucceeded: boolean,
): ChangeIntelligencePreparedInput {
  return changeIntelligencePreparedInputSchema.parse({
    ...workflow,
    ...context,
    changeIntelligenceRunId: runId,
    evidenceObjectKey,
    evidenceDigest,
    specificationRevision,
    resultObjectKey,
    alreadySucceeded,
  });
}

async function readResult(
  dependency: VendorIntelligenceControlDependencies,
  workflow: ChangeIntelligencePreparedInput,
): Promise<ChangeIntelligenceResult> {
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: workflow.resultObjectKey,
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > MAXIMUM_RESULT_BYTES
  ) {
    throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_RESULT_SIZE_INVALID');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_RESULT_READ_FAILED');
  }
  let result: ChangeIntelligenceResult;
  try {
    result = changeIntelligenceResultSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
  } catch {
    throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_RESULT_INVALID');
  }
  if (
    result.vendorReleaseId !== workflow.vendorReleaseId ||
    result.changeIntelligenceRunId !== workflow.changeIntelligenceRunId ||
    result.evidenceObjectKey !== workflow.evidenceObjectKey ||
    result.evidenceDigest !== workflow.evidenceDigest ||
    result.model.requestedModel !== workflow.requestedModel ||
    result.usage.modelCalls > workflow.budget.maximumModelCalls ||
    result.usage.toolCalls > workflow.budget.maximumToolCalls ||
    result.usage.iterations > workflow.budget.maximumIterations ||
    result.usage.inputTokens > workflow.budget.maximumInputTokens ||
    result.usage.outputTokens > workflow.budget.maximumOutputTokens ||
    result.usage.durationMs > workflow.budget.maximumWallClockMilliseconds
  ) {
    throw new VendorIntelligenceControlError(
      'CHANGE_INTELLIGENCE_RESULT_OWNERSHIP_INVALID',
    );
  }
  return result;
}

async function finalizeRun(
  dependency: VendorIntelligenceControlDependencies,
  workflow: ChangeIntelligencePreparedInput,
  result: ChangeIntelligenceResult,
): Promise<'succeeded' | 'failed'> {
  const now = dependency.now();
  return dependency.database.transaction().execute(async transaction => {
    const run = await transaction
      .selectFrom('changeIntelligenceRuns')
      .select(['status', 'migrationSpecificationId'])
      .where('id', '=', workflow.changeIntelligenceRunId)
      .where('vendorReleaseId', '=', workflow.vendorReleaseId)
      .where('evidenceDigest', '=', workflow.evidenceDigest)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status !== 'running') {
      throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_STATE_INVALID');
    }
    if (result.status === 'failed' || !result.specification) {
      await updateTerminalRun(
        transaction,
        workflow.changeIntelligenceRunId,
        result,
        null,
        result.safeErrorCode ?? 'CHANGE_INTELLIGENCE_AGENT_FAILED',
        now,
      );
      return 'failed';
    }

    await verifySpecificationEvidence(transaction, workflow, result.specification);
    const specificationId = dependency.id();
    await sql`
      select create_change_intelligence_draft(
        ${specificationId}::uuid,
        ${workflow.vendorReleaseId}::uuid,
        ${result.specification.sourceCompatibility},
        ${result.specification.targetVersion},
        ${JSON.stringify(result.specification)}::jsonb,
        ${workflow.evidenceObjectKey},
        ${workflow.evidenceDigest},
        ${workflow.specificationRevision},
        ${now}::timestamptz
      )
    `.execute(transaction);
    await updateTerminalRun(
      transaction,
      workflow.changeIntelligenceRunId,
      result,
      specificationId,
      null,
      now,
    );
    return 'succeeded';
  });
}

async function verifySpecificationEvidence(
  database: AppDatabase,
  workflow: ChangeIntelligencePreparedInput,
  specification: MigrationSpecification,
): Promise<void> {
  const trusted = await database
    .selectFrom('vendorReleases as release')
    .innerJoin('apiProducts as product', 'product.id', 'release.apiProductId')
    .innerJoin('vendors as vendor', 'vendor.id', 'product.vendorId')
    .select([
      'release.version',
      'release.sourceCompatibility',
      'product.id as apiProductId',
      'product.ecosystem',
      'product.canonicalIdentifier',
      'product.status as productStatus',
      'vendor.slug as vendorSlug',
      'vendor.name as vendorName',
      'vendor.trustState as vendorTrustState',
    ])
    .where('release.id', '=', workflow.vendorReleaseId)
    .executeTakeFirst();
  if (
    trusted?.apiProductId !== workflow.apiProductId ||
    trusted.vendorSlug !== workflow.vendorSlug ||
    trusted.vendorName !== workflow.vendorName ||
    trusted.canonicalIdentifier !== workflow.packageIdentifier ||
    trusted.sourceCompatibility !== workflow.sourceCompatibility ||
    trusted.version !== workflow.targetVersion ||
    trusted.productStatus !== 'active' ||
    trusted.vendorTrustState !== 'trusted'
  ) {
    throw new VendorIntelligenceControlError('MIGRATION_SPECIFICATION_CONTEXT_INVALID');
  }
  if (
    specification.vendor.slug !== workflow.vendorSlug ||
    specification.vendor.name !== workflow.vendorName ||
    specification.product.identifier !== workflow.packageIdentifier ||
    specification.sourceCompatibility !== workflow.sourceCompatibility ||
    specification.targetVersion !== workflow.targetVersion ||
    specification.revision !== workflow.specificationRevision ||
    specification.trust.status !== 'draft' ||
    specification.trust.generatedBy !== 'change_intelligence_agent' ||
    specification.trust.reviewedAt !== null
  ) {
    throw new VendorIntelligenceControlError('MIGRATION_SPECIFICATION_TRUST_INVALID');
  }
  const evidence = await database
    .selectFrom('vendorEvidenceItems as item')
    .innerJoin('vendorSources as source', 'source.id', 'item.vendorSourceId')
    .select([
      'source.id as sourceId',
      'source.sourceKey',
      'item.canonicalUrl',
      'item.digest',
    ])
    .where('item.vendorReleaseId', '=', workflow.vendorReleaseId)
    .where('source.apiProductId', '=', workflow.apiProductId)
    .where('source.trustState', '=', 'trusted')
    .where('source.id', 'in', workflow.allowedEvidenceSourceIds)
    .execute();
  if (evidence.length !== workflow.allowedEvidenceSourceIds.length) {
    throw new VendorIntelligenceControlError(
      'MIGRATION_SPECIFICATION_EVIDENCE_INVALID',
    );
  }
  const registered = new Map(evidence.map(item => [item.sourceKey, item] as const));
  if (!evidenceReferencesMatch(specification.evidence, registered)) {
    throw new VendorIntelligenceControlError(
      'MIGRATION_SPECIFICATION_EVIDENCE_INVALID',
    );
  }
}

export function evidenceReferencesMatch(
  references: MigrationSpecification['evidence'],
  registered: ReadonlyMap<
    string,
    { readonly canonicalUrl: string; readonly digest: string }
  >,
): boolean {
  return references.every(reference => {
    const source = registered.get(reference.sourceKey);
    return (
      source?.canonicalUrl === reference.sourceUrl && source.digest === reference.digest
    );
  });
}

async function updateTerminalRun(
  database: AppDatabase,
  runId: string,
  result: ChangeIntelligenceResult,
  specificationId: string | null,
  safeErrorCode: string | null,
  now: Date,
): Promise<void> {
  const update = await database
    .updateTable('changeIntelligenceRuns')
    .set({
      status: specificationId ? 'succeeded' : 'failed',
      safeErrorCode,
      migrationSpecificationId: specificationId,
      returnedModel: result.model.returnedModel,
      openaiRequestId: result.model.requestId,
      modelCalls: result.usage.modelCalls,
      toolCalls: result.usage.toolCalls,
      iterations: result.usage.iterations,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      completedAt: now,
      updatedAt: now,
    })
    .where('id', '=', runId)
    .where('status', '=', 'running')
    .executeTakeFirstOrThrow();
  if (update.numUpdatedRows !== 1n) {
    throw new VendorIntelligenceControlError('CHANGE_INTELLIGENCE_STATE_INVALID');
  }
}

async function markRunFailed(
  database: AppDatabase,
  workflow: ChangeIntelligencePreparedInput,
  safeErrorCode: string,
  now: Date,
): Promise<void> {
  await database
    .updateTable('changeIntelligenceRuns')
    .set({
      status: 'failed',
      safeErrorCode,
      migrationSpecificationId: null,
      completedAt: now,
      updatedAt: now,
    })
    .where('id', '=', workflow.changeIntelligenceRunId)
    .where('vendorReleaseId', '=', workflow.vendorReleaseId)
    .where('status', '=', 'running')
    .executeTakeFirst();
}

export class VendorIntelligenceControlError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The change-intelligence operation could not be completed.');
    this.name = 'VendorIntelligenceControlError';
  }
}
