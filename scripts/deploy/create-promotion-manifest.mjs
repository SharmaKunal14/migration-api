import { readFile, writeFile } from 'node:fs/promises';

import {
  PROMOTION_SCHEMA_VERSION,
  fileDigest,
  publicConfigurationDigest,
  requireEnvironment,
  validatePromotionManifest,
} from './promotion-contract.mjs';

const [imagesPath, payloadPath, outputPath] = process.argv.slice(2);
if (!imagesPath || !payloadPath || !outputPath) {
  throw new Error(
    'Usage: create-promotion-manifest.mjs <images.json> <payload.tar.gz> <manifest.json>',
  );
}

const repository = requireEnvironment('GITHUB_REPOSITORY');
const revision = requireEnvironment('GITHUB_SHA');
const registry = requireEnvironment('ECR_REGISTRY');
const workflowRunId = Number(requireEnvironment('GITHUB_RUN_ID'));
const workflowRunAttempt = Number(requireEnvironment('GITHUB_RUN_ATTEMPT'));
const migratorContentDigest = requireEnvironment('MIGRATOR_CONTENT_DIGEST');
const images = JSON.parse(await readFile(imagesPath, 'utf8'));
const publicConfiguration = {
  apiBaseUrl: requireEnvironment('VITE_API_BASE_URL'),
  supabasePublishableKey: requireEnvironment('VITE_SUPABASE_PUBLISHABLE_KEY'),
  supabaseUrl: requireEnvironment('VITE_SUPABASE_URL'),
};

const manifest = {
  schemaVersion: PROMOTION_SCHEMA_VERSION,
  repository,
  revision,
  ref: requireEnvironment('GITHUB_REF'),
  workflowRunId,
  workflowRunAttempt,
  publicConfigurationDigest: publicConfigurationDigest(publicConfiguration),
  migratorContentDigest,
  payload: {
    file: 'promotion-payload.tar.gz',
    digest: await fileDigest(payloadPath),
  },
  images,
};

validatePromotionManifest(manifest, {
  repository,
  revision,
  workflowRunId,
  registry,
  publicConfigurationDigest: manifest.publicConfigurationDigest,
});
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: 'utf8',
  mode: 0o600,
});
