import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const broker = read('services/github-token-broker/src/handler.ts');
const control = read('services/workflow-control/src/handler.ts');
const compute = read('infra/terraform/environments/development/compute.tf');

describe('Stage 7C trusted draft pull request publication', () => {
  it('publishes only a digest-bound accepted patch through the token broker', () => {
    expect(control).toContain("operation: z.literal('publish_migration_draft_pr')");
    expect(control).toContain('sha256(patch) !== prepared.patchDigest');
    expect(broker).toContain('access.patchDigest !== command.patchDigest');
    expect(broker).toContain('applyValidatedTextPatch(patch, sourceFiles)');
    expect(broker).toContain(
      "permissions: { contents: 'write', pull_requests: 'write' }",
    );
  });

  it('uses a deterministic branch and creates a draft that cannot be merged', () => {
    expect(broker).toContain('`refs/heads/${access.headBranch}`');
    expect(broker).toContain('draft: true');
    expect(broker).toContain(
      'Human review is required. Migration API cannot merge this pull request.',
    );
    expect(broker).not.toContain('/merges');
  });

  it('reconciles retries instead of creating duplicate pull requests', () => {
    expect(broker).toContain('githubRequestOptional(');
    expect(broker).toContain("state: 'open'");
    expect(broker).toContain('head: `${access.owner}:${access.headBranch}`');
    expect(control).toContain(".selectFrom('githubPublications')");
    expect(control).toContain("'The reconciled GitHub publication identity changed.'");
  });

  it('completes the durable run only after publication identity is persisted', () => {
    expect(control).toContain(".insertInto('githubPublications')");
    expect(control).toContain("status: 'succeeded'");
    expect(control).toContain("eventType: 'publication_reconciled'");
    expect(control).toContain("eventType: 'run_completed'");
    expect(compute).toContain('operation    = "publish_migration_draft_pr"');
    expect(compute).toContain('StringEquals = "completed"');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
