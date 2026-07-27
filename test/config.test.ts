import { describe, expect, it } from 'vitest';

import {
  agentConfigSchema,
  databaseCredentialSchema,
  dispatcherConfigSchema,
  githubAppSecretSchema,
  githubWebhookConfigSchema,
  githubWebhookSecretSchema,
  parseConfig,
  vendorFetcherConfigSchema,
} from '@migration/config';

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

const validDatabaseCredential = {
  host: 'aws-0-ap-southeast-2.pooler.supabase.com',
  port: 5432,
  database: 'postgres',
  username: 'app_migrator.project-ref',
  password: 'not-a-real-password',
  sslCaCertificate: [
    '-----BEGIN CERTIFICATE-----',
    'QUJDRA==',
    '-----END CERTIFICATE-----',
  ].join('\n'),
};

describe('startup configuration', () => {
  it('parses a complete agent configuration', () => {
    expect(parseConfig(agentConfigSchema, validEnvironment)).toMatchObject({
      APP_ENVIRONMENT: 'development',
      OPENAI_WIF_AUDIENCE: 'https://api.openai.com/v1',
    });
  });

  it('accepts identifier-only vendor fetcher configuration', () => {
    expect(
      parseConfig(vendorFetcherConfigSchema, {
        APP_ENVIRONMENT: 'development',
        AWS_REGION: 'ap-southeast-2',
        ARTIFACT_BUCKET: 'migration-api-artifacts',
        ARTIFACT_KMS_KEY_ARN: 'arn:aws:kms:ap-southeast-2:123456789012:key/example',
        CORRELATION_ID: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        DATABASE_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:runtime',
        VENDOR_RELEASE_ID: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
      }),
    ).toBeDefined();
  });

  it('requires exact workflow ARNs for every outbox event type', () => {
    expect(
      parseConfig(dispatcherConfigSchema, {
        APP_ENVIRONMENT: 'development',
        AWS_REGION: 'ap-southeast-2',
        DATABASE_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:runtime',
        MIGRATION_STATE_MACHINE_ARN:
          'arn:aws:states:ap-southeast-2:123456789012:stateMachine:migration',
        REPOSITORY_SCAN_STATE_MACHINE_ARN:
          'arn:aws:states:ap-southeast-2:123456789012:stateMachine:scan',
        STATE_MACHINE_ARN:
          'arn:aws:states:ap-southeast-2:123456789012:stateMachine:agent',
      }),
    ).toBeDefined();
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

describe('database credential validation', () => {
  it('accepts a bounded PEM CA certificate', () => {
    expect(databaseCredentialSchema.parse(validDatabaseCredential)).toEqual(
      validDatabaseCredential,
    );
  });

  it.each([
    ['missing CA certificate', { sslCaCertificate: undefined }],
    ['malformed CA certificate', { sslCaCertificate: 'not-a-certificate' }],
    ['string port', { port: '5432' }],
    ['unexpected field', { unexpected: 'value' }],
  ])('rejects %s', (_name, replacement) => {
    expect(() =>
      databaseCredentialSchema.parse({
        ...validDatabaseCredential,
        ...replacement,
      }),
    ).toThrow();
  });
});

describe('GitHub webhook configuration', () => {
  it('accepts resource identifiers separately from the webhook secret', () => {
    expect(
      parseConfig(githubWebhookConfigSchema, {
        APP_ENVIRONMENT: 'development',
        AWS_REGION: 'ap-southeast-2',
        GITHUB_WEBHOOK_QUEUE_URL:
          'https://sqs.ap-southeast-2.amazonaws.com/123456789012/github-webhooks',
        GITHUB_WEBHOOK_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:webhook',
      }),
    ).toBeDefined();
    expect(
      githubWebhookSecretSchema.parse({
        webhookSecret: 'a-non-production-secret-with-32-characters',
      }),
    ).toBeDefined();
  });

  it('rejects short secrets and non-HTTPS queue identifiers', () => {
    expect(() =>
      githubWebhookSecretSchema.parse({ webhookSecret: 'too-short' }),
    ).toThrow();
    expect(() =>
      parseConfig(githubWebhookConfigSchema, {
        APP_ENVIRONMENT: 'development',
        AWS_REGION: 'ap-southeast-2',
        GITHUB_WEBHOOK_QUEUE_URL: 'not-a-url',
        GITHUB_WEBHOOK_SECRET_ARN:
          'arn:aws:secretsmanager:ap-southeast-2:123456789012:secret:webhook',
      }),
    ).toThrow('Invalid service configuration: GITHUB_WEBHOOK_QUEUE_URL');
  });
});

describe('GitHub App secret validation', () => {
  it('accepts and normalizes a PEM file with its standard trailing newline', () => {
    const privateKey = [
      ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
      'A'.repeat(1_600),
      '-----END RSA PRIVATE KEY-----',
      '',
    ].join('\n');

    expect(githubAppSecretSchema.parse({ appId: '12345', privateKey }).privateKey).toBe(
      privateKey.trim(),
    );
  });

  it('rejects malformed private-key material and extra secret fields', () => {
    expect(() =>
      githubAppSecretSchema.parse({
        appId: '12345',
        privateKey: 'not-a-private-key',
      }),
    ).toThrow();
    expect(() =>
      githubAppSecretSchema.parse({
        appId: '12345',
        privateKey: [
          ['-----BEGIN ', 'PRIVATE KEY-----'].join(''),
          'A'.repeat(256),
          '-----END PRIVATE KEY-----',
        ].join('\n'),
        token: 'must-not-be-stored-here',
      }),
    ).toThrow();
  });
});
