import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  changeIntelligenceResultSchema,
  type ChangeIntelligenceResult,
} from '@migration/contracts';
import { changeIntelligenceAgentConfigSchema, parseConfig } from '@migration/config';
import { writeLog } from '@migration/observability';

import {
  classifyChangeIntelligenceFailure,
  type FailureClassification,
} from './failure.js';
import { ChangeIntelligenceGateway } from './gateway.js';
import { ChangeIntelligenceKernel } from './kernel.js';
import { ChangeIntelligenceTools } from './tools.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = parseConfig(changeIntelligenceAgentConfigSchema);
  const expectedResultObjectKey = [
    `env/${config.APP_ENVIRONMENT}/change-intelligence`,
    `release/${config.VENDOR_RELEASE_ID}`,
    `run/${config.CHANGE_INTELLIGENCE_RUN_ID}/result.json`,
  ].join('/');
  if (
    config.RESULT_OBJECT_KEY !== expectedResultObjectKey ||
    !config.EVIDENCE_OBJECT_KEY.startsWith(`env/${config.APP_ENVIRONMENT}/vendor/`)
  ) {
    throw new Error('The configured artifact object key is invalid.');
  }

  const s3 = new S3Client({ region: config.AWS_REGION });
  let result: ChangeIntelligenceResult;
  let failure: FailureClassification | undefined;
  try {
    const tools = new ChangeIntelligenceTools(
      s3,
      config.ARTIFACT_BUCKET,
      config.VENDOR_RELEASE_ID,
      config.API_PRODUCT_ID,
      config.TARGET_VERSION,
      new Set(config.ALLOWED_EVIDENCE_SOURCE_IDS),
      config.EVIDENCE_OBJECT_KEY,
      config.EVIDENCE_DIGEST,
    );
    await tools.initialize();
    const gateway = new ChangeIntelligenceGateway({
      awsRegion: config.AWS_REGION,
      identityProviderId: config.OPENAI_IDENTITY_PROVIDER_ID,
      serviceAccountId: config.OPENAI_SERVICE_ACCOUNT_ID,
      audience: config.OPENAI_WIF_AUDIENCE,
      model: config.OPENAI_MODEL,
      vendorReleaseId: config.VENDOR_RELEASE_ID,
      runId: config.CHANGE_INTELLIGENCE_RUN_ID,
      specificationRevision: config.SPECIFICATION_REVISION,
      specificationSchemaVersion: config.SPECIFICATION_SCHEMA_VERSION,
      policyVersion: config.CHANGE_INTELLIGENCE_POLICY_VERSION,
      vendorSlug: config.VENDOR_SLUG,
      vendorName: config.VENDOR_NAME,
      ecosystem: config.ECOSYSTEM,
      packageIdentifier: config.PACKAGE_IDENTIFIER,
      sourceCompatibility: config.SOURCE_COMPATIBILITY,
      targetVersion: config.TARGET_VERSION,
    });
    result = await new ChangeIntelligenceKernel(gateway, tools).run({
      vendorReleaseId: config.VENDOR_RELEASE_ID,
      changeIntelligenceRunId: config.CHANGE_INTELLIGENCE_RUN_ID,
      evidenceObjectKey: config.EVIDENCE_OBJECT_KEY,
      evidenceDigest: config.EVIDENCE_DIGEST,
      requestedModel: config.OPENAI_MODEL,
      budget: {
        maximumModelCalls: config.MAXIMUM_MODEL_CALLS,
        maximumToolCalls: config.MAXIMUM_TOOL_CALLS,
        maximumIterations: config.MAXIMUM_ITERATIONS,
        maximumInputTokens: config.MAXIMUM_INPUT_TOKENS,
        maximumOutputTokens: config.MAXIMUM_OUTPUT_TOKENS,
        maximumWallClockMilliseconds: config.MAXIMUM_WALL_CLOCK_MILLISECONDS,
      },
    });
  } catch (error) {
    failure = classifyChangeIntelligenceFailure(error);
    result = failedResult(
      config.VENDOR_RELEASE_ID,
      config.CHANGE_INTELLIGENCE_RUN_ID,
      config.EVIDENCE_OBJECT_KEY,
      config.EVIDENCE_DIGEST,
      config.OPENAI_MODEL,
      Date.now() - startedAt,
      failure.safeErrorCode,
    );
  }

  const validated = changeIntelligenceResultSchema.parse(result);
  const body = JSON.stringify(validated);
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
    throw new Error('The result artifact exceeds the configured size limit.');
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: config.ARTIFACT_BUCKET,
      Key: config.RESULT_OBJECT_KEY,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': config.SPECIFICATION_SCHEMA_VERSION,
        'policy-version': config.CHANGE_INTELLIGENCE_POLICY_VERSION,
        'api-product-id': config.API_PRODUCT_ID,
        'vendor-release-id': config.VENDOR_RELEASE_ID,
        'change-intelligence-run-id': config.CHANGE_INTELLIGENCE_RUN_ID,
      },
    }),
  );
  writeLog(validated.status === 'succeeded' ? 'info' : 'warn', {
    event: 'change_intelligence_result_written',
    requestId: config.CHANGE_INTELLIGENCE_RUN_ID,
    agentRunId: config.CHANGE_INTELLIGENCE_RUN_ID,
    outcome: validated.status,
    safeErrorCode: validated.safeErrorCode ?? undefined,
    durationMs: validated.usage.durationMs,
    ...(failure ?? {}),
  });
}

function failedResult(
  vendorReleaseId: string,
  changeIntelligenceRunId: string,
  evidenceObjectKey: string,
  evidenceDigest: string,
  requestedModel: string,
  durationMs: number,
  safeErrorCode: string,
): ChangeIntelligenceResult {
  return {
    schemaVersion: '1.0',
    vendorReleaseId,
    changeIntelligenceRunId,
    evidenceObjectKey,
    evidenceDigest,
    status: 'failed',
    safeErrorCode,
    model: {
      requestedModel,
      returnedModel: requestedModel,
      requestId: null,
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Math.min(durationMs, 10 * 60 * 1_000),
    },
    actions: [],
    specification: null,
  };
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
