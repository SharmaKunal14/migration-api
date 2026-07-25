import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { AgentKernel } from '@migration/agent-kernel';
import { AgentTools } from '@migration/agent-tools';
import {
  agentResultEnvelopeSchema,
  type AgentResultEnvelope,
} from '@migration/contracts';
import { agentConfigSchema, parseConfig } from '@migration/config';
import { ModelGateway } from '@migration/model-gateway';
import { writeLog } from '@migration/observability';

import {
  classifyAgentFailure,
  createClassifiedFailure,
  type FailureDiagnostics,
} from './failure.js';

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = parseConfig(agentConfigSchema);
  const s3 = new S3Client({ region: config.AWS_REGION });
  const resultKey = `env/${config.APP_ENVIRONMENT}/org/${config.ORGANISATION_ID}/run/${config.AGENT_RUN_ID}/result/final.json`;
  let result: AgentResultEnvelope;
  let failureDiagnostics: FailureDiagnostics | undefined;
  try {
    const gateway = new ModelGateway({
      awsRegion: config.AWS_REGION,
      identityProviderId: config.OPENAI_IDENTITY_PROVIDER_ID,
      serviceAccountId: config.OPENAI_SERVICE_ACCOUNT_ID,
      audience: config.OPENAI_WIF_AUDIENCE,
      model: config.OPENAI_MODEL,
      organisationId: config.ORGANISATION_ID,
      agentRunId: config.AGENT_RUN_ID,
    });
    const evidenceKey = `env/${config.APP_ENVIRONMENT}/synthetic/orbitchat/stage-1-evidence.json`;
    const tools = new AgentTools(s3, config.ARTIFACT_BUCKET, evidenceKey);
    result = await new AgentKernel(gateway, tools).run({
      organisationId: config.ORGANISATION_ID,
      agentRunId: config.AGENT_RUN_ID,
      requestedModel: config.OPENAI_MODEL,
    });
  } catch (error) {
    const failure = classifyAgentFailure(error);
    failureDiagnostics = failure.diagnostics;
    result = createClassifiedFailure(
      config.ORGANISATION_ID,
      config.AGENT_RUN_ID,
      config.OPENAI_MODEL,
      Date.now() - startedAt,
      failure,
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
    ...failureDiagnostics,
  });
}

await main();
