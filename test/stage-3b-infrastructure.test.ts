import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const compute = fixture('../infra/terraform/environments/development/compute.tf');
const iam = fixture('../infra/terraform/environments/development/iam.tf');
const migration = fixture('../supabase/migrations/0005_stage_3b.sql');

describe('Stage 3B infrastructure boundaries', () => {
  it('runs a dedicated, non-root, read-only task with identifier-only overrides', () => {
    expect(compute).toContain('resource "aws_ecs_task_definition" "vendor_fetcher"');
    expect(compute).toContain('readonlyRootFilesystem = true');
    expect(compute).toContain('user                   = "1000:1000"');
    expect(compute).toContain(
      '{ Name = "VENDOR_RELEASE_ID", "Value.$" = "$.vendorReleaseId" }',
    );
    expect(compute).toContain(
      '{ Name = "CORRELATION_ID", "Value.$" = "$.correlationId" }',
    );
    expect(compute).not.toContain(
      '{ Name = "VENDOR_SOURCE_URL", "Value.$" = "$.vendorSourceUrl" }',
    );
  });

  it('does not grant vendor ingestion GitHub, model, shell, or broad S3 access', () => {
    const policy =
      /data "aws_iam_policy_document" "vendor_fetcher_task" \{(?<body>[\s\S]*?)resource "aws_iam_role_policy" "vendor_fetcher_task"/u.exec(
        iam,
      )?.groups?.body;
    expect(policy).toBeDefined();
    expect(policy).toContain('/env/development/vendor/*');
    expect(policy).not.toContain('github');
    expect(policy).not.toContain('lambda:InvokeFunction');
    expect(policy).not.toContain('sts:GetWebIdentityToken');
    expect(policy).not.toContain('resources = ["*"]');
  });

  it('constrains ingestion state and immutable evidence metadata in SQL', () => {
    expect(migration).toContain(
      "status text not null check (status in ('running', 'succeeded', 'failed'))",
    );
    expect(migration).toContain('unique (vendor_release_id, vendor_source_id)');
    expect(migration).toContain("and canonical_url like 'https://%'");
    expect(migration).toContain("object_key !~ '(^|/)\\.\\.?(/|$)'");
  });
});
