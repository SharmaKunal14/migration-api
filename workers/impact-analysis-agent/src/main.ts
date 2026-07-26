import { createHash } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import {
  impactAnalysisInputArtifactSchema,
  impactAnalysisResultSchema,
  type ImpactAnalysisInputArtifact,
  type ImpactAnalysisResult,
} from '@migration/contracts';
import { impactAnalysisAgentConfigSchema, parseConfig } from '@migration/config';
import { writeLog } from '@migration/observability';

import { ImpactAnalysisGateway } from './gateway.js';
import { ImpactAnalysisKernel } from './kernel.js';
import { RepositoryTools } from './tools.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = parseConfig(impactAnalysisAgentConfigSchema);
  const prefix = `env/${config.APP_ENVIRONMENT}/impact-analysis/candidate/${config.CANDIDATE_ID}/run/${config.IMPACT_ANALYSIS_RUN_ID}`;
  if (
    config.INPUT_OBJECT_KEY !== `${prefix}/input.json` ||
    config.RESULT_OBJECT_KEY !== `${prefix}/result.json`
  ) {
    throw new Error('The configured impact-analysis object key is invalid.');
  }
  const s3 = new S3Client({ region: config.AWS_REGION });
  const input = await readInput(s3, config.ARTIFACT_BUCKET, config.INPUT_OBJECT_KEY);
  if (
    digest(Buffer.from(JSON.stringify(input))) !== config.INPUT_DIGEST ||
    input.candidateId !== config.CANDIDATE_ID ||
    input.impactAnalysisRunId !== config.IMPACT_ANALYSIS_RUN_ID
  ) {
    throw new Error('The impact-analysis input ownership is invalid.');
  }
  let result: ImpactAnalysisResult;
  try {
    const tools = new RepositoryTools(
      s3,
      config.ARTIFACT_BUCKET,
      input.snapshotObjectKey,
      input.snapshotDigest,
    );
    await tools.initialize();
    const gateway = new ImpactAnalysisGateway({
      awsRegion: config.AWS_REGION,
      identityProviderId: config.OPENAI_IDENTITY_PROVIDER_ID,
      serviceAccountId: config.OPENAI_SERVICE_ACCOUNT_ID,
      audience: config.OPENAI_WIF_AUDIENCE,
      model: config.OPENAI_MODEL,
      input,
    });
    result = await new ImpactAnalysisKernel(gateway, tools).run(input);
  } catch {
    result = failedResult(input, config.OPENAI_MODEL, Date.now() - startedAt);
  }
  const body = JSON.stringify(impactAnalysisResultSchema.parse(result));
  await s3.send(
    new PutObjectCommand({
      Bucket: config.ARTIFACT_BUCKET,
      Key: config.RESULT_OBJECT_KEY,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': '1.0',
        'candidate-id': input.candidateId,
        'impact-analysis-run-id': input.impactAnalysisRunId,
        'snapshot-digest': input.snapshotDigest,
      },
    }),
  );
  writeLog(result.status === 'succeeded' ? 'info' : 'warn', {
    event: 'impact_analysis_result_written',
    requestId: input.impactAnalysisRunId,
    outcome: result.status,
    safeErrorCode: result.safeErrorCode ?? undefined,
    durationMs: result.usage.durationMs,
  });
}

async function readInput(
  s3: S3Client,
  bucket: string,
  objectKey: string,
): Promise<ImpactAnalysisInputArtifact> {
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > 2 * 1024 * 1024
  ) {
    throw new Error('The impact-analysis input size is invalid.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new Error('The impact-analysis input could not be read.');
  }
  return impactAnalysisInputArtifactSchema.parse(
    JSON.parse(Buffer.from(bytes).toString('utf8')),
  );
}

function failedResult(
  input: ImpactAnalysisInputArtifact,
  model: string,
  durationMs: number,
): ImpactAnalysisResult {
  return {
    schemaVersion: '1.0',
    candidateId: input.candidateId,
    impactAnalysisRunId: input.impactAnalysisRunId,
    repositorySnapshotId: input.repositorySnapshotId,
    snapshotDigest: input.snapshotDigest,
    status: 'failed',
    safeErrorCode: 'IMPACT_ANALYSIS_AGENT_FAILED',
    model: { requestedModel: model, returnedModel: model, requestId: null },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Math.min(durationMs, 10 * 60 * 1_000),
    },
    actions: [],
    report: null,
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
