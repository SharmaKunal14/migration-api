import { createHash } from 'node:crypto';

import type { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  migrationAgentInputArtifactSchema,
  migrationAgentProposedEditSchema,
  migrationExecutionPlanSchema,
} from '@migration/contracts';
import { buildAndValidatePatch } from '@migration/patch-policy';

import { loadPublicMigrationPatchReview } from '../services/api/src/patch-review.js';
import type { MigrationPatchReviewRecord } from '../services/api/src/repository.js';
import type { PatchReviewArtifactRecord } from '../services/api/src/repository.js';

const runId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const organisationId = '07a17d5a-820d-4199-93d9-4e71b1c2d4f5';
const binding = {
  migrationRunId: runId,
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
const specification = {
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
      summary: 'Reviewed migration evidence.',
    },
  ],
  preconditions: ['The package resolves to OrbitChat 1.x.'],
  verificationRecommendations: ['typescript_static'],
  uncertainties: [],
  trust: {
    status: 'reviewed',
    generatedBy: 'change_intelligence_agent',
    reviewedAt: '2026-07-26T06:41:47.620Z',
  },
  revision: 1,
  generatedAt: '2026-07-26T05:47:25.267Z',
} as const;
const patchPolicy = {
  schemaVersion: '1.0',
  allowedPaths: ['src/orbitchat-client.ts'],
  allowedChangeCategories: ['direct_usage'],
  maxChangedFiles: 1,
  maxPatchBytes: 16_384,
  maxAddedLines: 20,
  maxDeletedLines: 20,
} as const;
const input = migrationAgentInputArtifactSchema.parse({
  schemaVersion: '1.0',
  organisationId,
  repositoryId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
  binding,
  attemptNumber: 1,
  snapshot: {
    objectKey: `env/development/org/${organisationId}/run/${runId}/input/source/snapshot.tar.gz`,
    digest: binding.snapshotDigest,
  },
  migrationSpecification: specification,
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
    patchPolicy,
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
const proposal = buildAndValidatePatch({
  migration: input,
  plan,
  edits: [
    migrationAgentProposedEditSchema.parse({
      path: 'src/orbitchat-client.ts',
      operation: 'modify',
      changeCategory: 'direct_usage',
      content: 'export const send = client.messages.create;\n',
    }),
  ],
  readFile: () => 'export const send = client.messages.send;\n',
});
const prefix = `env/development/org/${organisationId}/run/${runId}/agent`;
const bodies = {
  [`${prefix}/plan.json`]: Buffer.from(JSON.stringify(plan)),
  [`${prefix}/proposal.diff`]: Buffer.from(proposal.patch),
  [`${prefix}/patch-manifest.json`]: Buffer.from(JSON.stringify(proposal.manifest)),
  [`${prefix}/patch-validation.json`]: Buffer.from(JSON.stringify(proposal.validation)),
};

describe('Stage 5F authenticated patch review boundary', () => {
  it('returns only digest-verified, schema-valid immutable patch evidence', async () => {
    const review = await loadPublicMigrationPatchReview(
      mockS3(bodies),
      'artifact-bucket',
      'development',
      record(),
    );

    expect(review.validation.status).toBe('accepted');
    expect(review.repositoryModifiedRemotely).toBe(false);
    expect(review.plan.files[0]?.path).toBe('src/orbitchat-client.ts');
    expect(review.patch).toContain('client.messages.create');
    expect(review.evidence).toEqual([
      expect.objectContaining({
        evidenceId: 'C-01',
        sourceUrl: 'https://docs.orbitchat.example/migrate-v2',
      }),
    ]);
    expect(review.attempts[0]?.selected).toBe(true);
  });

  it('rejects artifact-key substitution and digest tampering', async () => {
    await expect(
      loadPublicMigrationPatchReview(mockS3(bodies), 'artifact-bucket', 'development', {
        ...record(),
        patch: {
          ...record().patch,
          objectKey: `${prefix}/context.json`,
        },
      }),
    ).rejects.toThrow('artifact key is invalid');

    const tampered = {
      ...bodies,
      [`${prefix}/proposal.diff`]: Buffer.from(`${proposal.patch}\nmalicious`),
    };
    await expect(
      loadPublicMigrationPatchReview(
        mockS3(tampered),
        'artifact-bucket',
        'development',
        record(),
      ),
    ).rejects.toThrow('integrity check failed');
  });
});

function record(): MigrationPatchReviewRecord {
  const artifact = (name: keyof typeof bodies): PatchReviewArtifactRecord => ({
    objectKey: name,
    digest: sha256(bodies[name]),
    bytes: bodies[name].byteLength,
  });
  return {
    organisationId,
    migrationRunId: runId,
    baseCommitSha: binding.baseCommitSha,
    patchPolicy,
    specification,
    selectedAttemptId: '32b9664f-12c0-4276-aea5-46938b6f5a97',
    attemptNumber: 1,
    policyVersion: input.authority.patchPolicyVersion,
    policyDigest: input.authority.patchPolicyDigest,
    plan: artifact(`${prefix}/plan.json`),
    patch: artifact(`${prefix}/proposal.diff`),
    manifest: artifact(`${prefix}/patch-manifest.json`),
    validation: artifact(`${prefix}/patch-validation.json`),
    attempts: [
      {
        id: '32b9664f-12c0-4276-aea5-46938b6f5a97',
        attemptNumber: 1,
        parentPatchAttemptId: null,
        status: 'accepted',
        safeErrorCode: null,
        summaryCode: 'PATCH_ACCEPTED',
        changedFiles: 1,
        addedLines: 1,
        deletedLines: 1,
        patchBytes: proposal.manifest.patchBytes,
        selected: true,
        createdAt: '2026-07-27T00:00:00.000Z',
      },
    ],
  };
}

function mockS3(objects: Readonly<Record<string, Buffer>>): S3Client {
  return {
    send: vi.fn().mockImplementation((command: GetObjectCommand) => {
      const key = command.input.Key;
      if (key === undefined) throw new Error('missing fixture object key');
      const body = objects[key];
      if (!body) throw new Error('missing fixture object');
      const expected = bodies[key as keyof typeof bodies];
      return Promise.resolve({
        ContentLength: expected.byteLength,
        Metadata: {
          digest: sha256(expected),
          'migration-run-id': runId,
        },
        Body: { transformToByteArray: () => Promise.resolve(body) },
      });
    }),
  } as unknown as S3Client;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
