import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const validator = fileURLToPath(
  new URL('../scripts/deploy/validate-environment.mjs', import.meta.url),
);

const validEnvironment: NodeJS.ProcessEnv = {
  AWS_ACCOUNT_ID: '393209814365',
  AWS_REGION: 'ap-southeast-2',
  DEPLOY_CONFIRMATION: 'deploy-development',
  DEPLOY_ROLE_ARN:
    'arn:aws:iam::393209814365:role/migration-api-development-github-deploy',
  GITHUB_REF: 'refs/heads/main',
  TF_STATE_BUCKET: 'migration-api-tfstate-393209814365-ap-southeast-2',
  TF_STATE_KMS_KEY_ARN:
    'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000000',
  TF_VAR_acm_certificate_arn:
    'arn:aws:acm:us-east-1:393209814365:certificate/00000000-0000-0000-0000-000000000000',
  TF_VAR_aws_region: 'ap-southeast-2',
  TF_VAR_database_migration_secret_arn:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:migrator',
  TF_VAR_database_migration_secret_kms_key_arn:
    'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000002',
  TF_VAR_database_secret_arn:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:runtime',
  TF_VAR_database_secret_kms_key_arn:
    'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000001',
  TF_VAR_github_webhook_secret_arn:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:github-webhook',
  TF_VAR_github_webhook_secret_kms_key_arn:
    'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000003',
  TF_VAR_github_app_secret_arn:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:github-app',
  TF_VAR_github_app_secret_kms_key_arn:
    'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000004',
  TF_VAR_openai_identity_provider_id: 'provider-id',
  TF_VAR_openai_model: 'gpt-5.6-sol',
  TF_VAR_openai_project_alias: 'development-agent',
  TF_VAR_openai_service_account_id: 'service-account-id',
  TF_VAR_owner: 'KunalSharma',
  TF_VAR_product_domain: 'migration-api.kunal-sharma.in',
  TF_VAR_supabase_jwks_url:
    'https://project-ref.supabase.co/auth/v1/.well-known/jwks.json',
  TF_VAR_supabase_jwt_audience: 'authenticated',
  TF_VAR_supabase_jwt_issuer: 'https://project-ref.supabase.co/auth/v1',
  TF_VAR_supabase_url: 'https://project-ref.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
};

function validate(environment: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [validator], {
    encoding: 'utf8',
    env: environment,
  });
}

describe('deployment environment validation', () => {
  it('accepts the GoDaddy-managed product domain without a Route 53 zone', () => {
    const result = validate(validEnvironment);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Validated 26 deployment variables.');
  });

  it('rejects a product URL instead of a hostname', () => {
    const result = validate({
      ...validEnvironment,
      TF_VAR_product_domain: 'https://migration-api.kunal-sharma.in',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'TF_VAR_product_domain must be a hostname without a scheme or path.',
    );
  });
});
