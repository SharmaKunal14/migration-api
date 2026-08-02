import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const awsArn = z.string().regex(/^arn:aws[a-zA-Z-]*:/u, 'Expected an AWS ARN');
const pemCertificate = z
  .string()
  .trim()
  .min(1)
  .max(16 * 1024)
  .regex(
    /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u,
    'Expected a PEM-encoded certificate',
  );
const privateKeyPattern = new RegExp(
  [
    '^(?:-----BEGIN ',
    'PRIVATE KEY-----\\r?\\n[\\s\\S]+-----END PRIVATE KEY-----|',
    '-----BEGIN RSA ',
    'PRIVATE KEY-----\\r?\\n[\\s\\S]+-----END RSA PRIVATE KEY-----)$',
  ].join(''),
  'u',
);

const commonSchema = z.object({
  APP_ENVIRONMENT: z.enum(['development', 'staging', 'production']),
  AWS_REGION: nonEmpty,
});

const jsonUuidArraySchema = z
  .string()
  .max(4_096)
  .transform((value, context): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: 'custom', message: 'Expected a JSON UUID array.' });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(z.uuid())
      .min(1)
      .max(50)
      .refine(values => new Set(values).size === values.length, {
        message: 'UUID array values must be unique.',
      }),
  );

export const databaseCredentialSchema = z
  .object({
    host: nonEmpty,
    port: z.number().int().min(1).max(65_535),
    database: nonEmpty,
    username: nonEmpty,
    password: z.string().min(1),
    sslCaCertificate: pemCertificate,
  })
  .strict();

export const githubWebhookSecretSchema = z
  .object({
    webhookSecret: z.string().min(32).max(256),
  })
  .strict();

export const githubAppSecretSchema = z
  .object({
    appId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    privateKey: z
      .string()
      .trim()
      .min(256)
      .max(16 * 1024)
      .regex(privateKeyPattern),
  })
  .strict();

export const apiConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  DATABASE_SECRET_ARN: awsArn,
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u),
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: z.string().regex(/^[A-Za-z0-9-_]{1,64}$/u),
  IMPACT_ANALYSIS_STATE_MACHINE_ARN: awsArn,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  SUPABASE_JWT_AUDIENCE: nonEmpty,
  SUPABASE_JWT_ISSUER: z.url(),
  SUPABASE_JWKS_URL: z.url(),
});

export const dispatcherConfigSchema = commonSchema.extend({
  DATABASE_SECRET_ARN: awsArn,
  MIGRATION_STATE_MACHINE_ARN: awsArn,
  RELEASE_INTELLIGENCE_STATE_MACHINE_ARN: awsArn,
  REPOSITORY_SCAN_STATE_MACHINE_ARN: awsArn,
  STATE_MACHINE_ARN: awsArn,
});

export const workflowControlConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  DATABASE_SECRET_ARN: awsArn,
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: z.string().regex(/^[A-Za-z0-9-_]{1,64}$/u),
  VERIFIER_REGISTRY_URL: z
    .literal('https://registry.npmjs.org/')
    .default('https://registry.npmjs.org/'),
});

export const agentConfigSchema = commonSchema.extend({
  AGENT_RUN_ID: z.uuid(),
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  OPENAI_IDENTITY_PROVIDER_ID: nonEmpty,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  OPENAI_PROJECT_ALIAS: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
  OPENAI_SERVICE_ACCOUNT_ID: nonEmpty,
  OPENAI_WIF_AUDIENCE: z.literal('https://api.openai.com/v1'),
  ORGANISATION_ID: z.uuid(),
});

export const migrationAgentConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  INPUT_DIGEST: z.string().regex(/^[a-f0-9]{64}$/u),
  INPUT_OBJECT_KEY: z.string().min(1).max(1_024),
  MIGRATION_RUN_ID: z.uuid(),
  OPENAI_IDENTITY_PROVIDER_ID: nonEmpty,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  OPENAI_PROJECT_ALIAS: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
  OPENAI_SERVICE_ACCOUNT_ID: nonEmpty,
  OPENAI_WIF_AUDIENCE: z.literal('https://api.openai.com/v1'),
  ORGANISATION_ID: z.uuid(),
  REPOSITORY_ID: z.uuid(),
  RESULT_OBJECT_KEY: z.string().min(1).max(1_024),
});

