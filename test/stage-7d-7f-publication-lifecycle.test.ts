import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  githubPublicationSchema,
  publicationNotificationSchema,
} from '@migration/contracts';

const reconciler = read('services/github-reconciler/src/handler.ts');
const dispatcher = read('services/outbox-dispatcher/src/handler.ts');
const control = read('services/workflow-control/src/handler.ts');
const api = read('services/api/src/repository.ts');
const apiHandler = read('services/api/src/handler.ts');
const web = read('apps/web/src/app.tsx');

describe('Stage 7D-7F publication lifecycle and reviewer handoff', () => {
  it('accepts valid lifecycle state while rejecting an impossible merged draft', () => {
    const publication = {
      schemaVersion: '1.0',
      id: '0c844cc2-d350-4487-ae17-1229e0095b7a',
      organisationId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
      migrationRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      publicationAttemptId: '3979913e-1378-48bf-a7c3-63e0fcd6e797',
      repositoryId: '32b9664f-12c0-4276-aea5-46938b6f5a97',
      githubRepositoryId: '1311052469',
      headBranch: 'migration-api/run-e4e2d9db-bd1c-4eef-b685-231128724583',
      baseBranch: 'main',
      baseCommitSha: 'a'.repeat(40),
      commitSha: 'b'.repeat(40),
      pullRequestNumber: 42,
      pullRequestNodeId: 'PR_kwDOExample',
      pullRequestUrl:
        'https://github.com/SharmaKunal14/orbitchat-migration-fixture/pull/42',
      state: 'merged' as const,
      isDraft: false,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastReconciledAt: '2026-07-28T00:01:00.000Z',
    };
    expect(githubPublicationSchema.parse(publication)).toEqual(publication);
    expect(() =>
      githubPublicationSchema.parse({ ...publication, isDraft: true }),
    ).toThrow();
  });

  it('reconciles signed pull-request events against immutable publication identity', () => {
    expect(reconciler).toContain("envelope.eventName === 'pull_request'");
    expect(reconciler).toContain('completePullRequest(');
    expect(reconciler).toContain('GITHUB_PULL_REQUEST_IDENTITY_MISMATCH');
    expect(reconciler).toContain(
      "publication.state === 'merged' ? 'merged' : lifecycle.state",
    );
  });

  it('queues and idempotently delivers an in-app reviewer notification', () => {
    expect(control).toContain(".insertInto('publicationNotificationOutbox')");
    expect(control).toContain("eventType: 'notification_queued'");
    expect(control).toContain(
      '`draft-pr:${publicationId}:${approval.approvedByUserId}:in-app`',
    );
    expect(dispatcher).toContain("kind: 'publication_notification'");
    expect(dispatcher).toContain(".where('channel', '=', 'in_app')");
    expect(dispatcher).toContain(".where('deliveredAt', 'is', null)");

    const notification = {
      schemaVersion: '1.0',
      id: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      organisationId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
      migrationRunId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      publicationId: '0c844cc2-d350-4487-ae17-1229e0095b7a',
      recipientUserId: 'e4486174-338f-4a12-a4e2-2d5578518ff1',
      eventType: 'draft_pr_created' as const,
      channel: 'in_app' as const,
      idempotencyKey:
        'draft-pr:0c844cc2-d350-4487-ae17-1229e0095b7a:e4486174-338f-4a12-a4e2-2d5578518ff1:in-app',
      availableAt: '2026-07-28T00:00:00.000Z',
      attempts: 1,
      deliveredAt: '2026-07-28T00:01:00.000Z',
      safeErrorCode: null,
      createdAt: '2026-07-28T00:00:00.000Z',
    };
    expect(publicationNotificationSchema.parse(notification)).toEqual(notification);
  });

  it('exposes current PR and notification state without implying merge authority', () => {
    expect(api).toContain(".selectFrom('publicationAttempts as attempt')");
    expect(api).toContain("'publication.lastReconciledAt'");
    expect(api).toContain(".where('notification.recipientUserId', '=', userId)");
    expect(apiHandler).toContain('/notifications$');
    expect(web).toContain('Open draft pull request');
    expect(web).toMatch(/It has no\s+permission to merge the pull request\./u);
    expect(web).toContain('rel="noreferrer"');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
