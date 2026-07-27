import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  githubPublicationSchema,
  publicationAttemptBindingSchema,
  publicationAttemptSchema,
  publicationNotificationSchema,
} from '@migration/contracts';

const organisationId = '07a17d5a-820d-4199-93d9-4e71b1c2d4f5';
const migrationRunId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const approvalId = '8955ed33-d1d8-4fdb-bd48-3a0835562934';
const repositoryId = 'fb88f567-56f6-4151-8a42-c84981f49ec6';
const installationId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const verificationAttemptId = '12a906c7-f7df-4c65-9137-70bcf17eec86';
const verificationResultId = '32b9664f-12c0-4276-aea5-46938b6f5a97';
const patchAttemptId = '51862bc4-9e1a-49a9-a4bf-376eae3f52b6';
const patchArtifactId = '74218edf-4836-4b41-8f6c-1525c5fa1075';
const patchValidationArtifactId = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';
const publicationAttemptId = '3979913e-1378-48bf-a7c3-63e0fcd6e797';
const publicationId = '0c844cc2-d350-4487-ae17-1229e0095b7a';
const recipientUserId = 'e4486174-338f-4a12-a4e2-2d5578518ff1';

const binding = {
  schemaVersion: '1.0',
  organisationId,
  migrationRunId,
  approvalId,
  repositoryId,
  installationId,
  githubRepositoryId: '1311052469',
  verificationAttemptId,
  verificationResultId,
  verificationOutcome: 'passed',
  patchAttemptId,
  patchArtifactId,
  patchDigest: 'a'.repeat(64),
  patchValidationArtifactId,
  patchValidationDigest: 'b'.repeat(64),
  baseBranch: 'main',
  baseCommitSha: 'c'.repeat(40),
  headBranch: `migration-api/run-${migrationRunId}`,
  publicationPolicyVersion: 'draft-pr-1.0',
} as const;

describe('Stage 7A publication control plane', () => {
  it('binds publication to one passed verification result and deterministic branch', () => {
    expect(publicationAttemptBindingSchema.parse(binding)).toEqual(binding);
    expect(() =>
      publicationAttemptBindingSchema.parse({
        ...binding,
        verificationOutcome: 'failed',
      }),
    ).toThrow();
    expect(() =>
      publicationAttemptBindingSchema.parse({
        ...binding,
        headBranch: 'migration-api/arbitrary',
      }),
    ).toThrow();
    for (const baseBranch of [
      '../main',
      'feature//unsafe',
      'feature.lock/next',
      'feature@{previous}',
      'feature name',
    ]) {
      expect(() =>
        publicationAttemptBindingSchema.parse({ ...binding, baseBranch }),
      ).toThrow();
    }
  });

  it('enforces attempt lifecycle and idempotency invariants', () => {
    const queued = {
      ...binding,
      id: publicationAttemptId,
      status: 'queued',
      attemptCount: 0,
      safeErrorCode: null,
      idempotencyKey: `publication:${migrationRunId}`,
      correlationId: '3eaa3d84-2331-49bf-a409-e1183c264313',
      createdAt: '2026-07-28T00:00:00.000Z',
      startedAt: null,
      completedAt: null,
      updatedAt: '2026-07-28T00:00:00.000Z',
    } as const;

    expect(publicationAttemptSchema.parse(queued)).toEqual(queued);
    expect(() =>
      publicationAttemptSchema.parse({
        ...queued,
        idempotencyKey: 'publication:another-run',
      }),
    ).toThrow();
    expect(() =>
      publicationAttemptSchema.parse({
        ...queued,
        status: 'succeeded',
        attemptCount: 1,
        startedAt: queued.createdAt,
      }),
    ).toThrow();
    expect(
      publicationAttemptSchema.parse({
        ...queued,
        status: 'failed',
        attemptCount: 1,
        safeErrorCode: 'GITHUB_PUBLICATION_FAILED',
        startedAt: queued.createdAt,
        completedAt: '2026-07-28T00:00:01.000Z',
        updatedAt: '2026-07-28T00:00:01.000Z',
      }).status,
    ).toBe('failed');
  });

  it('accepts only canonical GitHub pull-request identities and consistent state', () => {
    const publication = {
      schemaVersion: '1.0',
      id: publicationId,
      organisationId,
      migrationRunId,
      publicationAttemptId,
      repositoryId,
      githubRepositoryId: '1311052469',
      headBranch: binding.headBranch,
      baseBranch: 'main',
      baseCommitSha: binding.baseCommitSha,
      commitSha: 'd'.repeat(40),
      pullRequestNumber: 42,
      pullRequestNodeId: 'PR_kwDOExample',
      pullRequestUrl:
        'https://github.com/SharmaKunal14/orbitchat-migration-fixture/pull/42',
      state: 'open',
      isDraft: true,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastReconciledAt: '2026-07-28T00:00:01.000Z',
    } as const;

    expect(githubPublicationSchema.parse(publication)).toEqual(publication);
    expect(() =>
      githubPublicationSchema.parse({
        ...publication,
        pullRequestUrl: 'https://example.com/owner/repository/pull/42',
      }),
    ).toThrow();
    expect(() =>
      githubPublicationSchema.parse({
        ...publication,
        state: 'merged',
        isDraft: true,
      }),
    ).toThrow();
  });

  it('models an idempotent notification without confusing failure and delivery', () => {
    const notification = {
      schemaVersion: '1.0',
      id: '64bf15a9-2266-4013-b239-a6154dfc89b3',
      organisationId,
      migrationRunId,
      publicationId,
      recipientUserId,
      eventType: 'draft_pr_created',
      channel: 'in_app',
      idempotencyKey: `draft-pr:${publicationId}:${recipientUserId}:in-app`,
      availableAt: '2026-07-28T00:00:00.000Z',
      attempts: 0,
      deliveredAt: null,
      safeErrorCode: null,
      createdAt: '2026-07-28T00:00:00.000Z',
    } as const;

    expect(publicationNotificationSchema.parse(notification)).toEqual(notification);
    expect(() =>
      publicationNotificationSchema.parse({
        ...notification,
        deliveredAt: '2026-07-28T00:00:01.000Z',
        safeErrorCode: 'NOTIFICATION_FAILED',
      }),
    ).toThrow();
  });

  it('creates tenant-bound records with immutable identity and no public access', () => {
    const migration = read(
      'supabase/migrations/0019_stage_7a_publication_control_plane.sql',
    );
    const rollback = read(
      'supabase/migrations/0019_stage_7a_publication_control_plane.down.sql',
    );

    expect(migration).toContain('create table publication_attempts');
    expect(migration).toContain('create table github_publications');
    expect(migration).toContain('create table publication_notification_outbox');
    expect(migration).toContain("verification_outcome = 'passed'");
    expect(migration).toContain(
      "head_branch = 'migration-api/run-' || migration_run_id::text",
    );
    expect(migration).toContain(
      "idempotency_key = 'publication:' || migration_run_id::text",
    );
    expect(migration).toContain('unique (migration_run_id)');
    expect(migration).toContain('publication_attempts_transition_guard');
    expect(migration).toContain('github_publications_identity_guard');
    expect(migration).toContain('publication_notification_identity_guard');
    expect(migration).toContain('from anon, authenticated');
    expect(rollback).toContain(
      'Cannot roll back Stage 7A while publication records exist',
    );
  });

  it('keeps GitHub mutation denied until the trusted publisher is implemented', () => {
    const workflowControl = read('services/workflow-control/src/handler.ts');
    expect(workflowControl).toContain('MIGRATION_PUBLICATION_NOT_IMPLEMENTED');
  });
});

function read(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}
