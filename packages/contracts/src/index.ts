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

export const githubInventoryRepositorySchema = z
  .object({
    githubRepositoryId: githubIdSchema,
    owner: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    fullName: z.string().min(3).max(512),
    defaultBranch: z.string().min(1).max(255),
    visibility: z.enum(['public', 'private', 'internal']),
    archived: z.boolean(),
  })
  .strict()
  .refine(
    repository => repository.fullName === `${repository.owner}/${repository.name}`,
    {
      message: 'Repository full name does not match its owner and name.',
      path: ['fullName'],
    },
  );

export const githubReconciliationInstallationSchema =
  githubInstallationVerificationSchema.extend({
    status: z.enum(['active', 'suspended', 'removed']),
  });

export const githubInstallationInventorySchema = z
  .object({
    installation: githubReconciliationInstallationSchema,
    repositories: z.array(githubInventoryRepositorySchema).max(500),
  })
  .strict()
  .superRefine((inventory, context) => {
    if (
      inventory.installation.status !== 'active' &&
      inventory.repositories.length > 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Inactive installations cannot expose repositories.',
        path: ['repositories'],
      });
    }
    const ids = new Set<string>();
    for (const [index, repository] of inventory.repositories.entries()) {
      if (ids.has(repository.githubRepositoryId)) {
        context.addIssue({
          code: 'custom',
          message: 'Repository IDs must be unique.',
          path: ['repositories', index, 'githubRepositoryId'],
        });
      }
      ids.add(repository.githubRepositoryId);
    }
  });

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

export const repositoryScanRequestSchema = z.object({}).strict();

const dependencyObservationSchema = z
  .object({
    packageName: z.string().min(1).max(214),
    kind: z.enum(['dependency', 'development', 'optional', 'peer']),
    manifestPath: z.string().min(1).max(1_024),
    lockfilePath: z.string().min(1).max(1_024).nullable(),
    declaredRange: z.string().min(1).max(1_024),
    resolvedVersion: z.string().min(1).max(1_024).nullable(),
    discoveryMethod: z.enum(['manifest', 'npm_lockfile']),
  })
  .strict();

export const repositoryAcquisitionResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    repositoryScanId: uuidSchema,
    status: z.enum(['succeeded', 'unsupported', 'failed']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    snapshot: z
      .object({
        commitSha: commitShaSchema,
        objectKey: z.string().min(1).max(1_024),
        digest: sha256Schema,
        bytes: z
          .number()
          .int()
          .min(1)
          .max(256 * 1024 * 1024),
        fileCount: z.number().int().min(1).max(20_000),
        expiresAt: z.iso.datetime(),
      })
      .strict()
      .nullable(),
    inventory: z
      .object({
        manifests: z.array(z.string().min(1).max(1_024)).max(200),
        lockfiles: z.array(z.string().min(1).max(1_024)).max(200),
        observations: z.array(dependencyObservationSchema).max(10_000),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const succeeded = result.status === 'succeeded';
    if (succeeded !== (result.snapshot !== null && result.inventory !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful acquisition requires snapshot and inventory evidence.',
        path: ['status'],
      });
    }
    if (succeeded === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only unsuccessful acquisition results require a safe error code.',
        path: ['safeErrorCode'],
      });
    }
  });

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

const migrationEvidenceReferenceSchema = z
  .object({
    evidenceId: z.string().regex(/^C-[0-9]{2,4}$/u),
    sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
    sourceUrl: z
      .url()
      .max(2_048)
      .refine(value => value.startsWith('https://'), {
        message: 'Vendor evidence URLs must use HTTPS.',
      }),
    digest: sha256Schema,
    summary: z.string().min(1).max(1_024),
  })
  .strict();

const migrationTransformationSchema = z
  .object({
    kind: z.enum([
      'rename_symbol',
      'rename_field',
      'wrap_field',
      'runtime_requirement',
      'behavior_review',
    ]),
    before: z.string().min(1).max(512),
    after: z.string().min(1).max(512),
    condition: z.string().min(1).max(512).nullable(),
  })
  .strict();

const migrationSpecificationChangeSchema = z
  .object({
    changeId: z.string().regex(/^C-[0-9]{2,4}$/u),
    category: z.enum(['request', 'response', 'runtime', 'behavior', 'deprecation']),
    summary: z.string().min(1).max(1_024),
    certainty: z.enum(['vendor_confirmed', 'ambiguous']),
    evidenceIds: z
      .array(z.string().regex(/^C-[0-9]{2,4}$/u))
      .min(1)
      .max(50),
    transformations: z.array(migrationTransformationSchema).max(20),
  })
  .strict();