export const migratorConfigSchema = commonSchema.extend({
  DATABASE_MIGRATION_SECRET_ARN: awsArn,
  MIGRATIONS_DIRECTORY: z.string().regex(/^\/app\/migrations$/u),
});

export const githubWebhookConfigSchema = commonSchema.extend({
  GITHUB_WEBHOOK_QUEUE_URL: z.url(),
  GITHUB_WEBHOOK_SECRET_ARN: awsArn,
});

export const githubTokenBrokerConfigSchema = commonSchema.extend({
  DATABASE_SECRET_ARN: awsArn,
  GITHUB_APP_SECRET_ARN: awsArn,
});

export const githubReconcilerConfigSchema = commonSchema.extend({
  DATABASE_SECRET_ARN: awsArn,
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: z.string().regex(/^[A-Za-z0-9-_]{1,64}$/u),
});

export const repositoryScanControlConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  DATABASE_SECRET_ARN: awsArn,
});

export const packageSourceResolverConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  DATABASE_SECRET_ARN: awsArn,
  NPM_REGISTRY_ORIGIN: z
    .literal('https://registry.npmjs.org')
    .default('https://registry.npmjs.org'),
});

export const packageReleasePollerConfigSchema = packageSourceResolverConfigSchema;

export const sourceFetcherConfigSchema = commonSchema.extend({
  ACQUISITION_MODE: z.literal('repository_scan'),
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: z.string().regex(/^[A-Za-z0-9-_]{1,64}$/u),
  ORGANISATION_ID: z.uuid(),
  REPOSITORY_ID: z.uuid(),
  REPOSITORY_SCAN_ID: z.uuid(),
  WORKSPACE_DIRECTORY: z.literal('/workspace'),
});

export const migrationSourceFetcherConfigSchema = commonSchema.extend({
  ACQUISITION_MODE: z.literal('migration'),
  APPROVAL_ID: z.uuid(),
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  GITHUB_TOKEN_BROKER_FUNCTION_NAME: z.string().regex(/^[A-Za-z0-9-_]{1,64}$/u),
  MIGRATION_RUN_ID: z.uuid(),
  ORGANISATION_ID: z.uuid(),
  REPOSITORY_ID: z.uuid(),
  WORKSPACE_DIRECTORY: z.literal('/workspace'),
});

export const vendorFetcherConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  CORRELATION_ID: z.uuid(),
  DATABASE_SECRET_ARN: awsArn,
  VENDOR_RELEASE_ID: z.uuid(),
});

export const changeIntelligenceAgentConfigSchema = commonSchema.extend({
  ALLOWED_EVIDENCE_SOURCE_IDS: jsonUuidArraySchema,
  API_PRODUCT_ID: z.uuid(),
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  CHANGE_INTELLIGENCE_RUN_ID: z.uuid(),
  CHANGE_INTELLIGENCE_POLICY_VERSION: z.literal('stage-8e-v1'),
  ECOSYSTEM: z.literal('npm'),
  EVIDENCE_DIGEST: z.string().regex(/^[a-f0-9]{64}$/u),
  EVIDENCE_OBJECT_KEY: z.string().min(1).max(1_024),
  MAXIMUM_INPUT_TOKENS: z.coerce.number().int().min(1).max(60_000),
  MAXIMUM_ITERATIONS: z.coerce.number().int().min(1).max(4),
  MAXIMUM_MODEL_CALLS: z.coerce.number().int().min(1).max(3),
  MAXIMUM_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(12_000),
  MAXIMUM_TOOL_CALLS: z.coerce.number().int().min(1).max(12),
  MAXIMUM_WALL_CLOCK_MILLISECONDS: z.coerce.number().int().min(1_000).max(300_000),
  OPENAI_IDENTITY_PROVIDER_ID: nonEmpty,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  OPENAI_PROJECT_ALIAS: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
  OPENAI_SERVICE_ACCOUNT_ID: nonEmpty,
  OPENAI_WIF_AUDIENCE: z.literal('https://api.openai.com/v1'),
  PACKAGE_IDENTIFIER: z.string().min(1).max(214),
  RESULT_OBJECT_KEY: z.string().min(1).max(1_024),
  SOURCE_COMPATIBILITY: z.string().min(1).max(100),
  SPECIFICATION_REVISION: z.coerce.number().int().positive(),
  SPECIFICATION_SCHEMA_VERSION: z.literal('1.0'),
  TARGET_VERSION: z.string().min(1).max(100),
  VENDOR_NAME: z.string().min(1).max(120),
  VENDOR_RELEASE_ID: z.uuid(),
  VENDOR_SLUG: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
});

