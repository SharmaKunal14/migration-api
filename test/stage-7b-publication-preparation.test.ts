import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const broker = read('services/github-token-broker/src/handler.ts');
const control = read('services/workflow-control/src/handler.ts');
const compute = read('infra/terraform/environments/development/compute.tf');
const iam = read('infra/terraform/environments/development/iam.tf');

describe('Stage 7B trusted publication preparation', () => {
  it('checks live write capability without returning the GitHub token', () => {
    expect(broker).toContain("operation: z.literal('verify_publication_access')");
    expect(broker).toContain("contents: 'write'");
    expect(broker).toContain("pull_requests: 'write'");
    expect(broker).toContain('publicationReferencePath(access)');
    expect(broker).toContain("event: 'github_publication_access_verified'");
    expect(broker).toContain('return githubPublicationAccessSchema.parse({');
  });

  it('requires an active exact repository and a passed verification result', () => {
    expect(broker).toContain("run.currentStage', '=', 'publishing'");
    expect(broker).toContain("result.outcome', '=', 'passed'");
    expect(broker).toContain("installation.status', '=', 'active'");
    expect(broker).toContain("revocation.approvalId', 'is', null");
    expect(control).toContain("patch.status', '=', 'accepted'");
    expect(control).toContain('access.headCommitSha !== source.baseCommitSha');
  });

  it('persists one deterministic attempt only after revalidation', () => {
    expect(control).toContain('isMigrationApprovalStale(approvalState, new Date())');
    expect(control).toContain(".insertInto('publicationAttempts')");
    expect(control).toContain(
      'idempotencyKey: `publication:${workflow.migrationRunId}`',
    );
    expect(control).toContain(
      'headBranch: `migration-api/run-${workflow.migrationRunId}`',
    );
    expect(control).toContain("eventType: 'publication_prepared'");
    expect(control).toContain("'MIGRATION_PUBLICATION_BASE_STALE'");
    expect(control).toContain("'GITHUB_PUBLICATION_ACCESS_DENIED'");
    expect(control).toContain(
      "safeErrorCode === 'MIGRATION_PUBLICATION_NOT_IMPLEMENTED'",
    );
  });

  it('retains preparation before the separately controlled mutation step', () => {
    expect(compute).toContain('operation    = "prepare_migration_publication"');
    expect(compute).toContain('StringEquals = "stale"');
    expect(compute).toContain('StringEquals = "failed"');
    expect(compute).toContain('Next         = "ReconcilePublication"');
    expect(compute).toContain('operation    = "publish_migration_draft_pr"');
    expect(control).toContain('MIGRATION_PUBLICATION_NOT_IMPLEMENTED');
    expect(broker).toContain("operation: z.literal('publish_draft_pr')");
    expect(broker).toContain('/git/refs');
    expect(broker).toContain('/pulls');
  });

  it('grants workflow control only invocation of the exact broker Lambda', () => {
    expect(iam).toContain(
      'data "aws_iam_policy_document" "workflow_github_token_broker"',
    );
    expect(iam).toContain('sid       = "VerifyExactPublicationAccess"');
    expect(iam).toContain('resources = [aws_lambda_function.github_token_broker.arn]');
    expect(iam).not.toMatch(
      /workflow_github_token_broker[\s\S]{0,500}resources\s*=\s*\["\*"\]/u,
    );
  });

  it('keeps repair-agent artifact access bounded to the supported attempts', () => {
    const policy =
      /data "aws_iam_policy_document" "migration_agent_task" \{([\s\S]*?)resource "aws_iam_role_policy" "migration_agent_task"/u.exec(
        iam,
      )?.[1] ?? '';
    expect(policy).not.toBe('');
    expect(policy).toContain('/agent/repair-attempt-2/context.json"');
    expect(policy).toContain('/agent/repair-attempt-2/result.json"');
    expect(policy).toContain('/agent/repair-attempt-3/context.json"');
    expect(policy).toContain('/agent/repair-attempt-3/result.json"');
    expect(policy).not.toContain('/agent/repair-attempt-*/');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
