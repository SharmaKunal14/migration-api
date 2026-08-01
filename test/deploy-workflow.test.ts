import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const deploymentWorkflow = readFileSync(
  fileURLToPath(
    new URL('../.github/workflows/deploy-development.yml', import.meta.url),
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
const verifierDockerfile = readFileSync(
  fileURLToPath(new URL('../workers/verifier/Dockerfile', import.meta.url)),
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

describe('development deployment artifact contract', () => {
  it('packages and verifies every Stage 2 Lambda archive', () => {
    for (const archive of [
      'github-reconciler.zip',
      'github-token-broker.zip',
      'github-webhook.zip',
      'repository-scan-control.zip',
      'package-source-resolver.zip',
    ]) {
      expect(deploymentWorkflow.split(archive)).toHaveLength(3);
    }
  });

  it('builds, scans, and passes an immutable source-fetcher image digest', () => {
    expect(deploymentWorkflow).toContain('workers/source-fetcher/Dockerfile');
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
    expect(deploymentWorkflow).toContain('workers/vendor-fetcher/Dockerfile');
    expect(deploymentWorkflow).toContain('migration-api-development-vendor-fetcher');
    expect(deploymentWorkflow).toContain('TF_VAR_vendor_fetcher_image_digest');
    expect(deploymentWorkflow).toContain('VENDOR_FETCHER_SCAN_DIGEST');
    expect(vendorFetcherDockerfile).toContain('USER node');
  });

  it('builds, scans, and deploys the isolated change-intelligence image', () => {
    expect(deploymentWorkflow).toContain(
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
    expect(deploymentWorkflow).toContain('workers/impact-analysis-agent/Dockerfile');
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

  it('builds, scans, and deploys the hardened verifier image', () => {
    expect(deploymentWorkflow).toContain('workers/verifier/Dockerfile');
    expect(deploymentWorkflow).toContain('migration-api-development-verifier');
    expect(deploymentWorkflow).toContain('TF_VAR_verifier_image_digest');
    expect(deploymentWorkflow).toContain('VERIFIER_SCAN_DIGEST');
    expect(verifierDockerfile).toContain('USER 10001:10001');
    expect(verifierDockerfile).toContain('VOLUME ["/workspace"]');
    expect(verifierDockerfile).toContain(
      'COPY dist/workers/verifier/main.js ./main.js',
    );
  });

  it('uses the verified build once and restores the exact reviewed payload', () => {
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
});
