import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const deploymentWorkflow = readFileSync(
  fileURLToPath(
    new URL('../.github/workflows/deploy-development.yml', import.meta.url),
  ),
  'utf8',
);
const ciWorkflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);
const promotionImageBuilder = readFileSync(
  fileURLToPath(
    new URL('../scripts/deploy/build-promotion-images.sh', import.meta.url),
  ),
  'utf8',
);
const migratorDecision = readFileSync(
  fileURLToPath(
    new URL('../scripts/deploy/check-migrator-required.sh', import.meta.url),
  ),
  'utf8',
);
const sourceFetcherDockerfile = readFileSync(
  fileURLToPath(new URL('../workers/source-fetcher/Dockerfile', import.meta.url)),
  'utf8',
);
const vendorFetcherDockerfile = readFileSync(
  fileURLToPath(new URL('../workers/vendor-fetcher/Dockerfile', import.meta.url)),
  'utf8',
);
const changeIntelligenceDockerfile = readFileSync(
  fileURLToPath(
    new URL('../workers/change-intelligence-agent/Dockerfile', import.meta.url),
  ),
  'utf8',
);
const impactAnalysisDockerfile = readFileSync(
  fileURLToPath(
    new URL('../workers/impact-analysis-agent/Dockerfile', import.meta.url),
  ),
  'utf8',
);
const parallelScanWaiter = readFileSync(
  fileURLToPath(new URL('../scripts/deploy/wait-for-ecr-scans.sh', import.meta.url)),
  'utf8',
);
const migratorRunner = readFileSync(
  fileURLToPath(new URL('../scripts/deploy/run-migrator.sh', import.meta.url)),
  'utf8',
);
const bootstrapInfrastructure = readFileSync(
  fileURLToPath(new URL('../infra/terraform/bootstrap/main.tf', import.meta.url)),
  'utf8',
);
const deploymentStorage = readFileSync(
  fileURLToPath(
    new URL('../infra/terraform/environments/development/storage.tf', import.meta.url),
  ),
  'utf8',
);

