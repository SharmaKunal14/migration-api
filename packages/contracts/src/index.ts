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

export const migrationAcquisitionResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    migrationRunId: uuidSchema,
    approvalId: uuidSchema,
    status: z.enum(['succeeded', 'stale', 'unsupported', 'failed']),
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
  })
  .strict()
  .superRefine((result, context) => {
    const succeeded = result.status === 'succeeded';
    if (succeeded !== (result.snapshot !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful migration acquisition requires snapshot evidence.',
        path: ['status'],
      });
    }
    if (succeeded === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only unsuccessful migration acquisition requires a safe error code.',
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

export const migrationSpecificationReviewRequestSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
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

const policyVersionSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/u);

export const migrationApprovalPatchPolicySchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    allowedPaths: z.array(repositoryRelativePathSchema).min(1).max(500),
    allowedChangeCategories: z
      .array(
        z.enum([
          'dependency_manifest',
          'lockfile',
          'direct_usage',
          'indirect_usage',
          'test',
        ]),
      )
      .min(1)
      .max(5),
    maxChangedFiles: z.number().int().min(1).max(100),
    maxPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    maxAddedLines: z.number().int().min(1).max(10_000),
    maxDeletedLines: z.number().int().min(0).max(10_000),
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.allowedPaths).size !== policy.allowedPaths.length) {
      context.addIssue({
        code: 'custom',
        message: 'Allowed patch paths must be unique.',
        path: ['allowedPaths'],
      });
    }
    if (
      new Set(policy.allowedChangeCategories).size !==
      policy.allowedChangeCategories.length
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Allowed change categories must be unique.',
        path: ['allowedChangeCategories'],
      });
    }
  });

export const verificationProfileNameSchema = z.enum([
  'typescript_static',
  'typescript_unit',
]);

export const migrationApprovalVerificationProfileSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    profiles: z
      .array(
        z
          .object({
            profile: verificationProfileNameSchema,
            availability: z.enum(['available', 'unavailable']),
            commandIds: z
              .array(
                z
                  .string()
                  .min(1)
                  .max(100)
                  .regex(/^[a-z][a-z0-9._-]{0,99}$/u),
              )
              .max(20),
          })
          .strict(),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((verification, context) => {
    const profiles = verification.profiles.map(profile => profile.profile);
    if (new Set(profiles).size !== profiles.length) {
      context.addIssue({
        code: 'custom',
        message: 'Verification profiles must be unique.',
        path: ['profiles'],
      });
    }
    for (const [index, profile] of verification.profiles.entries()) {
      if (
        (profile.availability === 'available' && profile.commandIds.length === 0) ||
        (profile.availability === 'unavailable' && profile.commandIds.length > 0)
      ) {
        context.addIssue({
          code: 'custom',
          message:
            'Only available verification profiles may authorize command identifiers.',
          path: ['profiles', index, 'commandIds'],
        });
      }
      if (new Set(profile.commandIds).size !== profile.commandIds.length) {
        context.addIssue({
          code: 'custom',
          message: 'Verification command identifiers must be unique.',
          path: ['profiles', index, 'commandIds'],
        });
      }
    }
  });

export const migrationApprovalAuthoritySchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    approvalContractVersion: z.literal('1.0'),
    agentPolicyVersion: policyVersionSchema,
    toolRegistryVersion: policyVersionSchema,
    patchPolicyVersion: policyVersionSchema,
    patchPolicy: migrationApprovalPatchPolicySchema,
    verificationPolicyVersion: policyVersionSchema,
    verificationProfile: migrationApprovalVerificationProfileSchema,
    publicationPolicyVersion: policyVersionSchema,
    openaiProcessingPolicyVersion: policyVersionSchema,
    openaiProcessingMode: z.enum(['default_controls', 'verified_zdr']),
  })
  .strict();

const migrationPatchBindingSchema = z
  .object({
    migrationRunId: uuidSchema,
    approvalId: uuidSchema,
    baseCommitSha: commitShaSchema,
    snapshotDigest: sha256Schema,
    migrationSpecification: z
      .object({
        id: uuidSchema,
        revision: z.number().int().positive(),
        digest: sha256Schema,
      })
      .strict(),
    impactReport: z
      .object({
        id: uuidSchema,
        revision: z.number().int().positive(),
        digest: sha256Schema,
      })
      .strict(),
  })
  .strict();

const migrationChangeCategorySchema = z.enum([
  'dependency_manifest',
  'lockfile',
  'direct_usage',
  'indirect_usage',
  'test',
]);

const migrationPlanFileSchema = z
  .object({
    path: repositoryRelativePathSchema,
    operation: z.enum(['create', 'modify', 'delete']),
    changeCategory: migrationChangeCategorySchema,
    rationale: z.string().min(1).max(2_000),
    evidenceChangeIds: z
      .array(z.string().regex(/^[A-Z][A-Z0-9._-]{0,63}$/u))
      .min(1)
      .max(50),
    transformationIds: z.array(z.string().regex(/^[A-Z][A-Z0-9._-]{0,63}$/u)).max(50),
  })
  .strict()
  .superRefine((file, context) => {
    if (new Set(file.evidenceChangeIds).size !== file.evidenceChangeIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Evidence change identifiers must be unique per file.',
        path: ['evidenceChangeIds'],
      });
    }
    if (new Set(file.transformationIds).size !== file.transformationIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'Transformation identifiers must be unique per file.',
        path: ['transformationIds'],
      });
    }
  });

export const migrationExecutionPlanSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    binding: migrationPatchBindingSchema,
    attemptNumber: z.number().int().min(1).max(10),
    trust: z
      .object({
        status: z.literal('proposed'),
        generatedBy: z.literal('migration_agent'),
      })
      .strict(),
    summary: z.string().min(1).max(4_000),
    files: z.array(migrationPlanFileSchema).min(1).max(100),
    unresolved: z
      .array(
        z
          .object({
            code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
            summary: z.string().min(1).max(2_000),
          })
          .strict(),
      )
      .max(50),
    verificationProfiles: z
      .array(z.enum(['typescript_static', 'typescript_unit']))
      .max(2),
  })
  .strict()
  .superRefine((plan, context) => {
    const paths = plan.files.map(file => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        message: 'A migration plan may contain each path only once.',
        path: ['files'],
      });
    }
    const unresolvedCodes = plan.unresolved.map(item => item.code);
    if (new Set(unresolvedCodes).size !== unresolvedCodes.length) {
      context.addIssue({
        code: 'custom',
        message: 'Unresolved item codes must be unique.',
        path: ['unresolved'],
      });
    }
    if (new Set(plan.verificationProfiles).size !== plan.verificationProfiles.length) {
      context.addIssue({
        code: 'custom',
        message: 'Verification profiles must be unique.',
        path: ['verificationProfiles'],
      });
    }
  });

