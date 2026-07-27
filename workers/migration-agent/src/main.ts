import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';

import {
  migrationAgentInputArtifactSchema,
  migrationAgentResultSchema,
  type MigrationAgentInputArtifact,
  type MigrationAgentResult,
} from '@migration/contracts';
import { migrationAgentConfigSchema, parseConfig } from '@migration/config';
import { writeLog } from '@migration/observability';
import { buildAndValidatePatch } from '@migration/patch-policy';

import { classifyAgentFailure } from '../../agent/src/failure.js';
import { MigrationAgentGateway } from './gateway.js';
import {
  migrationAgentBudgets,
  MigrationAgentKernel,
  MigrationAgentRuntimeError,
} from './kernel.js';
import { RepositoryTools } from '../../impact-analysis-agent/src/tools.js';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = parseConfig(migrationAgentConfigSchema);
  const prefix = `env/${config.APP_ENVIRONMENT}/org/${config.ORGANISATION_ID}/run/${config.MIGRATION_RUN_ID}/agent`;
  if (
    config.INPUT_OBJECT_KEY !== `${prefix}/context.json` ||
    config.RESULT_OBJECT_KEY !== `${prefix}/result.json`
  ) {
    throw new Error('The configured migration-agent object key is invalid.');
  }
  const s3 = new S3Client({ region: config.AWS_REGION });
  const existing = await readExistingResult(
    s3,
    config.ARTIFACT_BUCKET,
    config.RESULT_OBJECT_KEY,
  );
  if (existing) {
    if (
      existing.organisationId !== config.ORGANISATION_ID ||
      existing.migrationRunId !== config.MIGRATION_RUN_ID ||
      existing.repositoryId !== config.REPOSITORY_ID ||
      existing.inputDigest !== config.INPUT_DIGEST
    ) {
      throw new Error('The existing migration-agent result has invalid ownership.');
    }
    writeLog('info', {
      event: 'migration_agent_result_reused',
      requestId: config.MIGRATION_RUN_ID,
      outcome: existing.status,
    });
    return;
  }
  const inputBytes = await readBoundedObject(
    s3,
    config.ARTIFACT_BUCKET,
    config.INPUT_OBJECT_KEY,
    MAX_INPUT_BYTES,
  );
  if (digest(inputBytes) !== config.INPUT_DIGEST) {
    throw new Error('The migration-agent input digest does not match.');
  }
  const input = migrationAgentInputArtifactSchema.parse(
    JSON.parse(inputBytes.toString('utf8')),
  );
  if (
    input.organisationId !== config.ORGANISATION_ID ||
    input.repositoryId !== config.REPOSITORY_ID ||
    input.binding.migrationRunId !== config.MIGRATION_RUN_ID
  ) {
    throw new Error('The migration-agent input has invalid ownership.');
  }

  let result: MigrationAgentResult;
  try {
    const tools = new RepositoryTools(
      s3,
      config.ARTIFACT_BUCKET,
      input.snapshot.objectKey,
      input.snapshot.digest,
    );
    await tools.initialize();
    const gateway = new MigrationAgentGateway({
      awsRegion: config.AWS_REGION,
      identityProviderId: config.OPENAI_IDENTITY_PROVIDER_ID,
      serviceAccountId: config.OPENAI_SERVICE_ACCOUNT_ID,
      audience: config.OPENAI_WIF_AUDIENCE,
      model: config.OPENAI_MODEL,
      input,
    });
    const allowedPaths = new Set(input.authority.patchPolicy.allowedPaths);
    const preloadReadPaths = [
      ...new Set(
        input.impact.affectedFiles
          .map(file => file.path)
          .filter(path => allowedPaths.has(path)),
      ),
    ].sort();
    const proposal = await new MigrationAgentKernel(
      gateway,
      tools,
      preloadReadPaths,
    ).run();
    const patch = buildAndValidatePatch({
      migration: input,
      plan: proposal.plan,
      edits: proposal.edits,
      readFile: path => tools.readTextFile(path),
    });
    const planDigest = digestJson(proposal.plan);
    const remainingBudget = {
      modelCalls: Math.max(
        0,
        migrationAgentBudgets.maximumModelCalls - proposal.usage.modelCalls,
      ),
      toolCalls: Math.max(
        0,
        migrationAgentBudgets.maximumToolCalls - proposal.usage.toolCalls,
      ),
      iterations: Math.max(
        0,
        migrationAgentBudgets.maximumIterations - proposal.usage.iterations,
      ),
    };
    const lastActionSequence = proposal.actions.at(-1)?.sequence ?? 0;
    const checkpoints: MigrationAgentResult['checkpoints'] = [
      {
        schemaVersion: '1.0',
        binding: input.binding,
        attemptNumber: input.attemptNumber,
        sequence: 1,
        phase: 'context',
        lastActionSequence: 0,
        remainingBudget: {
          modelCalls: migrationAgentBudgets.maximumModelCalls,
          toolCalls: migrationAgentBudgets.maximumToolCalls,
          iterations: migrationAgentBudgets.maximumIterations,
        },
        planDigest: null,
        patchDigest: null,
      },
      {
        schemaVersion: '1.0',
        binding: input.binding,
        attemptNumber: input.attemptNumber,
        sequence: 2,
        phase: 'planning',
        lastActionSequence,
        remainingBudget,
        planDigest,
        patchDigest: null,
      },
      {
        schemaVersion: '1.0',
        binding: input.binding,
        attemptNumber: input.attemptNumber,
        sequence: 3,
        phase: 'patching',
        lastActionSequence,
        remainingBudget,
        planDigest,
        patchDigest: patch.manifest.patchDigest,
      },
    ];
    result = {
      schemaVersion: '1.0',
      organisationId: input.organisationId,
      repositoryId: input.repositoryId,
      migrationRunId: input.binding.migrationRunId,
      attemptNumber: input.attemptNumber,
      inputDigest: config.INPUT_DIGEST,
      status: patch.validation.status === 'accepted' ? 'succeeded' : 'rejected',
      safeErrorCode: patch.validation.safeErrorCode,
      model: proposal.model,
      usage: proposal.usage,
      actions: proposal.actions,
      plan: proposal.plan,
      patch: patch.patch,
      manifest: patch.manifest,
      validation: patch.validation,
      checkpoints,
    };
  } catch (error) {
    const classified = classifyAgentFailure(error);
    const safeErrorCode =
      error instanceof MigrationAgentRuntimeError
        ? error.safeCode
        : classified.safeErrorCode;
    result = failedResult(
      input,
      config.INPUT_DIGEST,
      config.OPENAI_MODEL,
      Date.now() - startedAt,
      safeErrorCode,
    );
  }
  const validated = migrationAgentResultSchema.parse(result);
  const body = Buffer.from(JSON.stringify(validated), 'utf8');
  if (body.byteLength > MAX_RESULT_BYTES) {
    throw new Error('The migration-agent result exceeds the configured size limit.');
  }
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: config.ARTIFACT_BUCKET,
        Key: config.RESULT_OBJECT_KEY,
        Body: body,
        ContentType: 'application/json',
        ServerSideEncryption: 'aws:kms',
        SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
        IfNoneMatch: '*',
        Metadata: {
          'schema-version': '1.0',
          'migration-run-id': config.MIGRATION_RUN_ID,
          'input-digest': config.INPUT_DIGEST,
        },
      }),
    );
  } catch (error) {
    if (!(
      error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412
    )) {
      throw error;
    }
    const concurrentlyWritten = await readExistingResult(
      s3,
      config.ARTIFACT_BUCKET,
      config.RESULT_OBJECT_KEY,
    );
    if (
      concurrentlyWritten === null ||
      digestJson(concurrentlyWritten) !== digestJson(validated)
    ) {
      throw new Error('An immutable migration-agent result cannot be replaced.', {
        cause: error,
      });
    }
  }
  writeLog(validated.status === 'succeeded' ? 'info' : 'warn', {
    event: 'migration_agent_result_written',
    requestId: config.MIGRATION_RUN_ID,
    outcome: validated.status,
    safeErrorCode: validated.safeErrorCode ?? undefined,
    durationMs: validated.usage.durationMs,
  });
}