describe('development deployment artifact contract', () => {
  it('packages and verifies every Stage 2 Lambda archive', () => {
    for (const archive of [
      'github-reconciler.zip',
      'github-token-broker.zip',
      'github-webhook.zip',
      'repository-scan-control.zip',
    ]) {
      expect(deploymentWorkflow.split(archive)).toHaveLength(3);
    }
  });

  it('builds, scans, and passes an immutable source-fetcher image digest', () => {
    expect(promotionImageBuilder).toContain('workers/source-fetcher/Dockerfile');
    expect(ciWorkflow).toContain('Publish attested deployment artifacts');
    expect(deploymentWorkflow).toContain('migration-api-development-source-fetcher');
    expect(deploymentWorkflow).toContain('TF_VAR_source_fetcher_image_digest');
    expect(deploymentWorkflow).toContain('SOURCE_FETCHER_SCAN_DIGEST');
  });

  it('preserves non-root ownership on the source-fetcher workspace bind mount', () => {
    expect(sourceFetcherDockerfile).toContain('RUN mkdir -p /workspace');
    expect(sourceFetcherDockerfile).toContain('chown node:node /workspace');
    expect(sourceFetcherDockerfile).toContain('VOLUME ["/workspace"]');
    expect(sourceFetcherDockerfile).toContain('USER node');
  });

  it('builds, scans, and deploys an immutable vendor-fetcher image', () => {
    expect(promotionImageBuilder).toContain('workers/vendor-fetcher/Dockerfile');
    expect(deploymentWorkflow).toContain('migration-api-development-vendor-fetcher');
    expect(deploymentWorkflow).toContain('TF_VAR_vendor_fetcher_image_digest');
    expect(deploymentWorkflow).toContain('VENDOR_FETCHER_SCAN_DIGEST');
    expect(vendorFetcherDockerfile).toContain('USER node');
  });

  it('builds, scans, and deploys the isolated change-intelligence image', () => {
    expect(promotionImageBuilder).toContain(
      'workers/change-intelligence-agent/Dockerfile',
    );
    expect(deploymentWorkflow).toContain(
      'migration-api-development-change-intelligence-agent',
    );
    expect(deploymentWorkflow).toContain(
      'TF_VAR_change_intelligence_agent_image_digest',
    );
    expect(deploymentWorkflow).toContain('CHANGE_INTELLIGENCE_AGENT_SCAN_DIGEST');
    expect(changeIntelligenceDockerfile).toContain('USER 10001:10001');
    expect(changeIntelligenceDockerfile).toContain(
      'COPY dist/workers/change-intelligence-agent/main.js /app/main.js',
    );
  });

  it('builds, scans, and deploys the isolated impact-analysis image', () => {
    expect(promotionImageBuilder).toContain('workers/impact-analysis-agent/Dockerfile');
    expect(deploymentWorkflow).toContain(
      'migration-api-development-impact-analysis-agent',
    );
    expect(deploymentWorkflow).toContain('TF_VAR_impact_analysis_agent_image_digest');
    expect(deploymentWorkflow).toContain('IMPACT_ANALYSIS_AGENT_SCAN_DIGEST');
    expect(impactAnalysisDockerfile).toContain('USER 10001:10001');
    expect(impactAnalysisDockerfile).toContain(
      'COPY dist/workers/impact-analysis-agent/main.js /app/main.js',
    );
  });

  it('uses the verified build once and restores the exact reviewed payload', () => {
    expect(deploymentWorkflow).toContain('gh attestation verify');
    expect(deploymentWorkflow).toContain('--source-digest "${GITHUB_SHA}"');
    expect(deploymentWorkflow).toContain('--deny-self-hosted-runners');
    expect(deploymentWorkflow).not.toContain('npm run check');
    expect(deploymentWorkflow).not.toContain('docker buildx build');
    expect(deploymentWorkflow).not.toContain('- name: Build deployable browser assets');
    expect(deploymentWorkflow).not.toContain('- name: Rebuild local deployment inputs');
    expect(deploymentWorkflow).toContain(
      'sha256sum --check deployment-plan-payload.tar.gz.sha256',
    );
    expect(deploymentWorkflow).not.toMatch(
      /deployment-plan-payload\.tar\.gz[\s\S]*dist\/services\s*\n/u,
    );
  });

  it('waits for all mandatory ECR scan gates concurrently', () => {
    expect(deploymentWorkflow).toContain('scripts/deploy/wait-for-ecr-scans.sh');
    expect(parallelScanWaiter).toContain('bash scripts/deploy/wait-for-ecr-scan.sh');
    expect(parallelScanWaiter).toContain('wait "${scan_pids[${index}]}"');
    expect(parallelScanWaiter).toContain('exit "${failed}"');
  });

  it('prints the failed migrator task log stream without masking the failure', () => {
    expect(migratorRunner).toContain(
      'log_stream_name="migration/database-migrator/${task_id}"',
    );
    expect(migratorRunner).toContain('aws logs get-log-events');
    expect(migratorRunner).toContain('exit 1');
  });

  it('runs the migrator only when its last successful content digest differs', () => {
    expect(deploymentWorkflow).toContain(
      "if: steps.migration.outputs.required == 'true'",
    );
    expect(deploymentWorkflow).toContain('MIGRATOR_CONTENT_DIGEST');
    expect(migratorDecision).toContain('aws ssm get-parameter');
    expect(migratorRunner).toContain('aws ssm put-parameter');
    expect(migratorRunner).toContain('Database migration completed successfully.');
    expect(
      migratorRunner.indexOf('Database migration completed successfully.'),
    ).toBeLessThan(migratorRunner.indexOf('aws ssm put-parameter'));
    expect(deploymentStorage).toContain(
      'resource "aws_ssm_parameter" "migrator_success_digest"',
    );
    expect(deploymentStorage).toContain('type        = "SecureString"');
    expect(deploymentStorage).toContain('ignore_changes = [value]');
  });

  it('publishes CI images through a separate main-only least-privilege role', () => {
    expect(bootstrapInfrastructure).toContain('github_ci_oidc_subject');
    expect(bootstrapInfrastructure).toContain(':ref:refs/heads/main');
    expect(bootstrapInfrastructure).toContain(
      'resource "aws_iam_role" "github_ci_artifacts"',
    );
    expect(bootstrapInfrastructure).toContain('sid       = "EcrAuthorization"');
    expect(bootstrapInfrastructure).not.toMatch(
      /data "aws_iam_policy_document" "github_ci_artifacts"[\s\S]*?"(lambda|iam|s3|ssm):\*"/u,
    );
  });
});