const migrationPatchFileSchema = z
  .object({
    path: repositoryRelativePathSchema,
    operation: z.enum(['create', 'modify', 'delete']),
    changeCategory: migrationChangeCategorySchema,
    beforeDigest: sha256Schema.nullable(),
    afterDigest: sha256Schema.nullable(),
    hunkCount: z.number().int().min(1).max(1_000),
    addedLines: z.number().int().nonnegative().max(10_000),
    deletedLines: z.number().int().nonnegative().max(10_000),
  })
  .strict()
  .superRefine((file, context) => {
    const validDigests =
      (file.operation === 'create' &&
        file.beforeDigest === null &&
        file.afterDigest !== null) ||
      (file.operation === 'modify' &&
        file.beforeDigest !== null &&
        file.afterDigest !== null &&
        file.beforeDigest !== file.afterDigest) ||
      (file.operation === 'delete' &&
        file.beforeDigest !== null &&
        file.afterDigest === null);
    if (!validDigests) {
      context.addIssue({
        code: 'custom',
        message: 'File digests must match the declared patch operation.',
        path: ['operation'],
      });
    }
    if (
      (file.operation === 'create' && file.deletedLines !== 0) ||
      (file.operation === 'delete' && file.addedLines !== 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Created files cannot delete lines and deleted files cannot add lines.',
        path: ['operation'],
      });
    }
  });

export const migrationPatchManifestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    proposalStatus: z.literal('unvalidated'),
    binding: migrationPatchBindingSchema,
    attemptNumber: z.number().int().min(1).max(10),
    planDigest: sha256Schema,
    patchDigest: sha256Schema,
    patchBytes: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    changedFiles: z.number().int().min(1).max(100),
    addedLines: z.number().int().nonnegative().max(10_000),
    deletedLines: z.number().int().nonnegative().max(10_000),
    files: z.array(migrationPatchFileSchema).min(1).max(100),
  })
  .strict()
  .superRefine((manifest, context) => {
    const paths = manifest.files.map(file => file.path);
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: 'custom',
        message: 'A patch may contain each path only once.',
        path: ['files'],
      });
    }
    const addedLines = manifest.files.reduce(
      (total, file) => total + file.addedLines,
      0,
    );
    const deletedLines = manifest.files.reduce(
      (total, file) => total + file.deletedLines,
      0,
    );
    if (
      manifest.changedFiles !== manifest.files.length ||
      manifest.addedLines !== addedLines ||
      manifest.deletedLines !== deletedLines
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Patch totals must equal the bounded per-file totals.',
        path: ['changedFiles'],
      });
    }
  });

const patchPolicyCheckSchema = z
  .object({
    check: z.enum([
      'base_binding',
      'diff_structure',
      'path_safety',
      'allowed_paths',
      'forbidden_paths',
      'binary_files',
      'change_budget',
    ]),
    outcome: z.enum(['passed', 'failed']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
  })
  .strict()
  .superRefine((check, context) => {
    if (
      (check.outcome === 'passed' && check.safeErrorCode !== null) ||
      (check.outcome === 'failed' && check.safeErrorCode === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed policy checks require a safe error code.',
        path: ['safeErrorCode'],
      });
    }
  });

export const migrationPatchValidationResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    binding: migrationPatchBindingSchema,
    attemptNumber: z.number().int().min(1).max(10),
    planDigest: sha256Schema,
    patchDigest: sha256Schema,
    policyVersion: policyVersionSchema,
    policyDigest: sha256Schema,
    status: z.enum(['accepted', 'rejected']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    checks: z.array(patchPolicyCheckSchema).min(7).max(7),
  })
  .strict()
  .superRefine((result, context) => {
    const checkNames = result.checks.map(check => check.check);
    if (new Set(checkNames).size !== checkNames.length) {
      context.addIssue({
        code: 'custom',
        message: 'Every patch policy check must appear exactly once.',
        path: ['checks'],
      });
    }
    const hasFailure = result.checks.some(check => check.outcome === 'failed');
    if (
      (result.status === 'accepted' && (hasFailure || result.safeErrorCode !== null)) ||
      (result.status === 'rejected' && (!hasFailure || result.safeErrorCode === null))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Patch validation status must match its policy check outcomes.',
        path: ['status'],
      });
    }
  });

export const migrationAgentCheckpointSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    binding: migrationPatchBindingSchema,
    attemptNumber: z.number().int().min(1).max(10),
    sequence: z.number().int().min(1).max(100),
    phase: z.enum(['context', 'planning', 'patching']),
    lastActionSequence: z.number().int().nonnegative().max(1_000),
    remainingBudget: z
      .object({
        modelCalls: z.number().int().nonnegative().max(20),
        toolCalls: z.number().int().nonnegative().max(200),
        iterations: z.number().int().nonnegative().max(100),
      })
      .strict(),
    planDigest: sha256Schema.nullable(),
    patchDigest: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    const minimumSequence = (checkpoint.attemptNumber - 1) * 3 + 1;
    const maximumSequence = checkpoint.attemptNumber * 3;
    if (
      checkpoint.sequence < minimumSequence ||
      checkpoint.sequence > maximumSequence
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Checkpoint sequence must use its attempt global range.',
        path: ['sequence'],
      });
    }
    if (
      checkpoint.phase === 'context' &&
      (checkpoint.planDigest !== null || checkpoint.patchDigest !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Context checkpoints cannot claim a plan or patch proposal.',
        path: ['planDigest'],
      });
    }
    if (checkpoint.phase !== 'patching' && checkpoint.patchDigest !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Only patching checkpoints may bind a patch proposal.',
        path: ['patchDigest'],
      });
    }
    if (checkpoint.phase === 'patching' && checkpoint.planDigest === null) {
      context.addIssue({
        code: 'custom',
        message: 'Patching checkpoints must remain bound to a migration plan.',
        path: ['planDigest'],
      });
    }
  });

