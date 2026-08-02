import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL(
    '../supabase/migrations/0027_stage_8d_npm_release_polling.sql',
    import.meta.url,
  ),
  'utf8',
);
const infrastructure = readFileSync(
  new URL(
    '../infra/terraform/environments/development/package-release-polling.tf',
    import.meta.url,
  ),
  'utf8',
);
const bootstrap = readFileSync(
  new URL('../infra/terraform/bootstrap/main.tf', import.meta.url),
  'utf8',
);
const claimAmbiguityFix = readFileSync(
  new URL(
    '../supabase/migrations/0028_fix_package_source_poll_claim_ambiguity.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('stage 8D package release polling', () => {
  it('uses leased bounded claims and idempotent logical releases', () => {
    expect(migration).toContain('for update of source skip locked');
    expect(migration).toContain('package_source_poll_states');
    expect(migration).toContain('PACKAGE_SOURCE_POLL_LEASE_EXPIRED');
    expect(migration).toContain('unique (api_product_id, version)');
    expect(migration).toContain("'NPM_REGISTRY_VERSION_ROLLBACK'");
    expect(migration).toContain('package_version_deprecation_states');
  });

  it('qualifies the poll-state conflict target against PL/pgSQL output names', () => {
    expect(claimAmbiguityFix).toContain(
      'on conflict on constraint package_source_poll_states_pkey do nothing',
    );
    expect(claimAmbiguityFix).not.toContain('on conflict (source_id) do nothing');
    expect(claimAmbiguityFix).toContain(
      'where package_source_poll_runs.source_id = claimed.source_id',
    );
  });

  it('keeps runtime table access denied and exposes only bounded functions', () => {
    expect(migration).toMatch(
      /revoke all on package_source_poll_states,[\s\S]*from public, anon, authenticated, app_runtime;/u,
    );
    expect(migration).toContain(
      'grant execute on function claim_due_npm_package_sources(uuid, uuid, integer, integer)',
    );
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete)[\s\S]*package_source_poll_states[\s\S]*to app_runtime/iu,
    );
  });

  it('deploys a bounded scheduled Lambda with a DLQ and alarms', () => {
    expect(infrastructure).toContain(
      'resource "aws_lambda_function" "package_release_poller"',
    );
    expect(infrastructure).toContain('reserved_concurrent_executions = 1');
    expect(infrastructure).toContain(
      'schedule_expression          = "rate(15 minutes)"',
    );
    expect(infrastructure).toContain('dead_letter_config');
    expect(infrastructure).toContain(
      'resource "aws_cloudwatch_metric_alarm" "package_release_poll_exhausted"',
    );
    expect(infrastructure).toContain(
      '${aws_s3_bucket.artifacts.arn}/env/development/package-release/npm/*',
    );
  });

  it('allows the deployment role to manage only the named release-poller DLQ', () => {
    expect(bootstrap).toContain('"sqs:CreateQueue"');
    expect(bootstrap).toContain('migration-api-development-package-release-poller-dlq');
    expect(bootstrap).not.toContain('arn:aws:sqs:${var.aws_region}:*:*');
  });

  it('does not retire state-owned CI signing resources as a polling side effect', () => {
    expect(bootstrap).toContain('resource "aws_kms_key" "promotion_signing"');
    expect(bootstrap).toContain('resource "aws_iam_role" "github_ci_artifacts"');
    expect(bootstrap).toContain('prevent_destroy = true');
    expect(bootstrap).toMatch(/sid\s*=\s*"ProtectCiPromotionKey"/u);
  });
});
