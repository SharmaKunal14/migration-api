import { z } from 'zod';

import { terminalCodes } from '@migration/domain';

export const uuidSchema = z.uuid();
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const githubIdSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
export const commitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
export const githubInstallationStateSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]{43}$/u);

export const githubInstallLinkRequestSchema = z.object({}).strict();

export const githubSetupCompletionRequestSchema = z
  .object({
    installationId: githubIdSchema,
    state: githubInstallationStateSchema,
  })
  .strict();

export const githubInstallationVerificationSchema = z
  .object({
    installationId: githubIdSchema,
    accountId: githubIdSchema,
    accountLogin: z.string().min(1).max(255),
    accountType: z.enum(['Organisation', 'User']),
    status: z.enum(['active', 'suspended']),
  })
  .strict();

export const repositoryScanWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    repositoryScanId: uuidSchema,
    correlationId: uuidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const githubWebhookEnvelopeSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    deliveryId: uuidSchema,
    eventName: z.enum([
      'installation',
      'installation_repositories',
      'repository',
      'push',
      'pull_request',
    ]),
    payloadDigest: sha256Schema,
    receivedAt: z.iso.datetime(),
    bodyBase64: z
      .string()
      .min(1)
      .max(512 * 1024),
  })
  .strict();

export const demoRunRequestSchema = z
  .object({
    scenarioId: z.literal('orbitchat-typescript-v1-v2'),
  })
  .strict();

export const workflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    agentRunId: uuidSchema,
    correlationId: uuidSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();

const evidenceReferenceSchema = z
  .object({
    evidenceId: z.string().regex(/^C-0[1-7]$/u),
    summary: z.string().min(1).max(512),
  })
  .strict();

const migrationChangeSchema = z
  .object({
    changeId: z.string().regex(/^C-0[1-7]$/u),
    category: z.enum(['request', 'response', 'runtime', 'behavior']),
    summary: z.string().min(1).max(512),
    certainty: z.literal('vendor_confirmed'),
    evidenceIds: z
      .array(z.string().regex(/^C-0[1-7]$/u))
      .min(1)
      .max(7),
  })
  .strict();

export const migrationPlanSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    scenarioId: z.literal('orbitchat-typescript-v1-v2'),
    packageName: z.literal('@orbitchat/sdk'),
    sourceCompatibility: z.literal('1.x'),
    targetVersion: z.literal('2.0.0'),
    changes: z.array(migrationChangeSchema).min(7).max(7),
    evidence: z.array(evidenceReferenceSchema).min(7).max(7),
    unresolved: z.array(z.string().min(1).max(512)).min(1).max(10),
    verificationRecommendations: z
      .array(z.enum(['typescript_static', 'typescript_unit']))
      .min(1)
      .max(2),
    reviewerNotes: z.array(z.string().min(1).max(512)).min(1).max(10),
  })
  .strict()
  .superRefine((plan, context) => {
    const expected = new Set(['C-01', 'C-02', 'C-03', 'C-04', 'C-05', 'C-06', 'C-07']);
    const actual = new Set(plan.changes.map(change => change.changeId));
    if (actual.size !== expected.size || [...expected].some(id => !actual.has(id))) {
      context.addIssue({
        code: 'custom',
        message: 'The plan must contain each confirmed change C-01 through C-07.',
        path: ['changes'],
      });
    }
    const actualEvidence = new Set(plan.evidence.map(item => item.evidenceId));
    if (
      actualEvidence.size !== expected.size ||
      [...expected].some(id => !actualEvidence.has(id))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The plan must contain evidence C-01 through C-07.',
        path: ['evidence'],
      });
    }
  });

export const agentResultEnvelopeSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    agentRunId: uuidSchema,
    model: z
      .object({
        provider: z.literal('openai'),
        requestedModel: z.string().min(1).max(128),
        returnedModel: z.string().min(1).max(128),
        reasoningEffort: z.literal('medium'),
        requestId: z.string().min(1).max(256).nullable(),
      })
      .strict(),
    usage: z
      .object({
        modelCalls: z.number().int().nonnegative(),
        toolCalls: z.number().int().nonnegative(),
        iterations: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        durationMs: z.number().int().nonnegative(),
      })
      .strict(),
    actions: z
      .array(
        z
          .object({
            id: uuidSchema,
            sequence: z.number().int().min(1).max(10_000),
            toolName: z.literal('read_vendor_evidence'),
            toolVersion: z.literal('1.0.0'),
            status: z.enum(['succeeded', 'failed', 'rejected', 'timed_out']),
            inputDigest: sha256Schema,
            outputDigest: sha256Schema.nullable(),
            safeErrorCode: z
              .string()
              .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
              .nullable(),
            startedAt: z.iso.datetime(),
            completedAt: z.iso.datetime(),
          })
          .strict(),
      )
      .max(12),
    terminal: z
      .object({
        code: z.enum(terminalCodes),
        safeErrorCode: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
          .nullable(),
      })
      .strict(),
    result: migrationPlanSchema.nullable(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.terminal.code === 'completed' && envelope.result === null) {
      context.addIssue({
        code: 'custom',
        message: 'Completed results require a migration plan.',
        path: ['result'],
      });
    }
    if (envelope.terminal.code !== 'completed' && envelope.result !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Failed results cannot contain a migration plan.',
        path: ['result'],
      });
    }
  });

export type DemoRunRequest = z.infer<typeof demoRunRequestSchema>;
export type WorkflowInput = z.infer<typeof workflowInputSchema>;
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;
export type AgentResultEnvelope = z.infer<typeof agentResultEnvelopeSchema>;
export type RepositoryScanWorkflowInput = z.infer<
  typeof repositoryScanWorkflowInputSchema
>;
export type GithubWebhookEnvelope = z.infer<typeof githubWebhookEnvelopeSchema>;
export type GithubSetupCompletionRequest = z.infer<
  typeof githubSetupCompletionRequestSchema
>;
export type GithubInstallationVerification = z.infer<
  typeof githubInstallationVerificationSchema
>;

export interface PublicOrganisation {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly role: 'owner' | 'admin' | 'reviewer' | 'viewer';
}

export interface PublicAgentRun {
  readonly id: string;
  readonly organisationId: string;
  readonly scenarioId: 'orbitchat-typescript-v1-v2';
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed';
  readonly terminalCode: string | null;
  readonly safeErrorCode: string | null;
  readonly result: MigrationPlan | null;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface PublicGithubInstallation {
  readonly id: string;
  readonly accountLogin: string;
  readonly accountType: 'Organisation' | 'User';
  readonly status: 'active' | 'suspended' | 'removed';
  readonly lastReconciledAt: string | null;
}

export interface PublicGithubInstallLink {
  readonly installationUrl: string;
  readonly expiresAt: string;
}

export interface PublicGithubSetupCompletion {
  readonly organisationId: string;
  readonly installation: PublicGithubInstallation;
}

export interface PublicRepository {
  readonly id: string;
  readonly installationId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly selected: boolean;
  readonly archived: boolean;
  readonly enabled: boolean;
  readonly latestScanStatus:
    'queued' | 'running' | 'succeeded' | 'failed' | 'unsupported' | null;
  readonly latestScannedCommit: string | null;
}

export interface PublicDependencyObservation {
  readonly packageName: string;
  readonly dependencyKind: 'dependency' | 'development' | 'optional' | 'peer';
  readonly manifestPath: string;
  readonly lockfilePath: string | null;
  readonly declaredRange: string;
  readonly resolvedVersion: string | null;
  readonly discoveryMethod: 'manifest' | 'npm_lockfile';
}
