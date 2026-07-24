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

const commonSchema = z.object({
  APP_ENVIRONMENT: z.enum(['development', 'staging', 'production']),
  AWS_REGION: nonEmpty,
});

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

export const apiConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  ARTIFACT_KMS_KEY_ARN: awsArn,
  DATABASE_SECRET_ARN: awsArn,
  OPENAI_MODEL: nonEmpty.default('gpt-5.6-sol'),
  SUPABASE_JWT_AUDIENCE: nonEmpty,
  SUPABASE_JWT_ISSUER: z.url(),
  SUPABASE_JWKS_URL: z.url(),
});

export const dispatcherConfigSchema = commonSchema.extend({
  DATABASE_SECRET_ARN: awsArn,
  STATE_MACHINE_ARN: awsArn,
});

export const workflowControlConfigSchema = commonSchema.extend({
  ARTIFACT_BUCKET: nonEmpty,
  DATABASE_SECRET_ARN: awsArn,
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

export const migratorConfigSchema = commonSchema.extend({
  DATABASE_MIGRATION_SECRET_ARN: awsArn,
  MIGRATIONS_DIRECTORY: z.string().regex(/^\/app\/migrations$/u),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type DispatcherConfig = z.infer<typeof dispatcherConfigSchema>;
export type WorkflowControlConfig = z.infer<typeof workflowControlConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type MigratorConfig = z.infer<typeof migratorConfigSchema>;
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
