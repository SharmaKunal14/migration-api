import { describe, expect, it } from 'vitest';

import { agentConfigSchema, parseConfig } from '@migration/config';

const validEnvironment = {
  APP_ENVIRONMENT: 'development',
  AWS_REGION: 'ap-southeast-2',
  AGENT_RUN_ID: 'e4e2d9db-bd1c-4eef-b685-231128724583',
  ARTIFACT_BUCKET: 'migration-api-artifacts',
  ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
  OPENAI_IDENTITY_PROVIDER_ID: 'wip_example',
  OPENAI_MODEL: 'gpt-5.6-sol',
  OPENAI_PROJECT_ALIAS: 'development-agent',
  OPENAI_SERVICE_ACCOUNT_ID: 'svc_example',
  OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
  ORGANISATION_ID: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
};

describe('startup configuration', () => {
  it('parses a complete agent configuration', () => {
    expect(parseConfig(agentConfigSchema, validEnvironment)).toMatchObject({
      APP_ENVIRONMENT: 'development',
      OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
    });
  });

  it('fails closed for a wrong WIF audience', () => {
    expect(() =>
      parseConfig(agentConfigSchema, {
        ...validEnvironment,
        OPENAI_WIF_AUDIENCE: 'https://attacker.invalid',
      }),
    ).toThrow('Invalid service configuration: OPENAI_WIF_AUDIENCE');
  });

  it('reports field names without echoing secret values', () => {
    const sensitiveValue = 'do-not-echo-this-value';
    expect(() =>
      parseConfig(agentConfigSchema, {
        ...validEnvironment,
        OPENAI_SERVICE_ACCOUNT_ID: '',
        EXTRA_SECRET: sensitiveValue,
      }),
    ).toThrow(expect.not.stringContaining(sensitiveValue));
  });
});