export function migrationAgentCheckpointSequence(
  attemptNumber: number,
  localSequence: number,
): number {
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > 10 ||
    !Number.isSafeInteger(localSequence) ||
    localSequence < 1 ||
    localSequence > 3
  ) {
    throw new Error('The migration-agent checkpoint sequence is invalid.');
  }
  return (attemptNumber - 1) * 3 + localSequence;
}

const migrationAgentImpactFileSchema = z
  .object({
    path: repositoryRelativePathSchema,
    classification: migrationChangeCategorySchema,
    symbols: z.array(z.string().min(1).max(512)).max(100),
    expectedChanges: z.array(z.string().min(1).max(1_024)).max(50),
  })
  .strict();

const migrationRepairCommandEvidenceSchema = z
  .object({
    commandId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9._-]{0,99}$/u),
    status: z.enum(['passed', 'failed', 'skipped', 'timed_out', 'policy_rejected']),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(60 * 60 * 1_000),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  })
  .strict();

export const migrationAgentInputArtifactSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    binding: migrationPatchBindingSchema,
    attemptNumber: z.number().int().min(1).max(10),
    snapshot: z
      .object({
        objectKey: z.string().min(1).max(1_024),
        digest: sha256Schema,
      })
      .strict(),
    migrationSpecification: migrationSpecificationSchema,
    impact: z
      .object({
        outcome: z.literal('affected'),
        affectedFiles: z.array(migrationAgentImpactFileSchema).min(1).max(500),
        risk: z.enum(['low', 'medium', 'high', 'unknown']),
        uncertainties: z
          .array(
            z
              .object({
                code: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
                summary: z.string().min(1).max(2_000),
              })
              .strict(),
          )
          .max(50),
      })
      .strict(),
    authority: z
      .object({
        agentPolicyVersion: policyVersionSchema,
        toolRegistryVersion: policyVersionSchema,
        patchPolicyVersion: policyVersionSchema,
        patchPolicy: migrationApprovalPatchPolicySchema,
        patchPolicyDigest: sha256Schema,
      })
      .strict(),
    repair: z
      .object({
        previousPatchAttemptId: uuidSchema,
        previousPatchDigest: sha256Schema,
        previousPatch: z
          .string()
          .min(1)
          .max(1024 * 1024),
        verification: z
          .object({
            outcome: z.literal('failed'),
            safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
            commands: z.array(migrationRepairCommandEvidenceSchema).min(1).max(20),
          })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.snapshot.digest !== input.binding.snapshotDigest) {
      context.addIssue({
        code: 'custom',
        message: 'The migration snapshot must match the approved binding.',
        path: ['snapshot', 'digest'],
      });
    }
  });

export const migrationAgentPreparedInputSchema = z
  .object({
    status: z.literal('ready'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    migrationRunId: uuidSchema,
    attemptNumber: z.number().int().min(1).max(10),
    inputObjectKey: z.string().min(1).max(1_024),
    inputDigest: sha256Schema,
    resultObjectKey: z.string().min(1).max(1_024),
  })
  .strict();

export const migrationAgentProposedEditSchema = z
  .object({
    path: repositoryRelativePathSchema,
    operation: z.enum(['create', 'modify', 'delete']),
    changeCategory: migrationChangeCategorySchema,
    content: z
      .string()
      .max(1024 * 1024)
      .nullable(),
  })
  .strict()
  .superRefine((edit, context) => {
    if ((edit.operation === 'delete') !== (edit.content === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only deleted files may omit replacement content.',
        path: ['content'],
      });
    }
    if (edit.content?.includes('\u0000')) {
      context.addIssue({
        code: 'custom',
        message: 'Patch content must be text.',
        path: ['content'],
      });
    }
  });

const migrationAgentActionSchema = z
  .object({
    sequence: z.number().int().positive().max(40),
    toolName: z.enum([
      'list_repository_files',
      'read_repository_file',
      'search_repository',
      'inspect_manifest',
      'inspect_typescript',
    ]),
    path: repositoryRelativePathSchema.nullable(),
    status: z.literal('succeeded'),
    safeErrorCode: z.null(),
    inputDigest: sha256Schema,
    outputDigest: sha256Schema,
  })
  .strict();

export const migrationAgentResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    migrationRunId: uuidSchema,
    attemptNumber: z.number().int().min(1).max(10),
    inputDigest: sha256Schema,
    status: z.enum(['succeeded', 'rejected', 'failed']),
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
        modelCalls: z.number().int().nonnegative().max(6),
        toolCalls: z.number().int().nonnegative().max(40),
        iterations: z.number().int().nonnegative().max(6),
        inputTokens: z.number().int().nonnegative().max(120_000),
        outputTokens: z.number().int().nonnegative().max(24_000),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 60 * 1_000),
      })
      .strict(),
    actions: z.array(migrationAgentActionSchema).max(40),
    plan: migrationExecutionPlanSchema.nullable(),
    patch: z
      .string()
      .min(1)
      .max(1024 * 1024)
      .nullable(),
    manifest: migrationPatchManifestSchema.nullable(),
    validation: migrationPatchValidationResultSchema.nullable(),
    checkpoints: z.array(migrationAgentCheckpointSchema).max(3),
  })
  .strict()
  .superRefine((result, context) => {
    const hasArtifacts =
      result.plan !== null &&
      result.patch !== null &&
      result.manifest !== null &&
      result.validation !== null &&
      result.checkpoints.length >= 2;
    if (result.status === 'failed' && hasArtifacts) {
      context.addIssue({
        code: 'custom',
        message: 'Failed migration-agent results cannot contain patch artifacts.',
        path: ['status'],
      });
    }
    if (result.status !== 'failed' && !hasArtifacts) {
      context.addIssue({
        code: 'custom',
        message: 'Completed migration-agent results require all patch artifacts.',
        path: ['plan'],
      });
    }
    if (
      (result.status === 'succeeded') !==
      (result.validation?.status === 'accepted')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Only accepted patch validation may produce success.',
        path: ['validation', 'status'],
      });
    }
    if ((result.status === 'rejected') !== (result.validation?.status === 'rejected')) {
      context.addIssue({
        code: 'custom',
        message: 'Rejected results require rejected patch validation.',
        path: ['validation', 'status'],
      });
    }
    if ((result.status === 'succeeded') === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only unsuccessful migration-agent results require a safe error.',
        path: ['safeErrorCode'],
      });
    }
  });