async function readExistingResult(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<MigrationAgentResult | null> {
  try {
    const bytes = await readBoundedObject(s3, bucket, key, MAX_RESULT_BYTES);
    return migrationAgentResultSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (
      error instanceof S3ServiceException &&
      (error.name === 'NoSuchKey' ||
        error.$metadata.httpStatusCode === 404 ||
        (error.name === 'AccessDenied' && error.$metadata.httpStatusCode === 403))
    ) {
      // The task role intentionally has no ListBucket permission. S3 therefore
      // returns 403, rather than 404, when this optional result key is absent.
      // The conditional PutObject below remains the immutable write boundary.
      return null;
    }
    throw error;
  }
}

async function readBoundedObject(
  s3: S3Client,
  bucket: string,
  key: string,
  maximumBytes: number,
): Promise<Buffer> {
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > maximumBytes
  ) {
    throw new Error('The migration-agent artifact size is invalid.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new Error('The migration-agent artifact could not be read completely.');
  }
  return Buffer.from(bytes);
}

function failedResult(
  input: MigrationAgentInputArtifact,
  inputDigest: string,
  model: string,
  durationMs: number,
  safeErrorCode: string,
): MigrationAgentResult {
  return {
    schemaVersion: '1.0',
    organisationId: input.organisationId,
    repositoryId: input.repositoryId,
    migrationRunId: input.binding.migrationRunId,
    attemptNumber: input.attemptNumber,
    inputDigest,
    status: 'failed',
    safeErrorCode,
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
    plan: null,
    patch: null,
    manifest: null,
    validation: null,
    checkpoints: [],
  };
}

function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestJson(value: unknown): string {
  return digest(Buffer.from(JSON.stringify(value), 'utf8'));
}

if (process.env.NODE_ENV !== 'test') {
  await main();
}