export const migrationSpecificationSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendor: z
      .object({
        slug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
        name: z.string().min(1).max(120),
      })
      .strict(),
    product: z
      .object({
        ecosystem: z.enum(['npm']),
        identifier: z.string().min(1).max(214),
      })
      .strict(),
    sourceCompatibility: z.string().min(1).max(100),
    targetVersion: z.string().min(1).max(100),
    changes: z.array(migrationSpecificationChangeSchema).min(1).max(100),
    evidence: z.array(migrationEvidenceReferenceSchema).min(1).max(100),
    preconditions: z.array(z.string().min(1).max(512)).max(50),
    verificationRecommendations: z
      .array(z.enum(['typescript_static', 'typescript_unit']))
      .min(1)
      .max(2),
    uncertainties: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
            summary: z.string().min(1).max(1_024),
            evidenceIds: z
              .array(z.string().regex(/^C-[0-9]{2,4}$/u))
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .max(50),
    trust: z
      .object({
        status: z.enum(['draft', 'reviewed', 'vendor_verified']),
        generatedBy: z.enum(['change_intelligence_agent', 'operator']),
        reviewedAt: z.iso.datetime().nullable(),
      })
      .strict(),
    revision: z.number().int().positive(),
    generatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((specification, context) => {
    const changeIds = specification.changes.map(change => change.changeId);
    if (new Set(changeIds).size !== changeIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Migration change IDs must be unique.',
        path: ['changes'],
      });
    }
    const evidenceIds = specification.evidence.map(item => item.evidenceId);
    const knownEvidence = new Set(evidenceIds);
    if (knownEvidence.size !== evidenceIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Migration evidence IDs must be unique.',
        path: ['evidence'],
      });
    }
    for (const [index, change] of specification.changes.entries()) {
      for (const evidenceId of change.evidenceIds) {
        if (!knownEvidence.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: 'A change references unknown evidence.',
            path: ['changes', index, 'evidenceIds'],
          });
        }
      }
    }
    for (const [index, uncertainty] of specification.uncertainties.entries()) {
      for (const evidenceId of uncertainty.evidenceIds) {
        if (!knownEvidence.has(evidenceId)) {
          context.addIssue({
            code: 'custom',
            message: 'An uncertainty references unknown evidence.',
            path: ['uncertainties', index, 'evidenceIds'],
          });
        }
      }
    }
    const reviewed = specification.trust.status !== 'draft';
    if (reviewed !== (specification.trust.reviewedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only reviewed specifications have a review timestamp.',
        path: ['trust', 'reviewedAt'],
      });
    }
  });

export const vendorEvidenceBundleSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    bundleId: z.string().regex(/^[a-z][a-z0-9-]{2,127}$/u),
    vendorSlug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
    ecosystem: z.enum(['npm']),
    productIdentifier: z.string().min(1).max(214),
    sourceVersion: z.string().min(1).max(100),
    targetVersion: z.string().min(1).max(100),
    sources: z
      .array(
        z
          .object({
            sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
            kind: z.enum([
              'package_registry_release',
              'migration_guide',
              'changelog',
              'api_definition',
              'sdk_repository_release',
            ]),
            canonicalUrl: z
              .url()
              .max(2_048)
              .refine(value => value.startsWith('https://'), {
                message: 'Vendor source URLs must use HTTPS.',
              }),
            contentPath: z
              .string()
              .min(1)
              .max(1_024)
              .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._/-]+$/u),
            mediaType: z.enum([
              'application/json',
              'text/markdown',
              'text/plain',
              'text/typescript',
            ]),
            digest: sha256Schema,
            bytes: z
              .number()
              .int()
              .positive()
              .max(1024 * 1024),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((bundle, context) => {
    const keys = bundle.sources.map(source => source.sourceKey);
    const paths = bundle.sources.map(source => source.contentPath);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: 'custom',
        message: 'Vendor source keys must be unique.',
        path: ['sources'],
      });
    }
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        message: 'Vendor source content paths must be unique.',
        path: ['sources'],
      });
    }
  });

export const vendorIngestionWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    correlationId: uuidSchema,
  })
  .strict();

const ingestedVendorSourceSchema = z
  .object({
    vendorSourceId: uuidSchema,
    sourceKey: z.string().regex(/^[a-z][a-z0-9_-]{2,63}$/u),
    canonicalUrl: z.url().max(2_048),
    objectKey: z.string().min(1).max(1_024),
    digest: sha256Schema,
    bytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024),
    mediaType: z.string().min(1).max(255),
    etag: z.string().min(1).max(512).nullable(),
  })
  .strict();