export const migrationApprovalAcknowledgementsSchema = z
  .object({
    sourceProcessing: z.literal(true),
    verificationExecution: z.literal(true),
    draftPullRequest: z.literal(true),
    humanReviewRequired: z.literal(true),
  })
  .strict();

export const createMigrationApprovalRequestSchema = z
  .object({
    expectedCandidateVersion: z.number().int().positive(),
    expectedRepositorySnapshotId: uuidSchema,
    expectedBaseCommitSha: commitShaSchema,
    expectedSnapshotDigest: sha256Schema,
    expectedSpecificationRevision: z.number().int().positive(),
    expectedSpecificationDigest: sha256Schema,
    expectedImpactReportId: uuidSchema,
    expectedImpactReportRevision: z.number().int().positive(),
    expectedImpactReportDigest: sha256Schema,
    renderedCopyDigest: sha256Schema,
    acknowledgements: migrationApprovalAcknowledgementsSchema,
  })
  .strict();

export const migrationWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    migrationRunId: uuidSchema,
    candidateId: uuidSchema,
    approvalId: uuidSchema,
    repositoryId: uuidSchema,
    correlationId: uuidSchema,
    expectedAttempt: z.number().int().min(1).max(10),
    expectedVersion: z.number().int().positive(),
  })
  .strict();

export const verificationTerminalOutcomeSchema = z.enum([
  'passed',
  'failed',
  'partial',
  'unavailable',
  'timed_out',
  'policy_rejected',
  'infrastructure_failed',
]);

const verificationArtifactReferenceSchema = z
  .object({
    objectKey: z.string().min(1).max(1_024),
    digest: sha256Schema,
    bytes: z
      .number()
      .int()
      .min(1)
      .max(10 * 1024 * 1024),
  })
  .strict();

export const migrationVerificationPreparedInputSchema = z
  .object({
    status: z.literal('ready'),
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    migrationRunId: uuidSchema,
    approvalId: uuidSchema,
    verificationAttemptId: uuidSchema,
    attemptNumber: z.number().int().min(1).max(10),
    patchAttemptId: uuidSchema,
    baseCommitSha: commitShaSchema,
    snapshot: z
      .object({
        artifactId: uuidSchema,
        objectKey: z.string().min(1).max(1_024),
        digest: sha256Schema,
        bytes: z
          .number()
          .int()
          .min(1)
          .max(256 * 1024 * 1024),
      })
      .strict(),
    patch: z
      .object({
        artifactId: uuidSchema,
        objectKey: z.string().min(1).max(1_024),
        digest: sha256Schema,
        bytes: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
        validationArtifactId: uuidSchema,
        validationObjectKey: z.string().min(1).max(1_024),
        validationDigest: sha256Schema,
      })
      .strict(),
    authority: z
      .object({
        verificationPolicyVersion: policyVersionSchema,
        verificationProfile: migrationApprovalVerificationProfileSchema,
        verificationProfileDigest: sha256Schema,
      })
      .strict(),
  })
  .strict();

export const migrationVerificationWorkItemSchema =
  migrationVerificationPreparedInputSchema.extend({
    transfers: z
      .object({
        snapshotDownloadUrl: z.url().max(4_096),
        patchDownloadUrl: z.url().max(4_096),
        resultUploadUrl: z.url().max(4_096),
        stdoutUploadUrl: z.url().max(4_096),
        stderrUploadUrl: z.url().max(4_096),
        resultObjectKey: z.string().min(1).max(1_024),
        stdoutObjectKey: z.string().min(1).max(1_024),
        stderrObjectKey: z.string().min(1).max(1_024),
        artifactBucket: z.string().min(3).max(63),
        artifactKmsKeyArn: z
          .string()
          .regex(/^arn:aws[a-zA-Z-]*:kms:[^:]+:\d{12}:key\/[A-Za-z0-9-]+$/u),
        awsRegion: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u),
        approvedRegistryUrl: z.url().max(2_048),
      })
      .strict(),
  });

export const migrationVerificationWorkItemReferenceSchema = z
  .object({
    downloadUrl: z.url().max(4_096),
    digest: sha256Schema,
    bytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1024),
    artifactBucket: z.string().min(3).max(63),
    awsRegion: z.string().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u),
  })
  .strict();

export const migrationVerificationDispatchSchema =
  migrationVerificationWorkItemSchema.extend({
    dispatch: migrationVerificationWorkItemReferenceSchema,
  });

const verificationCommandResultSchema = z
  .object({
    commandId: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9._-]{0,99}$/u),
    status: z.enum(['passed', 'failed', 'skipped', 'timed_out', 'policy_rejected']),
    exitCode: z.number().int().min(0).max(255).nullable(),
    signal: z.string().min(1).max(32).nullable(),
    durationMs: z
      .number()
      .int()
      .nonnegative()
      .max(60 * 60 * 1_000),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.status === 'passed' &&
      (result.exitCode !== 0 || result.signal !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Passed verification commands require exit code zero and no signal.',
        path: ['exitCode'],
      });
    }
    if (
      result.status === 'failed' &&
      (result.exitCode === null || result.exitCode === 0) &&
      result.signal === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Failed verification commands require a non-zero exit code or signal.',
        path: ['exitCode'],
      });
    }
    if (
      ['timed_out', 'policy_rejected', 'skipped'].includes(result.status) &&
      result.exitCode !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Commands that did not complete normally cannot report an exit code.',
        path: ['exitCode'],
      });
    }
    if (result.exitCode !== null && result.signal !== null) {
      context.addIssue({
        code: 'custom',
        message: 'A process result cannot report both an exit code and a signal.',
        path: ['signal'],
      });
    }
  });

