import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const PROMOTION_SCHEMA_VERSION = '1.0';
export const IMAGE_DEFINITIONS = Object.freeze([
  {
    key: 'agent',
    repository: 'migration-api-development-agent',
    terraformVariable: 'TF_VAR_agent_image_digest',
    scanVariable: 'AGENT_SCAN_DIGEST',
    outputName: 'agent_image_digest',
  },
  {
    key: 'migrator',
    repository: 'migration-api-development-database-migrator',
    terraformVariable: 'TF_VAR_migrator_image_digest',
    scanVariable: 'MIGRATOR_SCAN_DIGEST',
    outputName: 'migrator_image_digest',
  },
  {
    key: 'sourceFetcher',
    repository: 'migration-api-development-source-fetcher',
    terraformVariable: 'TF_VAR_source_fetcher_image_digest',
    scanVariable: 'SOURCE_FETCHER_SCAN_DIGEST',
    outputName: 'source_fetcher_image_digest',
  },
  {
    key: 'vendorFetcher',
    repository: 'migration-api-development-vendor-fetcher',
    terraformVariable: 'TF_VAR_vendor_fetcher_image_digest',
    scanVariable: 'VENDOR_FETCHER_SCAN_DIGEST',
    outputName: 'vendor_fetcher_image_digest',
  },
  {
    key: 'changeIntelligenceAgent',
    repository: 'migration-api-development-change-intelligence-agent',
    terraformVariable: 'TF_VAR_change_intelligence_agent_image_digest',
    scanVariable: 'CHANGE_INTELLIGENCE_AGENT_SCAN_DIGEST',
    outputName: 'change_intelligence_agent_image_digest',
  },
  {
    key: 'impactAnalysisAgent',
    repository: 'migration-api-development-impact-analysis-agent',
    terraformVariable: 'TF_VAR_impact_analysis_agent_image_digest',
    scanVariable: 'IMPACT_ANALYSIS_AGENT_SCAN_DIGEST',
    outputName: 'impact_analysis_agent_image_digest',
  },
  {
    key: 'migrationAgent',
    repository: 'migration-api-development-migration-agent',
    terraformVariable: 'TF_VAR_migration_agent_image_digest',
    scanVariable: 'MIGRATION_AGENT_SCAN_DIGEST',
    outputName: 'migration_agent_image_digest',
  },
]);

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const REGISTRY_PATTERN = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/u;

export function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function assertSha256(value, field) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${field} must be a lowercase sha256 digest.`);
  }
  return value;
}

export function publicConfigurationDigest(configuration) {
  const canonical = JSON.stringify({
    apiBaseUrl: configuration.apiBaseUrl,
    supabasePublishableKey: configuration.supabasePublishableKey,
    supabaseUrl: configuration.supabaseUrl,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

export async function fileDigest(path) {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

export function validatePromotionManifest(manifest, expected) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('The promotion manifest must be a JSON object.');
  }
  if (manifest.schemaVersion !== PROMOTION_SCHEMA_VERSION) {
    throw new Error('The promotion manifest schema version is unsupported.');
  }
  if (
    typeof manifest.repository !== 'string' ||
    !REPOSITORY_PATTERN.test(manifest.repository) ||
    manifest.repository !== expected.repository
  ) {
    throw new Error('The promotion repository does not match this deployment.');
  }
  if (manifest.revision !== expected.revision) {
    throw new Error('The promotion revision does not match the selected commit.');
  }
  if (manifest.ref !== 'refs/heads/main') {
    throw new Error('Only artifacts produced from refs/heads/main may be promoted.');
  }
  if (
    !Number.isSafeInteger(manifest.workflowRunId) ||
    manifest.workflowRunId <= 0 ||
    manifest.workflowRunId !== expected.workflowRunId
  ) {
    throw new Error(
      'The promotion workflow run does not match the downloaded artifact.',
    );
  }
  if (
    !Number.isSafeInteger(manifest.workflowRunAttempt) ||
    manifest.workflowRunAttempt <= 0
  ) {
    throw new Error('The promotion workflow run attempt is invalid.');
  }
  if (manifest.publicConfigurationDigest !== expected.publicConfigurationDigest) {
    throw new Error(
      'The promoted web configuration differs from the protected deployment configuration.',
    );
  }
  assertSha256(manifest.migratorContentDigest, 'migratorContentDigest');
  if (
    !manifest.payload ||
    manifest.payload.file !== 'promotion-payload.tar.gz' ||
    typeof manifest.payload.digest !== 'string'
  ) {
    throw new Error('The promotion payload binding is invalid.');
  }
  assertSha256(manifest.payload.digest, 'payload.digest');
  if (
    !Array.isArray(manifest.images) ||
    manifest.images.length !== IMAGE_DEFINITIONS.length
  ) {
    throw new Error(
      'The promotion manifest must contain every deployable image exactly once.',
    );
  }
  if (!REGISTRY_PATTERN.test(expected.registry)) {
    throw new Error('The expected ECR registry is invalid.');
  }

  const images = new Map();
  for (const image of manifest.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)) {
      throw new Error('A promotion image entry is invalid.');
    }
    if (typeof image.key !== 'string' || images.has(image.key)) {
      throw new Error('Promotion image keys must be unique.');
    }
    images.set(image.key, image);
  }

  for (const definition of IMAGE_DEFINITIONS) {
    const image = images.get(definition.key);
    if (!image || image.repository !== definition.repository) {
      throw new Error(`The ${definition.key} repository binding is invalid.`);
    }
    if (image.subjectName !== `${expected.registry}/${definition.repository}`) {
      throw new Error(`The ${definition.key} registry subject is invalid.`);
    }
    assertSha256(image.digest, `${definition.key}.digest`);
    assertSha256(image.scanDigest, `${definition.key}.scanDigest`);
  }

  return manifest;
}
