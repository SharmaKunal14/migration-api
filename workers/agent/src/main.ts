import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import OpenAI from 'openai';
import { z } from 'zod';

import { AgentKernel } from '@migration/agent-kernel';
import { AgentTools, ToolPolicyError } from '@migration/agent-tools';
import {
  agentResultEnvelopeSchema,
  type AgentResultEnvelope,
} from '@migration/contracts';
import { agentConfigSchema, parseConfig } from '@migration/config';
import { ModelGateway } from '@migration/model-gateway';
import { safeErrorCode, writeLog } from '@migration/observability';

async function main(): Promise<void> {
  const config = parseConfig(agentConfigSchema);
  const s3 = new S3Client({ region: config.AWS_REGION });
  const resultKey = `env/${config.APP_ENVIRONMENT}/org/${config.ORGANISATION_ID}/run/${config.AGENT_RUN_ID}/result/final.json`;
  let result: AgentResultEnvelope;
  try {
    const gateway = new ModelGateway({
      awsRegion: config.AWS_REGION,
      identityProviderId: config.OPENAI_IDENTITY_PROVIDER_ID,
      serviceAccountId: config.OPENAI_SERVICE_ACCOUNT_ID,
      audience: config.OPENAI_WIF_AUDIENCE,
      model: config.OPENAI_MODEL,
      organisationId: config.ORGANISATION_ID,
    });
    const evidenceKey = `env/${config.APP_ENVIRONMENT}/synthetic/orbitchat/stage-1-evidence.json`;
    const tools = new AgentTools(s3, config.ARTIFACT_BUCKET, evidenceKey);
    result = await new AgentKernel(gateway, tools).run({
      organisationId: config.ORGANISATION_ID,
      agentRunId: config.AGENT_RUN_ID,
      requestedModel: config.OPENAI_MODEL,
    });
  } catch (error) {
    result = classifiedFailure(
      config.ORGANISATION_ID,
      config.AGENT_RUN_ID,
      config.OPENAI_MODEL,
      classifyFailure(error),
    );
  }
  const validated = agentResultEnvelopeSchema.parse(result);
  const body = JSON.stringify(validated);
  if (Buffer.byteLength(body, 'utf8') > 1024 * 1024) {
    throw new Error('The result artifact exceeds the configured size limit.');
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: config.ARTIFACT_BUCKET,
      Key: resultKey,
      Body: body,
      ContentType: 'application/json',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: config.ARTIFACT_KMS_KEY_ARN,
      Metadata: {
        'schema-version': '1.0',
        'agent-run-id': config.AGENT_RUN_ID,
      },
    }),
  );
  writeLog(result.terminal.code === 'completed' ? 'info' : 'warn', {
    event: 'agent_result_written',
    organisationId: config.ORGANISATION_ID,
    agentRunId: config.AGENT_RUN_ID,
    outcome: result.terminal.code,
    safeErrorCode: result.terminal.safeErrorCode ?? undefined,
    durationMs: result.usage.durationMs,
  });
}

function classifiedFailure(
  organisationId: string,
  agentRunId: string,
  requestedModel: string,
  failure: AgentFailure,
): AgentResultEnvelope {
  return {
    schemaVersion: '1.0',
    organisationId,
    agentRunId,
    model: {
      provider: 'openai',
      requestedModel,
      returnedModel: requestedModel,
      reasoningEffort: 'medium',
      requestId: null,
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    },
    actions: [],
    terminal: {
      code: failure.terminalCode,
      safeErrorCode: failure.safeErrorCode,
    },
    result: null,
  };
}

interface AgentFailure {
  readonly terminalCode:
    | 'invalid_model_output'
    | 'policy_rejected'
    | 'upstream_transient'
    | 'upstream_permanent'
    | 'infrastructure_failed';
  readonly safeErrorCode: string;
}

function classifyFailure(error: unknown): AgentFailure {
  if (error instanceof ToolPolicyError) {
    return { terminalCode: 'policy_rejected', safeErrorCode: error.safeCode };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      terminalCode: 'invalid_model_output',
      safeErrorCode: 'INVALID_EXTERNAL_PAYLOAD',
    };
  }
  if (
    error instanceof OpenAI.RateLimitError ||
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIConnectionError
  ) {
    return {
      terminalCode: 'upstream_transient',
      safeErrorCode: 'MODEL_UPSTREAM_TRANSIENT',
    };
  }
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError
  ) {
    return {
      terminalCode: 'upstream_permanent',
      safeErrorCode: 'MODEL_AUTHENTICATION_FAILED',
    };
  }
  return {
    terminalCode: 'infrastructure_failed',
    safeErrorCode: safeErrorCode(error),
  };
}

await main();