export const migrationVerificationResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    migrationRunId: uuidSchema,
    approvalId: uuidSchema,
    verificationAttemptId: uuidSchema,
    attemptNumber: z.number().int().min(1).max(10),
    patchAttemptId: uuidSchema,
    baseCommitSha: commitShaSchema,
    snapshotDigest: sha256Schema,
    patchDigest: sha256Schema,
    patchValidationDigest: sha256Schema,
    verificationPolicyVersion: policyVersionSchema,
    verificationProfileDigest: sha256Schema,
    outcome: verificationTerminalOutcomeSchema,
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    commands: z.array(verificationCommandResultSchema).max(20),
    artifacts: z
      .object({
        stdout: verificationArtifactReferenceSchema.nullable(),
        stderr: verificationArtifactReferenceSchema.nullable(),
      })
      .strict(),
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.outcome === 'passed') !== (result.safeErrorCode === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only passed verification may omit a safe error code.',
        path: ['safeErrorCode'],
      });
    }
    if (
      result.outcome === 'passed' &&
      (result.commands.length === 0 ||
        result.commands.some(command => command.status !== 'passed'))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Passed verification requires every selected command to pass.',
        path: ['commands'],
      });
    }
    const requiredCommandStatus: Partial<
      Record<
        z.infer<typeof verificationTerminalOutcomeSchema>,
        z.infer<typeof verificationCommandResultSchema>['status']
      >
    > = {
      failed: 'failed',
      timed_out: 'timed_out',
      policy_rejected: 'policy_rejected',
    };
    const requiredStatus = requiredCommandStatus[result.outcome];
    if (
      requiredStatus !== undefined &&
      !result.commands.some(command => command.status === requiredStatus)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Verification outcome ${result.outcome} requires a matching command result.`,
        path: ['commands'],
      });
    }
    if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Verification cannot complete before it starts.',
        path: ['completedAt'],
      });
    }
  });

export const publicationAttemptStatusSchema = z.enum([
  'queued',
  'validating',
  'publishing',
  'reconciling',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
]);

const publicationSafeErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u);

function isValidGitReferenceName(reference: string): boolean {
  const forbiddenCharacters = new Set([' ', '~', '^', ':', '?', '*', '[', '\\']);
  const components = reference.split('/');
  for (const character of reference) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x20 || codePoint === 0x7f || forbiddenCharacters.has(character)) {
      return false;
    }
  }
  return (
    reference !== '@' &&
    !reference.startsWith('/') &&
    !reference.endsWith('/') &&
    !reference.endsWith('.') &&
    !reference.includes('//') &&
    !reference.includes('..') &&
    !reference.includes('@{') &&
    components.every(component => component.length > 0 && !component.endsWith('.lock'))
  );
}

const publicationAttemptBindingFields = {
  schemaVersion: z.literal('1.0'),
  organisationId: uuidSchema,
  migrationRunId: uuidSchema,
  approvalId: uuidSchema,
  repositoryId: uuidSchema,
  installationId: uuidSchema,
  githubRepositoryId: githubIdSchema,
  verificationAttemptId: uuidSchema,
  verificationResultId: uuidSchema,
  verificationOutcome: z.literal('passed'),
  patchAttemptId: uuidSchema,
  patchArtifactId: uuidSchema,
  patchDigest: sha256Schema,
  patchValidationArtifactId: uuidSchema,
  patchValidationDigest: sha256Schema,
  baseBranch: z
    .string()
    .min(1)
    .max(255)
    .refine(branch => isValidGitReferenceName(branch), {
      message: 'Base branch must be a valid bounded Git reference name.',
    }),
  baseCommitSha: commitShaSchema,
  headBranch: z.string().min(1).max(255),
  publicationPolicyVersion: policyVersionSchema,
} as const;

export const publicationAttemptBindingSchema = z
  .object(publicationAttemptBindingFields)
  .strict()
  .superRefine((binding, context) => {
    if (binding.headBranch !== `migration-api/run-${binding.migrationRunId}`) {
      context.addIssue({
        code: 'custom',
        message: 'Publication branch must be derived from the migration run.',
        path: ['headBranch'],
      });
    }
  });

export const githubPublicationAccessSchema = z
  .object({
    status: z.literal('ready'),
    githubRepositoryId: githubIdSchema,
    owner: z.string().min(1).max(255),
    name: z.string().min(1).max(255),
    baseBranch: z.string().min(1).max(255),
    headCommitSha: commitShaSchema,
  })
  .strict();

export const githubPublicationAccessResultSchema = z.discriminatedUnion('status', [
  githubPublicationAccessSchema,
  z
    .object({
      status: z.literal('denied'),
      safeErrorCode: z.literal('GITHUB_PUBLICATION_ACCESS_DENIED'),
    })
    .strict(),
]);

export const githubDraftPublicationResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('published'),
      githubRepositoryId: githubIdSchema,
      headBranch: z.string().min(1).max(255),
      baseBranch: z.string().min(1).max(255),
      baseCommitSha: commitShaSchema,
      commitSha: commitShaSchema,
      pullRequestNumber: z.number().int().positive(),
      pullRequestNodeId: z.string().min(1).max(255),
      pullRequestUrl: z
        .url()
        .regex(
          /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u,
        ),
      state: z.literal('open'),
      isDraft: z.literal(true),
    })
    .strict(),
  z
    .object({
      status: z.literal('denied'),
      safeErrorCode: z.enum([
        'GITHUB_PUBLICATION_ACCESS_DENIED',
        'MIGRATION_PUBLICATION_BASE_STALE',
        'MIGRATION_PUBLICATION_CONFLICT',
      ]),
    })
    .strict(),
]);

export const publicationAttemptSchema = z
  .object({
    ...publicationAttemptBindingFields,
    id: uuidSchema,
    status: publicationAttemptStatusSchema,
    attemptCount: z.number().int().min(0).max(20),
    safeErrorCode: publicationSafeErrorCodeSchema.nullable(),
    idempotencyKey: z.string().min(1).max(128),
    correlationId: uuidSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((attempt, context) => {
    if (attempt.headBranch !== `migration-api/run-${attempt.migrationRunId}`) {
      context.addIssue({
        code: 'custom',
        message: 'Publication branch must be derived from the migration run.',
        path: ['headBranch'],
      });
    }
    if (attempt.idempotencyKey !== `publication:${attempt.migrationRunId}`) {
      context.addIssue({
        code: 'custom',
        message: 'Publication idempotency key must be derived from the migration run.',
        path: ['idempotencyKey'],
      });
    }
    const terminal = ['succeeded', 'failed', 'stale', 'cancelled'].includes(
      attempt.status,
    );
    if (terminal !== (attempt.completedAt !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only terminal publication attempts may have a completion time.',
        path: ['completedAt'],
      });
    }
    const failed = ['failed', 'stale'].includes(attempt.status);
    if (failed !== (attempt.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Failed or stale publication attempts require a safe error code.',
        path: ['safeErrorCode'],
      });
    }
    if (attempt.status === 'queued' && attempt.attemptCount !== 0) {
      context.addIssue({
        code: 'custom',
        message: 'Queued publication attempts cannot have started.',
        path: ['attemptCount'],
      });
    }
    if (
      !['queued', 'cancelled'].includes(attempt.status) &&
      (attempt.startedAt === null || attempt.attemptCount === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Started publication attempts require a start time and attempt.',
        path: ['startedAt'],
      });
    }
    if (
      attempt.completedAt !== null &&
      attempt.startedAt !== null &&
      Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Publication cannot complete before it starts.',
        path: ['completedAt'],
      });
    }
    if (Date.parse(attempt.updatedAt) < Date.parse(attempt.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Publication update time cannot precede creation.',
        path: ['updatedAt'],
      });
    }
    if (
      attempt.startedAt !== null &&
      Date.parse(attempt.startedAt) < Date.parse(attempt.createdAt)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Publication cannot start before it is created.',
        path: ['startedAt'],
      });
    }
    if (
      attempt.status === 'queued' &&
      (attempt.startedAt !== null || attempt.completedAt !== null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Queued publication attempts cannot have timestamps.',
        path: ['startedAt'],
      });
    }
  });

export const githubPublicationSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: uuidSchema,
    organisationId: uuidSchema,
    migrationRunId: uuidSchema,
    publicationAttemptId: uuidSchema,
    repositoryId: uuidSchema,
    githubRepositoryId: githubIdSchema,
    headBranch: z.string().min(1).max(255),
    baseBranch: z.string().min(1).max(255),
    baseCommitSha: commitShaSchema,
    commitSha: commitShaSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestNodeId: z.string().min(1).max(255),
    pullRequestUrl: z
      .url()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/u,
      ),
    state: z.enum(['open', 'closed', 'merged']),
    isDraft: z.boolean(),
    createdAt: z.iso.datetime(),
    lastReconciledAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((publication, context) => {
    if (publication.state === 'merged' && publication.isDraft) {
      context.addIssue({
        code: 'custom',
        message: 'A merged pull request cannot remain a draft.',
        path: ['isDraft'],
      });
    }
    if (Date.parse(publication.lastReconciledAt) < Date.parse(publication.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Publication reconciliation cannot precede creation.',
        path: ['lastReconciledAt'],
      });
    }
  });

export const publicationNotificationSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    id: uuidSchema,
    organisationId: uuidSchema,
    migrationRunId: uuidSchema,
    publicationId: uuidSchema,
    recipientUserId: uuidSchema,
    eventType: z.literal('draft_pr_created'),
    channel: z.enum(['in_app', 'email']),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/u),
    availableAt: z.iso.datetime(),
    attempts: z.number().int().min(0).max(10),
    deliveredAt: z.iso.datetime().nullable(),
    safeErrorCode: publicationSafeErrorCodeSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((notification, context) => {
    if (notification.deliveredAt !== null && notification.safeErrorCode !== null) {
      context.addIssue({
        code: 'custom',
        message: 'Delivered notifications cannot have an error.',
        path: ['safeErrorCode'],
      });
    }
    if (Date.parse(notification.availableAt) < Date.parse(notification.createdAt)) {
      context.addIssue({
        code: 'custom',
        message: 'Notification cannot become available before creation.',
        path: ['availableAt'],
      });
    }
  });

export const cancelMigrationRunRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reasonCode: z.literal('USER_REQUESTED'),
  })
  .strict();

export const revokeMigrationApprovalRequestSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reasonCode: z.literal('USER_REQUESTED'),
  })
  .strict();

export const impactAnalysisWorkflowInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    candidateId: uuidSchema,
    correlationId: uuidSchema,
  })
  .strict();

export const publicImpactAnalysisRequestSchema = z
  .object({
    candidateId: uuidSchema,
    correlationId: uuidSchema,
    status: z.literal('queued'),
  })
  .strict();

export const impactAnalysisPreparedInputSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    candidateId: uuidSchema,
    impactAnalysisRunId: uuidSchema,
    correlationId: uuidSchema,
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    repositorySnapshotId: uuidSchema,
    commitSha: commitShaSchema,
    snapshotObjectKey: z.string().min(1).max(1_024),
    snapshotDigest: sha256Schema,
    migrationSpecificationId: uuidSchema,
    inputObjectKey: z.string().min(1).max(1_024),
    inputDigest: sha256Schema,
    resultObjectKey: z.string().min(1).max(1_024),
    reportRevision: z.number().int().positive(),
    alreadySucceeded: z.boolean(),
  })
  .strict();

export const impactAnalysisInputArtifactSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    candidateId: uuidSchema,
    impactAnalysisRunId: uuidSchema,
    organisationId: uuidSchema,
    repositoryId: uuidSchema,
    repositorySnapshotId: uuidSchema,
    commitSha: commitShaSchema,
    snapshotObjectKey: z.string().min(1).max(1_024),
    snapshotDigest: sha256Schema,
    migrationSpecificationId: uuidSchema,
    migrationSpecification: migrationSpecificationSchema,
    reportRevision: z.number().int().positive(),
  })
  .strict();

const impactAnalysisActionSchema = z
  .object({
    sequence: z.number().int().positive().max(30),
    toolName: z.enum([
      'list_repository_files',
      'read_repository_file',
      'search_repository',
      'inspect_manifest',
      'inspect_typescript',
    ]),
    path: repositoryRelativePathSchema.nullable(),
    status: z.enum(['succeeded', 'rejected']),
    safeErrorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{2,63}$/u)
      .nullable(),
    inputDigest: sha256Schema,
    outputDigest: sha256Schema.nullable(),
  })
  .strict();

export const impactAnalysisResultSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    candidateId: uuidSchema,
    impactAnalysisRunId: uuidSchema,
    repositorySnapshotId: uuidSchema,
    snapshotDigest: sha256Schema,
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
        modelCalls: z.number().int().min(0).max(5),
        toolCalls: z.number().int().min(0).max(30),
        iterations: z.number().int().min(0).max(6),
        inputTokens: z.number().int().nonnegative().max(100_000),
        outputTokens: z.number().int().nonnegative().max(16_000),
        durationMs: z
          .number()
          .int()
          .nonnegative()
          .max(10 * 60 * 1_000),
      })
      .strict(),
    actions: z.array(impactAnalysisActionSchema).max(30),
    report: impactReportSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    const succeeded = result.status === 'succeeded';
    if (succeeded !== (result.report !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Successful impact analysis requires an impact report.',
        path: ['report'],
      });
    }
    if (succeeded === (result.safeErrorCode !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Only failed impact analysis requires a safe error code.',
        path: ['safeErrorCode'],
      });
    }
    if (
      result.report &&
      (result.report.candidateId !== result.candidateId ||
        result.report.repository.snapshotId !== result.repositorySnapshotId ||
        result.report.repository.snapshotDigest !== result.snapshotDigest)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Impact reports must remain bound to the analysed snapshot.',
        path: ['report', 'repository'],
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
export type MigrationApprovalPatchPolicy = z.infer<
  typeof migrationApprovalPatchPolicySchema
>;
export type MigrationApprovalVerificationProfile = z.infer<
  typeof migrationApprovalVerificationProfileSchema
>;
export type MigrationApprovalAuthority = z.infer<
  typeof migrationApprovalAuthoritySchema
>;
export type MigrationExecutionPlan = z.infer<typeof migrationExecutionPlanSchema>;
export type MigrationPatchManifest = z.infer<typeof migrationPatchManifestSchema>;
export type MigrationPatchValidationResult = z.infer<
  typeof migrationPatchValidationResultSchema
>;
export type MigrationAgentCheckpoint = z.infer<typeof migrationAgentCheckpointSchema>;
export type MigrationAgentInputArtifact = z.infer<
  typeof migrationAgentInputArtifactSchema
>;
export type MigrationAgentPreparedInput = z.infer<
  typeof migrationAgentPreparedInputSchema
>;
export type MigrationAgentProposedEdit = z.infer<
  typeof migrationAgentProposedEditSchema
>;
export type MigrationAgentResult = z.infer<typeof migrationAgentResultSchema>;
export type MigrationApprovalAcknowledgements = z.infer<
  typeof migrationApprovalAcknowledgementsSchema
>;
export type CreateMigrationApprovalRequest = z.infer<
  typeof createMigrationApprovalRequestSchema
>;
export type MigrationWorkflowInput = z.infer<typeof migrationWorkflowInputSchema>;
export type VerificationProfileName = z.infer<typeof verificationProfileNameSchema>;
export type VerificationTerminalOutcome = z.infer<
  typeof verificationTerminalOutcomeSchema
>;
export type MigrationVerificationPreparedInput = z.infer<
  typeof migrationVerificationPreparedInputSchema
>;
export type MigrationVerificationWorkItem = z.infer<
  typeof migrationVerificationWorkItemSchema
>;
export type MigrationVerificationWorkItemReference = z.infer<
  typeof migrationVerificationWorkItemReferenceSchema
>;
export type MigrationVerificationDispatch = z.infer<
  typeof migrationVerificationDispatchSchema
>;
export type MigrationVerificationResult = z.infer<
  typeof migrationVerificationResultSchema
>;
export type PublicationAttemptStatus = z.infer<typeof publicationAttemptStatusSchema>;
export type PublicationAttemptBinding = z.infer<typeof publicationAttemptBindingSchema>;
export type GithubPublicationAccess = z.infer<typeof githubPublicationAccessSchema>;
export type GithubPublicationAccessResult = z.infer<
  typeof githubPublicationAccessResultSchema
>;
export type PublicationAttempt = z.infer<typeof publicationAttemptSchema>;
export type GithubPublication = z.infer<typeof githubPublicationSchema>;
export type PublicationNotification = z.infer<typeof publicationNotificationSchema>;
export type CancelMigrationRunRequest = z.infer<typeof cancelMigrationRunRequestSchema>;
export type RevokeMigrationApprovalRequest = z.infer<
  typeof revokeMigrationApprovalRequestSchema
>;
export type ImpactAnalysisWorkflowInput = z.infer<
  typeof impactAnalysisWorkflowInputSchema
>;
export type PublicImpactAnalysisRequest = z.infer<
  typeof publicImpactAnalysisRequestSchema
>;
export type ImpactAnalysisPreparedInput = z.infer<
  typeof impactAnalysisPreparedInputSchema
>;
export type ImpactAnalysisInputArtifact = z.infer<
  typeof impactAnalysisInputArtifactSchema
>;
export type ImpactAnalysisResult = z.infer<typeof impactAnalysisResultSchema>;
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
export type MigrationAcquisitionResult = z.infer<
  typeof migrationAcquisitionResultSchema
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

export interface PublicMigrationSpecification {
  readonly id: string;
  readonly vendorReleaseId: string;
  readonly vendorName: string;
  readonly productIdentifier: string;
  readonly sourceCompatibility: string;
  readonly targetVersion: string;
  readonly trustState: 'draft' | 'reviewed' | 'vendor_verified';
  readonly revision: number;
  readonly evidenceDigest: string;
  readonly reviewedAt: string | null;
  readonly createdAt: string;
}

export interface PublicMigrationSpecificationReview {
  readonly specification: PublicMigrationSpecification;
  readonly matchedRepositories: number;
  readonly unmatchedRepositories: number;
}

export interface PublicMigrationSpecificationDetail extends PublicMigrationSpecification {
  readonly specification: MigrationSpecification;
}

export interface PublicMigrationCandidate {
  readonly id: string;
  readonly repositoryId: string;
  readonly repositoryFullName: string;
  readonly migrationSpecificationId: string;
  readonly packageName: string;
  readonly declaredRange: string;
  readonly resolvedVersion: string | null;
  readonly sourceCompatibility: string;
  readonly targetVersion: string;
  readonly specificationTrustState: 'reviewed' | 'vendor_verified';
  readonly status: 'open' | 'dismissed' | 'superseded' | 'resolved';
  readonly impact: PublicImpactReportSummary | null;
  readonly firstDetectedAt: string;
  readonly lastDetectedAt: string;
  readonly version: number;
}

export type ImpactReportFreshness = 'current' | 'stale';

export interface PublicImpactReportSummary {
  readonly id: string;
  readonly outcome: 'affected' | 'not_affected' | 'inconclusive';
  readonly riskCategory: 'low' | 'medium' | 'high' | 'unknown';
  readonly freshness: ImpactReportFreshness;
  readonly affectedFileCount: number;
  readonly uncertaintyCount: number;
  readonly analysedCommit: string;
  readonly createdAt: string;
}

export interface PublicVendorEvidenceItem {
  readonly sourceKey: string;
  readonly sourceKind:
    | 'package_registry_release'
    | 'migration_guide'
    | 'changelog'
    | 'api_definition'
    | 'sdk_repository_release';
  readonly canonicalUrl: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly retrievedAt: string;
}

export interface PublicMigrationCandidateImpactReport extends PublicImpactReportSummary {
  readonly snapshotDigest: string;
  readonly artifactDigest: string;
  readonly revision: number;
  readonly affectedFiles: ImpactReport['affectedFiles'];
  readonly unaffectedFiles: ImpactReport['unaffectedFiles'];
  readonly verification: ImpactReport['verification'];
  readonly uncertainties: ImpactReport['uncertainties'];
}

export interface PublicMigrationCandidateDetail {
  readonly candidate: PublicMigrationCandidate;
  readonly repository: {
    readonly id: string;
    readonly fullName: string;
    readonly snapshotId: string;
    readonly commitSha: string;
    readonly snapshotDigest: string;
    readonly snapshotCreatedAt: string;
  };
  readonly dependency: {
    readonly id: string;
    readonly packageName: string;
    readonly dependencyKind: 'dependency' | 'development' | 'optional' | 'peer';
    readonly manifestPath: string;
    readonly lockfilePath: string | null;
    readonly declaredRange: string;
    readonly resolvedVersion: string | null;
    readonly discoveryMethod: 'manifest' | 'npm_lockfile';
  };
  readonly specification: PublicMigrationSpecificationDetail;
  readonly vendorEvidence: PublicVendorEvidenceItem[];
  readonly impactReport: PublicMigrationCandidateImpactReport | null;
  readonly impactAnalysis: {
    readonly correlationId: string;
    readonly status: 'running' | 'succeeded' | 'failed';
    readonly safeErrorCode: string | null;
    readonly attempt: number;
    readonly startedAt: string;
    readonly completedAt: string | null;
  } | null;
  readonly approval: PublicMigrationApprovalPreview;
}

export interface PublicMigrationApprovalPreview {
  readonly eligible: boolean;
  readonly blockers: readonly string[];
  readonly renderedCopy: string;
  readonly renderedCopyDigest: string;
  readonly authority: MigrationApprovalAuthority;
}

export interface PublicMigrationApproval {
  readonly id: string;
  readonly candidateId: string;
  readonly repositoryId: string;
  readonly baseCommitSha: string;
  readonly approvedByRole: 'owner' | 'admin' | 'reviewer';
  readonly approvedAt: string;
}

export interface PublicMigrationRun {
  readonly id: string;
  readonly candidateId: string;
  readonly approvalId: string;
  readonly status:
    'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
  readonly currentStage:
    | 'queued'
    | 'revalidating'
    | 'acquiring'
    | 'planning'
    | 'patching'
    | 'verifying'
    | 'repairing'
    | 'publishing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'stale';
  readonly version: number;
  readonly createdAt: string;
}

export interface PublicMigrationRunEvent {
  readonly sequence: number;
  readonly eventType:
    | 'run_requested'
    | 'approval_validated'
    | 'stage_entered'
    | 'source_acquired'
    | 'cancellation_requested'
    | 'run_cancelled'
    | 'run_failed'
    | 'run_stale'
    | 'run_completed'
    | 'plan_created'
    | 'patch_proposed'
    | 'patch_validated'
    | 'verification_prepared'
    | 'verification_started'
    | 'verification_completed'
    | 'repair_requested'
    | 'publication_prepared'
    | 'publication_started'
    | 'publication_reconciled'
    | 'notification_queued';
  readonly status:
    'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stale';
  readonly stage:
    | 'queued'
    | 'revalidating'
    | 'acquiring'
    | 'planning'
    | 'patching'
    | 'verifying'
    | 'repairing'
    | 'publishing'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'stale';
  readonly safeErrorCode: string | null;
  readonly actorType: 'user' | 'system';
  readonly actorDisplayName: string | null;
  readonly createdAt: string;
}

export interface PublicMigrationRunApproval {
  readonly approvedByDisplayName: string | null;
  readonly approvedByRole: 'owner' | 'admin' | 'reviewer';
  readonly approvedAt: string;
  readonly revokedAt: string | null;
  readonly revokedByDisplayName: string | null;
  readonly revokedByRole: 'owner' | 'admin' | 'reviewer' | null;
  readonly revocationReasonCode: string | null;
}

export interface PublicMigrationRunSummary extends PublicMigrationRun {
  readonly repositoryFullName: string;
  readonly packageName: string;
  readonly baseCommitSha: string;
  readonly targetVersion: string;
  readonly safeErrorCode: string | null;
  readonly completedAt: string | null;
  readonly approval: PublicMigrationRunApproval;
}

export interface PublicMigrationRunDetail extends PublicMigrationRunSummary {
  readonly workflowExecutionArn: string | null;
  readonly cancellationRequestedAt: string | null;
  readonly events: readonly PublicMigrationRunEvent[];
  readonly verificationAttempts: readonly PublicMigrationVerificationAttempt[];
}

export interface PublicMigrationVerificationAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly patchAttemptId: string;
  readonly policyVersion: string;
  readonly profiles: readonly {
    readonly profile: VerificationProfileName;
    readonly availability: 'available' | 'unavailable';
    readonly commandIds: readonly string[];
  }[];
  readonly outcome: VerificationTerminalOutcome | null;
  readonly safeErrorCode: string | null;
  readonly commands: MigrationVerificationResult['commands'];
  readonly resultDigest: string | null;
  readonly stdoutDigest: string | null;
  readonly stderrDigest: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface PublicMigrationPatchAttempt {
  readonly id: string;
  readonly attemptNumber: number;
  readonly parentPatchAttemptId: string | null;
  readonly status: 'accepted' | 'rejected' | 'failed';
  readonly safeErrorCode: string | null;
  readonly summaryCode: string;
  readonly changedFiles: number;
  readonly addedLines: number;
  readonly deletedLines: number;
  readonly patchBytes: number;
  readonly selected: boolean;
  readonly createdAt: string;
}

export interface PublicMigrationPatchReview {
  readonly baseCommitSha: string;
  readonly repositoryModifiedRemotely: false;
  readonly plan: MigrationExecutionPlan;
  readonly patch: string;
  readonly manifest: MigrationPatchManifest;
  readonly validation: MigrationPatchValidationResult;
  readonly policy: MigrationApprovalPatchPolicy;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly sourceUrl: string;
    readonly digest: string;
    readonly summary: string;
  }[];
  readonly attempts: readonly PublicMigrationPatchAttempt[];
}

export interface PublicMigrationApprovalResult {
  readonly approval: PublicMigrationApproval;
  readonly run: PublicMigrationRun;
}
