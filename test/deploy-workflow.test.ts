import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const deploymentWorkflow = readFileSync(
  fileURLToPath(
    new URL('../.github/workflows/deploy-development.yml', import.meta.url),
  ),
  'utf8',
);

describe('development deployment artifact contract', () => {
  it('packages and verifies every Stage 2 Lambda archive', () => {
    for (const archive of [
      'github-reconciler.zip',
      'github-token-broker.zip',
      'github-webhook.zip',
    ]) {
      expect(deploymentWorkflow.split(archive)).toHaveLength(3);
    }
  });
});
