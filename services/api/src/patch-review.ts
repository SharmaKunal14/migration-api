import { createHash } from 'node:crypto';

import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import {
  migrationApprovalPatchPolicySchema,
  migrationExecutionPlanSchema,
  migrationPatchManifestSchema,
  migrationPatchValidationResultSchema,
  migrationSpecificationSchema,
  type PublicMigrationPatchReview,
} from '@migration/contracts';
import { parsePatchPaths } from '@migration/patch-format';

import type {
  MigrationPatchReviewRecord,
  PatchReviewArtifactRecord,
} from './repository.js';

const MAX_JSON_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;

export async function loadPublicMigrationPatchReview(
  s3: S3Client,
  bucket: string,
  environment: string,
  record: MigrationPatchReviewRecord,
): Promise<PublicMigrationPatchReview> {
  const prefix = `env/${environment}/org/${record.organisationId}/run/${record.migrationRunId}/agent`;
  requireArtifactKey(record.plan, `${prefix}/plan.json`);
  requireArtifactKey(record.patch, `${prefix}/proposal.diff`);
  requireArtifactKey(record.manifest, `${prefix}/patch-manifest.json`);
  requireArtifactKey(record.validation, `${prefix}/patch-validation.json`);
  const [planBytes, patchBytes, manifestBytes, validationBytes] = await Promise.all([
    readArtifact(
      s3,
      bucket,
      record.migrationRunId,
      record.plan,
      MAX_JSON_ARTIFACT_BYTES,
    ),
    readArtifact(s3, bucket, record.migrationRunId, record.patch, MAX_PATCH_BYTES),
    readArtifact(
      s3,
      bucket,
      record.migrationRunId,
      record.manifest,
      MAX_JSON_ARTIFACT_BYTES,
    ),
    readArtifact(
      s3,
      bucket,
      record.migrationRunId,
      record.validation,
      MAX_JSON_ARTIFACT_BYTES,
    ),
  ]);
  const plan = migrationExecutionPlanSchema.parse(parseJson(planBytes));
  const patch = new TextDecoder('utf-8', { fatal: true }).decode(patchBytes);
  const manifest = migrationPatchManifestSchema.parse(parseJson(manifestBytes));
  const validation = migrationPatchValidationResultSchema.parse(
    parseJson(validationBytes),
  );
  const policy = migrationApprovalPatchPolicySchema.parse(record.patchPolicy);
  const specification = migrationSpecificationSchema.parse(record.specification);
  if (
    plan.binding.migrationRunId !== record.migrationRunId ||
    plan.binding.baseCommitSha !== record.baseCommitSha ||
    plan.attemptNumber !== record.attemptNumber ||
    manifest.binding.migrationRunId !== record.migrationRunId ||
    manifest.binding.baseCommitSha !== record.baseCommitSha ||
    manifest.attemptNumber !== record.attemptNumber ||
    validation.binding.migrationRunId !== record.migrationRunId ||
    validation.binding.baseCommitSha !== record.baseCommitSha ||
    validation.attemptNumber !== record.attemptNumber ||
    manifest.planDigest !== record.plan.digest ||
    validation.planDigest !== record.plan.digest ||
    manifest.patchDigest !== record.patch.digest ||
    validation.patchDigest !== record.patch.digest ||
    validation.policyVersion !== record.policyVersion ||
    validation.policyDigest !== record.policyDigest
  ) {
    throw new Error('The migration patch review binding is invalid.');
  }
  const patchPaths = parsePatchPaths(patch);
  if (
    patchPaths.length !== manifest.files.length ||
    patchPaths.some((path, index) => path !== manifest.files[index]?.path)
  ) {
    throw new Error('The migration patch review structure is invalid.');
  }
  const evidenceIds = new Set(plan.files.flatMap(file => file.evidenceChangeIds));
  const changeEvidenceIds = new Set(
    specification.changes
      .filter(change => evidenceIds.has(change.changeId))
      .flatMap(change => change.evidenceIds),
  );
  const evidence = specification.evidence.filter(item =>
    changeEvidenceIds.has(item.evidenceId),
  );
  if (evidence.some(item => new URL(item.sourceUrl).protocol !== 'https:')) {
    throw new Error('The migration patch review evidence URL is invalid.');
  }
  return {
    baseCommitSha: record.baseCommitSha,
    repositoryModifiedRemotely: false,
    plan,
    patch,
    manifest,
    validation,
    policy,
    evidence: evidence.map(item => ({
      evidenceId: item.evidenceId,
      sourceUrl: item.sourceUrl,
      digest: item.digest,
      summary: item.summary,
    })),
    attempts: record.attempts,
  };
}

async function readArtifact(
  s3: S3Client,
  bucket: string,
  migrationRunId: string,
  artifact: PatchReviewArtifactRecord,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (artifact.bytes > maximumBytes) {
    throw new Error('The migration patch review artifact exceeds its size limit.');
  }
  const response = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: artifact.objectKey }),
  );
  const metadataDigest = response.Metadata?.digest;
  const metadataMigrationRunId = response.Metadata?.['migration-run-id'];
  if (
    response.ContentLength !== artifact.bytes ||
    metadataDigest !== artifact.digest ||
    metadataMigrationRunId !== migrationRunId
  ) {
    throw new Error('The migration patch review artifact metadata is invalid.');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== artifact.bytes || digest(bytes) !== artifact.digest) {
    throw new Error('The migration patch review artifact integrity check failed.');
  }
  return bytes;
}

function requireArtifactKey(
  artifact: PatchReviewArtifactRecord,
  expectedKey: string,
): void {
  if (artifact.objectKey !== expectedKey) {
    throw new Error('The migration patch review artifact key is invalid.');
  }
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
