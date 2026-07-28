import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationAgentInputArtifactSchema,
  migrationAgentProposedEditSchema,
  migrationAgentResultSchema,
  migrationExecutionPlanSchema,
  type MigrationAgentInputArtifact,
  type MigrationExecutionPlan,
} from '@migration/contracts';
import {
  buildAndValidatePatch,
  parsePatchPaths,
  type PatchBuildResult,
} from '@migration/patch-policy';

const binding = {
  migrationRunId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
  approvalId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
  baseCommitSha: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  migrationSpecification: {
    id: 'e4e2d9db-bd1c-4eef-b685-231128724583',
    revision: 1,
    digest: 'c'.repeat(64),
  },
  impactReport: {
    id: '12a906c7-f7df-4c65-9137-70bcf17eec86',
    revision: 1,
    digest: 'd'.repeat(64),
  },
} as const;

const input = migrationAgentInputArtifactSchema.parse({
  schemaVersion: '1.0',
  organisationId: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
  repositoryId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
  binding,
  attemptNumber: 1,
  snapshot: {
    objectKey:
      'env/development/org/07a17d5a-820d-4199-93d9-4e71b1c2d4f5/run/6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624/input/source/snapshot.tar.gz',
    digest: binding.snapshotDigest,
  },
  migrationSpecification: {
    schemaVersion: '1.0',
    vendor: { slug: 'orbitchat', name: 'OrbitChat' },
    product: { ecosystem: 'npm', identifier: '@orbitchat/sdk' },
    sourceCompatibility: '1.x',
    targetVersion: '2.0.0',
    changes: [
      {
        changeId: 'C-01',
        category: 'request',
        summary: 'messages.send becomes messages.create',
        certainty: 'vendor_confirmed',
        evidenceIds: ['C-01'],
        transformations: [
          {
            kind: 'rename_symbol',
            before: 'messages.send',
            after: 'messages.create',
            condition: null,
          },
        ],
      },
    ],
    evidence: [
      {
        evidenceId: 'C-01',
        sourceKey: 'migration_guide',
        sourceUrl: 'https://docs.orbitchat.example/migrate-v2',
        digest: 'e'.repeat(64),
        summary: 'Reviewed method rename evidence.',
      },
    ],
    preconditions: ['The installed package resolves to an OrbitChat 1.x release.'],
    verificationRecommendations: ['typescript_static'],
    uncertainties: [],
    trust: {
      status: 'reviewed',
      generatedBy: 'change_intelligence_agent',
      reviewedAt: '2026-07-26T06:41:47.620Z',
    },
    revision: 1,
    generatedAt: '2026-07-26T05:47:25.267Z',
  },
  impact: {
    outcome: 'affected',
    affectedFiles: [
      {
        path: 'src/orbitchat-client.ts',
        classification: 'direct_usage',
        symbols: ['sendSupportMessage'],
        expectedChanges: ['Use messages.create.'],
      },
    ],
    risk: 'medium',
    uncertainties: [],
  },
  authority: {
    agentPolicyVersion: 'migration-agent-1.0',
    toolRegistryVersion: 'migration-tools-1.0',
    patchPolicyVersion: 'typescript-bounded-1.0',
    patchPolicy: {
      schemaVersion: '1.0',
      allowedPaths: ['src/orbitchat-client.ts'],
      allowedChangeCategories: ['direct_usage'],
      maxChangedFiles: 1,
      maxPatchBytes: 16_384,
      maxAddedLines: 20,
      maxDeletedLines: 20,
    },
    patchPolicyDigest: 'f'.repeat(64),
  },
});

const plan = migrationExecutionPlanSchema.parse({
  schemaVersion: '1.0',
  binding,
  attemptNumber: 1,
  trust: { status: 'proposed', generatedBy: 'migration_agent' },
  summary: 'Apply the reviewed OrbitChat method rename.',
  files: [
    {
      path: 'src/orbitchat-client.ts',
      operation: 'modify',
      changeCategory: 'direct_usage',
      rationale: 'Use the reviewed OrbitChat v2 method.',
      evidenceChangeIds: ['C-01'],
      transformationIds: ['C-01'],
    },
  ],
  unresolved: [],
  verificationProfiles: ['typescript_static'],
});