export const vendorIntelligenceControlConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  CHANGE_INTELLIGENCE_MAXIMUM_INPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60_000)
    .default(60_000),
  CHANGE_INTELLIGENCE_MAXIMUM_ITERATIONS: z.coerce
    .number()
    .int()
    .min(1)
    .max(4)
    .default(4),
  CHANGE_INTELLIGENCE_MAXIMUM_MODEL_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3)
    .default(3),
  CHANGE_INTELLIGENCE_MAXIMUM_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(1)
    .max(12_000)
    .default(12_000),
  CHANGE_INTELLIGENCE_MAXIMUM_TOOL_CALLS: z.coerce
    .number()
    .int()
    .min(1)
    .max(12)
    .default(12),
  CHANGE_INTELLIGENCE_MAXIMUM_WALL_CLOCK_MILLISECONDS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(300_000)
    .default(300_000),
  DATABASE_SECRET_ARN: awsArn,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
});

export const impactAnalysisAgentConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  CANDIDATE_ID: z.uuid(),
  IMPACT_ANALYSIS_RUN_ID: z.uuid(),
  INPUT_DIGEST: z.string().regex(/^[a-f0-9]{64}$/u),
  INPUT_OBJECT_KEY: z.string().min(1).max(1_024),
  OPENAI_IDENTITY_PROVIDER_ID: nonEmpty,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  OPENAI_PROJECT_ALIAS: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
  OPENAI_SERVICE_ACCOUNT_ID: nonEmpty,
  OPENAI_WIF_AUDIENCE: z.literal('https://api.openai.com/v1'),
  RESULT_OBJECT_KEY: z.string().min(1).max(1_024),
});

export const impactAnalysisControlConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  DATABASE_SECRET_ARN: awsArn,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>;
export type WorkflowControlConfig = z.infer<typeof workflowControlConfigSchema>;
export type PackageSourceResolverConfig = z.infer<
  typeof packageSourceResolverConfigSchema
>;
export type PackageReleasePollerConfig = z.infer<
  typeof packageReleasePollerConfigSchema
>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type MigrationAgentConfig = z.infer<typeof migrationAgentConfigSchema>;
export type MigratorConfig = z.infer<typeof migratorConfigSchema>;
export type GithubWebhookConfig = z.infer<typeof githubWebhookConfigSchema>;
export type GithubTokenBrokerConfig = z.infer<typeof githubTokenBrokerConfigSchema>;
export type GithubReconcilerConfig = z.infer<typeof githubReconcilerConfigSchema>;
export type RepositoryScanControlConfig = z.infer<
  typeof repositoryScanControlConfigSchema
>;
export type SourceFetcherConfig = z.infer<typeof sourceFetcherConfigSchema>;
export type MigrationSourceFetcherConfig = z.infer<
  typeof migrationSourceFetcherConfigSchema
>;
export type VendorFetcherConfig = z.infer<typeof vendorFetcherConfigSchema>;
export type ChangeIntelligenceAgentConfig = z.infer<
  typeof changeIntelligenceAgentConfigSchema
>;
export type VendorIntelligenceControlConfig = z.infer<
  typeof vendorIntelligenceControlConfigSchema
>;
export type ImpactAnalysisAgentConfig = z.infer<typeof impactAnalysisAgentConfigSchema>;
export type ImpactAnalysisControlConfig = z.infer<
  typeof impactAnalysisControlConfigSchema
>;
export type DatabaseCredential = z.infer<typeof databaseCredentialSchema>;

export function parseConfig<T>(
  schema: z.ZodType<T>,
  environment: NodeJS.ProcessEnv = process.env,
): T {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues.map(issue => issue.path.join('.')).join(', ');
    throw new Error(`Invalid service configuration: ${fields}`);
  }
  return parsed.data;
}
