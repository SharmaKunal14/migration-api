import { appendFile, readFile } from 'node:fs/promises';

import {
  IMAGE_DEFINITIONS,
  fileDigest,
  publicConfigurationDigest,
  requireEnvironment,
  validatePromotionManifest,
} from './promotion-contract.mjs';

const [manifestPath, payloadPath, workflowRunIdText] = process.argv.slice(2);
if (!manifestPath || !payloadPath || !workflowRunIdText) {
  throw new Error(
    'Usage: verify-promotion.mjs <manifest.json> <payload.tar.gz> <workflow-run-id>',
  );
}

const workflowRunId = Number(workflowRunIdText);
const registry = requireEnvironment('ECR_REGISTRY');
const manifest = validatePromotionManifest(
  JSON.parse(await readFile(manifestPath, 'utf8')),
  {
    repository: requireEnvironment('GITHUB_REPOSITORY'),
    revision: requireEnvironment('GITHUB_SHA'),
    workflowRunId,
    registry,
    publicConfigurationDigest: publicConfigurationDigest({
      apiBaseUrl: requireEnvironment('VITE_API_BASE_URL'),
      supabasePublishableKey: requireEnvironment('VITE_SUPABASE_PUBLISHABLE_KEY'),
      supabaseUrl: requireEnvironment('VITE_SUPABASE_URL'),
    }),
  },
);

if ((await fileDigest(payloadPath)) !== manifest.payload.digest) {
  throw new Error('The promotion payload digest does not match the signed manifest.');
}

const environmentFile = requireEnvironment('GITHUB_ENV');
const outputFile = requireEnvironment('GITHUB_OUTPUT');
const images = new Map(manifest.images.map(image => [image.key, image]));
for (const definition of IMAGE_DEFINITIONS) {
  const image = images.get(definition.key);
  await appendFile(
    environmentFile,
    `${definition.terraformVariable}=${image.digest}\n${definition.scanVariable}=${image.scanDigest}\n`,
  );
  await appendFile(outputFile, `${definition.outputName}=${image.digest}\n`);
}
await appendFile(
  environmentFile,
  `MIGRATOR_CONTENT_DIGEST=${manifest.migratorContentDigest}\nCI_PROMOTION_RUN_ID=${workflowRunId}\n`,
);
await appendFile(
  outputFile,
  `migrator_content_digest=${manifest.migratorContentDigest}\nci_run_id=${workflowRunId}\n`,
);
