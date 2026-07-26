const requiredVariables = [
  'AWS_ACCOUNT_ID',
  'AWS_REGION',
  'DEPLOY_ROLE_ARN',
  'TF_STATE_BUCKET',
  'TF_STATE_KMS_KEY_ARN',
  'TF_VAR_acm_certificate_arn',
  'TF_VAR_aws_region',
  'TF_VAR_database_migration_secret_arn',
  'TF_VAR_database_migration_secret_kms_key_arn',
  'TF_VAR_database_secret_arn',
  'TF_VAR_database_secret_kms_key_arn',
  'TF_VAR_github_webhook_secret_arn',
  'TF_VAR_github_webhook_secret_kms_key_arn',
  'TF_VAR_github_app_secret_arn',
  'TF_VAR_github_app_secret_kms_key_arn',
  'TF_VAR_github_app_slug',
  'TF_VAR_openai_identity_provider_id',
  'TF_VAR_openai_model',
  'TF_VAR_openai_project_alias',
  'TF_VAR_openai_service_account_id',
  'TF_VAR_change_intelligence_openai_identity_provider_id',
  'TF_VAR_change_intelligence_openai_service_account_id',
  'TF_VAR_owner',
  'TF_VAR_product_domain',
  'TF_VAR_supabase_jwks_url',
  'TF_VAR_supabase_jwt_audience',
  'TF_VAR_supabase_jwt_issuer',
  'TF_VAR_supabase_url',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
];

const missing = requiredVariables.filter(name => !process.env[name]?.trim());
if (missing.length > 0) {
  throw new Error(`Missing deployment variables: ${missing.join(', ')}`);
}

if (process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Development deployments must run from refs/heads/main.');
}
if (process.env.DEPLOY_CONFIRMATION !== 'deploy-development') {
  throw new Error('Deployment confirmation must equal deploy-development.');
}
if (!/^\d{12}$/u.test(process.env.AWS_ACCOUNT_ID)) {
  throw new Error('AWS_ACCOUNT_ID must contain exactly 12 digits.');
}
if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(process.env.AWS_REGION)) {
  throw new Error('AWS_REGION is not a valid AWS region identifier.');
}
if (
  !/^arn:aws:iam::\d{12}:role\/migration-api-development-github-deploy$/u.test(
    process.env.DEPLOY_ROLE_ARN,
  )
) {
  throw new Error('DEPLOY_ROLE_ARN must identify the exact development deploy role.');
}
if (process.env.TF_VAR_aws_region !== process.env.AWS_REGION) {
  throw new Error('TF_VAR_aws_region must match AWS_REGION.');
}
if (!/^https:\/\//u.test(process.env.TF_VAR_supabase_url)) {
  throw new Error('TF_VAR_supabase_url must use HTTPS.');
}
if (!/^[a-z0-9.-]+$/u.test(process.env.TF_VAR_product_domain)) {
  throw new Error('TF_VAR_product_domain must be a hostname without a scheme or path.');
}
if (
  process.env.TF_VAR_product_domain === 'localhost' ||
  process.env.TF_VAR_product_domain.endsWith('.localhost')
) {
  throw new Error('TF_VAR_product_domain must be a deployable hostname.');
}
if (
  !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(process.env.TF_VAR_github_app_slug)
) {
  throw new Error('TF_VAR_github_app_slug must be a valid GitHub App slug.');
}

process.stdout.write(`Validated ${requiredVariables.length} deployment variables.\n`);