describe('Stage 5C, 5D, and 5E bounded migration planning and patch validation', () => {
  it('accepts only failed verification evidence for a bounded repair input', () => {
    const repair = {
      ...input,
      attemptNumber: 2,
      repair: {
        previousPatchAttemptId: '32b9664f-12c0-4276-aea5-46938b6f5a97',
        previousPatchDigest: '1'.repeat(64),
        previousPatch: 'diff --git a/source.ts b/source.ts\n',
        verification: {
          outcome: 'failed',
          safeErrorCode: 'VERIFICATION_COMMAND_FAILED',
          commands: [
            {
              commandId: 'npm.typecheck',
              status: 'failed',
              exitCode: 2,
              signal: null,
              durationMs: 1_000,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          ],
        },
      },
    } as const;
    expect(migrationAgentInputArtifactSchema.parse(repair).attemptNumber).toBe(2);
    expect(() =>
      migrationAgentInputArtifactSchema.parse({
        ...repair,
        repair: {
          ...repair.repair,
          verification: {
            ...repair.repair.verification,
            outcome: 'unavailable',
          },
        },
      }),
    ).toThrow();
  });

  it('builds a deterministic accepted patch tied to exact approved evidence', () => {
    const before =
      "import { client } from './client.js';\n\nexport const send = client.messages.send;\n";
    const after =
      "import { client } from './client.js';\n\nexport const send = client.messages.create;\n";
    const first = build(input, plan, before, after);
    const second = build(input, plan, before, after);

    expect(second).toEqual(first);
    expect(first.validation.status).toBe('accepted');
    expect(first.validation.checks).toHaveLength(7);
    expect(first.manifest.binding).toEqual(binding);
    expect(parsePatchPaths(first.patch)).toEqual(['src/orbitchat-client.ts']);
    expect(first.patch).toContain('-export const send = client.messages.send;');
    expect(first.patch).toContain('+export const send = client.messages.create;');
  });

  it('rejects paths outside reviewed impact and hard-denies control-plane files', () => {
    const outside = withPath(input, plan, 'src/unreviewed.ts', 'direct_usage');
    expect(outside.validation.status).toBe('rejected');
    expect(outside.validation.safeErrorCode).toBe('PATCH_SCOPE_NOT_AUTHORIZED');

    const unrelatedInput = {
      ...input,
      authority: {
        ...input.authority,
        patchPolicy: {
          ...input.authority.patchPolicy,
          allowedPaths: ['src/unreviewed.ts'],
        },
      },
    } as MigrationAgentInputArtifact;
    const unrelated = withPath(
      unrelatedInput,
      plan,
      'src/unreviewed.ts',
      'direct_usage',
    );
    expect(unrelated.validation.safeErrorCode).toBe('PATCH_IMPACT_SCOPE_MISMATCH');

    const controlPlaneInput = {
      ...input,
      authority: {
        ...input.authority,
        patchPolicy: {
          ...input.authority.patchPolicy,
          allowedPaths: ['.github/workflows/deploy.yml'],
        },
      },
    } as MigrationAgentInputArtifact;
    const controlPlanePlan = withPlanPath(
      plan,
      '.github/workflows/deploy.yml',
      'direct_usage',
    );
    const forbidden = buildAndValidatePatch({
      migration: controlPlaneInput,
      plan: controlPlanePlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: '.github/workflows/deploy.yml',
          operation: 'modify',
          changeCategory: 'direct_usage',
          content: 'name: changed\n',
        }),
      ],
      readFile: () => 'name: original\n',
    });
    expect(forbidden.validation.status).toBe('rejected');
    expect(forbidden.validation.safeErrorCode).toBe('PATCH_FORBIDDEN_PATH');
  });

  it('rejects file creation and deletion without explicit approval authority', () => {
    for (const operation of ['create', 'delete'] as const) {
      const operationPlan = migrationExecutionPlanSchema.parse({
        ...plan,
        files: [{ ...plan.files[0], operation }],
      });
      const result = buildAndValidatePatch({
        migration: input,
        plan: operationPlan,
        edits: [
          migrationAgentProposedEditSchema.parse({
            path: 'src/orbitchat-client.ts',
            operation,
            changeCategory: 'direct_usage',
            content: operation === 'delete' ? null : 'export const created = true;\n',
          }),
        ],
        readFile: () =>
          operation === 'create' ? undefined : 'export const removed = true;\n',
      });
      expect(result.validation.status).toBe('rejected');
      expect(result.validation.safeErrorCode).toBe(
        'PATCH_FILE_OPERATION_NOT_AUTHORIZED',
      );
    }
  });

  it('rejects plan/edit mismatches and approved-budget overruns', () => {
    const mismatched = buildAndValidatePatch({
      migration: input,
      plan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: 'src/orbitchat-client.ts',
          operation: 'modify',
          changeCategory: 'test',
          content: 'changed\n',
        }),
      ],
      readFile: () => 'original\n',
    });
    expect(mismatched.validation.status).toBe('rejected');
    expect(mismatched.validation.safeErrorCode).toBe('PATCH_PLAN_MISMATCH');

    const smallBudget = {
      ...input,
      authority: {
        ...input.authority,
        patchPolicy: {
          ...input.authority.patchPolicy,
          maxAddedLines: 1,
        },
      },
    } as MigrationAgentInputArtifact;
    const oversized = build(
      smallBudget,
      plan,
      'export const value = 1;\n',
      'export const value = 2;\nexport const second = 3;\n',
    );
    expect(oversized.validation.status).toBe('rejected');
    expect(oversized.validation.safeErrorCode).toBe('PATCH_CHANGE_BUDGET_EXCEEDED');

    const wrongBindingPlan = {
      ...plan,
      binding: { ...plan.binding, baseCommitSha: '9'.repeat(40) },
    } as MigrationExecutionPlan;
    const wrongBinding = build(
      input,
      wrongBindingPlan,
      'export const value = 1;\n',
      'export const value = 2;\n',
    );
    expect(wrongBinding.validation.status).toBe('rejected');
    expect(wrongBinding.validation.safeErrorCode).toBe('PATCH_BASE_BINDING_MISMATCH');
  });

  it('requires an existing npm lockfile when dependency declarations change', () => {
    const manifestPath = 'package.json';
    const lockfilePath = 'package-lock.json';
    const npmInput = {
      ...input,
      authority: {
        ...input.authority,
        patchPolicy: {
          ...input.authority.patchPolicy,
          allowedPaths: [manifestPath, lockfilePath],
          allowedChangeCategories: ['dependency_manifest', 'lockfile'],
          maxChangedFiles: 2,
          maxAddedLines: 100,
          maxDeletedLines: 100,
        },
      },
    } as MigrationAgentInputArtifact;
    const manifestBefore = JSON.stringify(
      { dependencies: { '@orbitchat/sdk': '1.0.0' } },
      null,
      2,
    );
    const manifestAfter = JSON.stringify(
      { dependencies: { '@orbitchat/sdk': '2.0.0' } },
      null,
      2,
    );
    const lockfileBefore = JSON.stringify(
      {
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { '@orbitchat/sdk': '1.0.0' } },
          'node_modules/@orbitchat/sdk': { version: '1.0.0' },
        },
      },
      null,
      2,
    );
    const lockfileAfter = lockfileBefore.replaceAll('1.0.0', '2.0.0');
    const manifestPlanFile = {
      ...plan.files[0],
      path: manifestPath,
      changeCategory: 'dependency_manifest' as const,
    };
    const manifestPlan = migrationExecutionPlanSchema.parse({
      ...plan,
      files: [manifestPlanFile],
    });
    const missingLockfile = buildAndValidatePatch({
      migration: npmInput,
      plan: manifestPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: manifestPath,
          operation: 'modify',
          changeCategory: 'dependency_manifest',
          content: manifestAfter,
        }),
      ],
      readFile: path =>
        new Map([
          [manifestPath, manifestBefore],
          [lockfilePath, lockfileBefore],
        ]).get(path),
    });
    expect(missingLockfile.validation.status).toBe('rejected');
    expect(missingLockfile.validation.safeErrorCode).toBe('PATCH_LOCKFILE_REQUIRED');

    const repositoryWithoutLockfile = buildAndValidatePatch({
      migration: npmInput,
      plan: manifestPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: manifestPath,
          operation: 'modify',
          changeCategory: 'dependency_manifest',
          content: manifestAfter,
        }),
      ],
      readFile: path => (path === manifestPath ? manifestBefore : undefined),
    });
    expect(repositoryWithoutLockfile.validation.status).toBe('accepted');

    const consistentPlan = migrationExecutionPlanSchema.parse({
      ...plan,
      files: [
        manifestPlanFile,
        {
          ...plan.files[0],
          path: lockfilePath,
          changeCategory: 'lockfile',
        },
      ],
    });
    const consistent = buildAndValidatePatch({
      migration: npmInput,
      plan: consistentPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: manifestPath,
          operation: 'modify',
          changeCategory: 'dependency_manifest',
          content: manifestAfter,
        }),
        migrationAgentProposedEditSchema.parse({
          path: lockfilePath,
          operation: 'modify',
          changeCategory: 'lockfile',
          content: lockfileAfter,
        }),
      ],
      readFile: path =>
        new Map([
          [manifestPath, manifestBefore],
          [lockfilePath, lockfileBefore],
        ]).get(path),
    });
    expect(consistent.validation.status).toBe('accepted');
  });

  it('does not require a lockfile for non-dependency manifest changes', () => {
    const manifestPath = 'package.json';
    const lockfilePath = 'package-lock.json';
    const manifestBefore = JSON.stringify({
      scripts: { test: 'vitest run' },
      dependencies: { '@orbitchat/sdk': '1.0.0' },
    });
    const manifestAfter = JSON.stringify({
      scripts: { test: 'vitest run --coverage' },
      dependencies: { '@orbitchat/sdk': '1.0.0' },
    });
    const npmInput = {
      ...input,
      authority: {
        ...input.authority,
        patchPolicy: {
          ...input.authority.patchPolicy,
          allowedPaths: [manifestPath],
          allowedChangeCategories: ['dependency_manifest'],
        },
      },
    } as MigrationAgentInputArtifact;
    const manifestPlan = migrationExecutionPlanSchema.parse({
      ...plan,
      files: [
        {
          ...plan.files[0],
          path: manifestPath,
          changeCategory: 'dependency_manifest',
        },
      ],
    });
    const result = buildAndValidatePatch({
      migration: npmInput,
      plan: manifestPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: manifestPath,
          operation: 'modify',
          changeCategory: 'dependency_manifest',
          content: manifestAfter,
        }),
      ],
      readFile: path =>
        new Map([
          [manifestPath, manifestBefore],
          [lockfilePath, '{"lockfileVersion":3}'],
        ]).get(path),
    });
    expect(result.validation.status).toBe('accepted');
  });

  it('rejects traversal and binary model output at the contract boundary', () => {
    expect(() =>
      migrationAgentProposedEditSchema.parse({
        path: '../secret.txt',
        operation: 'modify',
        changeCategory: 'direct_usage',
        content: 'leak',
      }),
    ).toThrow();
    expect(() =>
      migrationAgentProposedEditSchema.parse({
        path: 'src/orbitchat-client.ts',
        operation: 'modify',
        changeCategory: 'direct_usage',
        content: 'binary\u0000content',
      }),
    ).toThrow();
  });

  it('emits auditable rejected create/delete patches and preserves newline markers', () => {
    const createdPlan = migrationExecutionPlanSchema.parse({
      ...plan,
      files: [{ ...plan.files[0], operation: 'create' }],
    });
    const created = buildAndValidatePatch({
      migration: input,
      plan: createdPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: 'src/orbitchat-client.ts',
          operation: 'create',
          changeCategory: 'direct_usage',
          content: 'export const created = true;',
        }),
      ],
      readFile: () => undefined,
    });
    expect(created.patch).toContain('@@ -0,0 +1,1 @@');
    expect(created.patch).toContain('\\ No newline at end of file');
    expect(created.validation.status).toBe('rejected');
    expect(created.validation.safeErrorCode).toBe(
      'PATCH_FILE_OPERATION_NOT_AUTHORIZED',
    );

    const deletedPlan = migrationExecutionPlanSchema.parse({
      ...plan,
      files: [{ ...plan.files[0], operation: 'delete' }],
    });
    const deleted = buildAndValidatePatch({
      migration: input,
      plan: deletedPlan,
      edits: [
        migrationAgentProposedEditSchema.parse({
          path: 'src/orbitchat-client.ts',
          operation: 'delete',
          changeCategory: 'direct_usage',
          content: null,
        }),
      ],
      readFile: () => 'export const removed = true;',
    });
    expect(deleted.patch).toContain('@@ -1,1 +0,0 @@');
    expect(deleted.patch).toContain('deleted file mode 100644');
    expect(deleted.validation.status).toBe('rejected');
    expect(deleted.validation.safeErrorCode).toBe(
      'PATCH_FILE_OPERATION_NOT_AUTHORIZED',
    );

    const newlineOnly = build(
      input,
      plan,
      'export const value = true;',
      'export const value = true;\n',
    );
    expect(newlineOnly.manifest.addedLines).toBe(1);
    expect(newlineOnly.manifest.deletedLines).toBe(1);

    const unchangedFinalLine = build(
      input,
      plan,
      'const value = 1;\nexport { value };',
      'const value = 2;\nexport { value };',
    );
    expect(unchangedFinalLine.patch).toContain('\\ No newline at end of file');
  });

  it('rejects invented evidence and safely handles malformed proposal structure', () => {
    const inventedEvidencePlan = {
      ...plan,
      files: [
        {
          ...plan.files[0],
          evidenceChangeIds: ['C-99'],
          transformationIds: ['C-99'],
        },
      ],
    } as MigrationExecutionPlan;
    const inventedEvidence = build(
      input,
      inventedEvidencePlan,
      'export const value = 1;\n',
      'export const value = 2;\n',
    );
    expect(inventedEvidence.validation.safeErrorCode).toBe(
      'PATCH_PLAN_EVIDENCE_INVALID',
    );

    expect(
      parsePatchPaths(
        ['diff --git a/a.ts b/a.ts', 'diff --git a/a.ts b/a.ts', ''].join('\n'),
      ),
    ).toEqual([]);
    expect(parsePatchPaths('diff --git a/a.ts b/b.ts\n')).toEqual([]);
    expect(parsePatchPaths('')).toEqual([]);

    expect(() =>
      buildAndValidatePatch({
        migration: input,
        plan,
        edits: [
          {
            path: '../unsafe.ts',
            operation: 'modify',
            changeCategory: 'direct_usage',
            content: 'unsafe\n',
          },
        ],
        readFile: () => 'old\n',
      }),
    ).toThrow();
    expect(() => build(input, plan, 'unchanged\n', 'unchanged\n')).toThrow();
  });

  it('accepts only internally consistent terminal agent results', () => {
    const patch = build(
      input,
      plan,
      'export const value = 1;\n',
      'export const value = 2;\n',
    );
    const result = {
      schemaVersion: '1.0',
      organisationId: input.organisationId,
      repositoryId: input.repositoryId,
      migrationRunId: input.binding.migrationRunId,
      attemptNumber: input.attemptNumber,
      inputDigest: '1'.repeat(64),
      status: 'succeeded',
      safeErrorCode: null,
      model: {
        requestedModel: 'gpt-5.6-sol',
        returnedModel: 'gpt-5.6-sol',
        requestId: null,
      },
      usage: {
        modelCalls: 1,
        toolCalls: 5,
        iterations: 2,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1_000,
      },
      actions: [],
      plan,
      patch: patch.patch,
      manifest: patch.manifest,
      validation: patch.validation,
      checkpoints: [
        {
          schemaVersion: '1.0',
          binding,
          attemptNumber: 1,
          sequence: 1,
          phase: 'context',
          lastActionSequence: 0,
          remainingBudget: {
            modelCalls: 5,
            toolCalls: 40,
            iterations: 6,
          },
          planDigest: null,
          patchDigest: null,
        },
        {
          schemaVersion: '1.0',
          binding,
          attemptNumber: 1,
          sequence: 2,
          phase: 'patching',
          lastActionSequence: 5,
          remainingBudget: {
            modelCalls: 4,
            toolCalls: 35,
            iterations: 4,
          },
          planDigest: patch.manifest.planDigest,
          patchDigest: patch.manifest.patchDigest,
        },
      ],
    } as const;
    expect(migrationAgentResultSchema.parse(result).status).toBe('succeeded');
    expect(
      migrationAgentResultSchema.parse({
        ...result,
        usage: { ...result.usage, modelCalls: 6 },
      }).usage.modelCalls,
    ).toBe(6);
    expect(() =>
      migrationAgentResultSchema.parse({
        ...result,
        status: 'failed',
        safeErrorCode: 'MIGRATION_AGENT_FAILED',
      }),
    ).toThrow();
    expect(() =>
      migrationAgentResultSchema.parse({
        ...result,
        status: 'rejected',
        safeErrorCode: 'PATCH_REJECTED',
      }),
    ).toThrow();
  });

  it('wires a separate read-only migration workload and advances only to verification', () => {
    const foundation = read('infra/terraform/foundation/main.tf');
    const compute = read('infra/terraform/environments/development/compute.tf');
    const iam = read('infra/terraform/environments/development/iam.tf');
    const worker = read('workers/migration-agent/src/main.ts');
    const gateway = read('workers/migration-agent/src/gateway.ts');
    const kernel = read('workers/migration-agent/src/kernel.ts');
    const migration = read('supabase/migrations/0016_stage_5c_5d_migration_agent.sql');

    expect(foundation).toContain('migration-api-development-migration-agent');
    expect(compute).toContain(
      'TaskDefinition = aws_ecs_task_definition.migration_agent.arn',
    );
    expect(compute).toContain('operation    = "prepare_migration_agent"');
    expect(compute).toContain('operation    = "ingest_migration_plan"');
    expect(compute).toContain('operation    = "ingest_migration_patch"');
    expect(compute).toContain('operation    = "prepare_migration_verification"');
    expect(iam).toContain('ReadExactApprovedMigrationInputs');
    expect(iam).toContain('WriteMigrationAgentResult');
    expect(iam).not.toContain('migration-agent-github');
    expect(worker).not.toContain('child_process');
    expect(worker).toContain("error.name === 'AccessDenied'");
    expect(worker).toContain('error.$metadata.httpStatusCode === 403');
    expect(worker).toContain("IfNoneMatch: '*'");
    expect(worker).toContain('const preloadReadPaths = [');
    expect(worker).toContain('.filter(path => allowedPaths.has(path))');
    expect(worker).toContain("tools.fileKind(path) === 'binary'");
    expect(worker).toContain("MigrationAgentRuntimeError('PATCH_BINARY_SOURCE')");
    expect(gateway).toContain('store: false');
    expect(gateway).toContain('tool_choice: toolChoice');
    expect(gateway).toContain('Use only the supplied read-only repository tools');
    expect(kernel).toContain("{ type: 'function', name: requiredTool }");
    expect(kernel).toContain('migrationAgentBudgets.maximumModelCalls');
    expect(kernel).toContain("name: 'read_repository_file'");
    expect(kernel).toContain('call_preloaded_');
    expect(migration).toContain("'plan_created'");
    expect(migration).toContain("'patch_validated'");
  });

  it('creates immutable agent artifacts without requiring bucket-list permission', () => {
    const workflowControl = read('services/workflow-control/src/handler.ts');
    const helperStart = workflowControl.indexOf('async function putImmutableObject(');
    const helperEnd = workflowControl.indexOf(
      '\nfunction assertImmutableObject(',
      helperStart,
    );
    const helper = workflowControl.slice(helperStart, helperEnd);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain("IfNoneMatch: '*'");
    expect(helper.indexOf('new PutObjectCommand(')).toBeLessThan(
      helper.indexOf('new HeadObjectCommand('),
    );
    expect(helper).not.toContain("error.name === 'NotFound'");
  });
});

