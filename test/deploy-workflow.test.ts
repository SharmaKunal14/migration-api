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
});