export const vendorIngestionResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    ingestionRunId: uuidSchema,
    status: z.enum(['succeeded', 'failed']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    bundle: z
      .object({
        objectKey: z.string().min(1).max(1_024),
        digest: sha256Schema,
        bytes: z
          .number()
          .int()
          .positive()
          .max(8 * 1024 * 1024),
        sources: z.array(ingestedVendorSourceSchema).min(1).max(50),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const succeeded = result.status === 'succeeded';
    if (succeeded !== (result.bundle !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful ingestion requires an evidence bundle.',
        path: ['bundle'],
      });
    }
    if (succeeded === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed ingestion results require a safe error code.',
        path: ['safeErrorCode'],
      });
    }
  });

export const ingestedVendorEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    vendorSlug: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/u),
    productId: uuidSchema,
    version: z.string().min(1).max(100),
    sources: z
      .array(
        ingestedVendorSourceSchema.extend({
          finalUrl: z.url().max(2_048),
        }),
      )
      .min(1)
      .max(50),
  })
  .strict()
  .superRefine((manifest, context) => {
    const sourceKeys = manifest.sources.map(source => source.sourceKey);
    const sourceIds = manifest.sources.map(source => source.vendorSourceId);
    if (
      new Set(sourceKeys).size !== sourceKeys.length ||
      new Set(sourceIds).size !== sourceIds.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Ingested vendor evidence sources must be unique.',
        path: ['sources'],
      });
    }
  });

export const changeIntelligenceWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    correlationId: uuidSchema,
  })
  .strict();

export const changeIntelligencePreparedInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    changeIntelligenceRunId: uuidSchema,
    correlationId: uuidSchema,
    evidenceObjectKey: z.string().min(1).max(1_024),
    evidenceDigest: sha256Schema,
    specificationRevision: z.number().int().positive(),
    resultObjectKey: z.string().min(1).max(1_024),
    alreadySucceeded: z.boolean(),
  })
  .strict();

const changeIntelligenceActionSchema = z
  .object({
    sequence: z.number().int().positive().max(12),
    toolName: z.enum(['list_vendor_evidence', 'read_vendor_evidence']),
    sourceKey: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{2,63}$/u)
      .nullable(),
    status: z.enum(['succeeded', 'rejected']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    inputDigest: sha256Schema,
    outputDigest: sha256Schema.nullable(),
  })
  .strict();

export const changeIntelligenceResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    vendorReleaseId: uuidSchema,
    changeIntelligenceRunId: uuidSchema,
    evidenceObjectKey: z.string().min(1).max(1_024),
    evidenceDigest: sha256Schema,
    status: z.enum(['succeeded', 'failed']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    model: z
      .object({
        requestedModel: z.string().min(1).max(200),
        returnedModel: z.string().min(1).max(200),
        requestId: z
          .string()
          .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u)
          .nullable(),
      })
      .strict(),
    usage: z
      .object({
        modelCalls: z.number().int().min(0).max(3),
        toolCalls: z.number().int().min(0).max(12),
        iterations: z.number().int().min(0).max(4),
        inputTokens: z.number().int().nonnegative().max(60_000),
        outputTokens: z.number().int().nonnegative().max(12_000),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 60 * 1_000),
      })
      .strict(),
    actions: z.array(changeIntelligenceActionSchema).max(12),
    specification: migrationSpecificationSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const succeeded = result.status === 'succeeded';
    if (succeeded !== (result.specification !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful intelligence results require a specification.',
        path: ['specification'],
      });
    }
    if (succeeded === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed intelligence results require a safe error code.',
        path: ['safeErrorCode'],
      });
    }
    if (
      result.specification &&
      (result.specification.trust.status !== 'draft' ||
        result.specification.trust.generatedBy !== 'change_intelligence_agent' ||
        result.specification.trust.reviewedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Agent specifications must remain unreviewed drafts.',
        path: ['specification', 'trust'],
      });
    }
  });

const repositoryRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\).+$/u)
  .refine(
    value => Array.from(value).every(character => character.charCodeAt(0) >= 32),
    {
      message: 'Repository paths cannot contain control characters.',
    },
  );