function build(
  migration: MigrationAgentInputArtifact,
  executionPlan: MigrationExecutionPlan,
  before: string,
  after: string,
): PatchBuildResult {
  return buildAndValidatePatch({
    migration,
    plan: executionPlan,
    edits: [
      migrationAgentProposedEditSchema.parse({
        path: executionPlan.files[0]?.path,
        operation: 'modify',
        changeCategory: executionPlan.files[0]?.changeCategory,
        content: after,
      }),
    ],
    readFile: () => before,
  });
}

function withPath(
  migration: MigrationAgentInputArtifact,
  executionPlan: MigrationExecutionPlan,
  path: string,
  changeCategory: 'direct_usage',
): PatchBuildResult {
  return buildAndValidatePatch({
    migration,
    plan: withPlanPath(executionPlan, path, changeCategory),
    edits: [
      migrationAgentProposedEditSchema.parse({
        path,
        operation: 'modify',
        changeCategory,
        content: 'changed\n',
      }),
    ],
    readFile: () => 'original\n',
  });
}

function withPlanPath(
  executionPlan: MigrationExecutionPlan,
  path: string,
  changeCategory: 'direct_usage',
): MigrationExecutionPlan {
  return migrationExecutionPlanSchema.parse({
    ...executionPlan,
    files: executionPlan.files.map(file => ({
      ...file,
      path,
      changeCategory,
    })),
  });
}

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