const impactedFileSchema = z
  .object({
    path: repositoryRelativePathSchema,
    classification: z.enum([
      'dependency_manifest',
      'lockfile',
      'direct_usage',
      'indirect_usage',
      'test',
    ]),
    symbols: z.array(z.string().min(1).max(512)).max(100),
    expectedChanges: z.array(z.string().min(1).max(1_024)).max(50),
    retrievalReason: z.string().min(1).max(1_024),
  })
  .strict();

export const impactReportSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    candidateId: uuidSchema,
    repository: z
      .object({
        repositoryId: uuidSchema,
        snapshotId: uuidSchema,
        commitSha: commitShaSchema,
        snapshotDigest: sha256Schema,
      })
      .strict(),
    outcome: z.enum(['affected', 'not_affected', 'inconclusive']),
    affectedFiles: z.array(impactedFileSchema).max(500),
    unaffectedFiles: z
      .array(
        z
          .object({
            path: repositoryRelativePathSchema,
            reason: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .max(500),
    verification: z
      .object({
        profiles: z
          .array(
            z
              .object({
                profile: z.enum(['typescript_static', 'typescript_unit']),
                availability: z.enum(['available', 'unavailable']),
                reason: z.string().min(1).max(1_024),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    risk: z.enum(['low', 'medium', 'high', 'unknown']),
    uncertainties: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
            summary: z.string().min(1).max(1_024),
          })
          .strict(),
      )
      .max(100),
    revision: z.number().int().positive(),
    generatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((report, context) => {
    const affectedPaths = report.affectedFiles.map(file => file.path);
    const unaffectedPaths = report.unaffectedFiles.map(file => file.path);
    if (new Set(affectedPaths).size !== affectedPaths.length) {
      context.addIssue({
        code: 'custom',
        message: 'Affected file paths must be unique.',
        path: ['affectedFiles'],
      });
    }
    if (new Set(unaffectedPaths).size !== unaffectedPaths.length) {
      context.addIssue({
        code: 'custom',
        message: 'Unaffected file paths must be unique.',
        path: ['unaffectedFiles'],
      });
    }
    const affected = new Set(affectedPaths);
    if (unaffectedPaths.some(path => affected.has(path))) {
      context.addIssue({
        code: 'custom',
        message: 'A file cannot be both affected and unaffected.',
        path: ['unaffectedFiles'],
      });
    }
    if (report.outcome === 'affected' && report.affectedFiles.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Affected reports must identify at least one affected file.',
        path: ['affectedFiles'],
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
export type MigrationSpecification = z.infer<typeof migrationSpecificationSchema>;
export type VendorEvidenceBundle = z.infer<typeof vendorEvidenceBundleSchema>;
export type ImpactReport = z.infer<typeof impactReportSchema>;
export type VendorIngestionWorkflowInput = z.infer<
  typeof vendorIngestionWorkflowInputSchema
>;
export type VendorIngestionResult = z.infer<typeof vendorIngestionResultSchema>;
export type IngestedVendorEvidenceManifest = z.infer<
  typeof ingestedVendorEvidenceManifestSchema
>;
export type ChangeIntelligenceWorkflowInput = z.infer<
  typeof changeIntelligenceWorkflowInputSchema
>;
export type ChangeIntelligencePreparedInput = z.infer<
  typeof changeIntelligencePreparedInputSchema
>;
export type ChangeIntelligenceResult = z.infer<typeof changeIntelligenceResultSchema>;
export type AgentResultEnvelope = z.infer<typeof agentResultEnvelopeSchema>;
export type RepositoryScanWorkflowInput = z.infer<
  typeof repositoryScanWorkflowInputSchema
>;
export type RepositoryAcquisitionResult = z.infer<
  typeof repositoryAcquisitionResultSchema
>;
export type GithubWebhookEnvelope = z.infer<typeof githubWebhookEnvelopeSchema>;
export type GithubSetupCompletionRequest = z.infer<
  typeof githubSetupCompletionRequestSchema
>;
export type GithubInstallationVerification = z.infer<
  typeof githubInstallationVerificationSchema
>;
export type GithubInventoryRepository = z.infer<typeof githubInventoryRepositorySchema>;
export type GithubInstallationInventory = z.infer<
  typeof githubInstallationInventorySchema
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
  readonly latestScanSafeErrorCode: string | null;
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

export interface PublicRepositoryScan {
  readonly id: string;
  readonly organisationId: string;
  readonly repositoryId: string;
  readonly requestedCommit: string | null;
  readonly status: 'queued' | 'running' | 'succeeded' | 'failed' | 'unsupported';
  readonly safeErrorCode: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}
