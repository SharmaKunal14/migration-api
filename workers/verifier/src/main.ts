import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';

import {
  migrationVerificationResultSchema,
  migrationVerificationWorkItemSchema,
  type MigrationVerificationResult,
} from '@migration/contracts';
import {
  executeVerificationCommand,
  runVerificationProfiles,
} from '@migration/verification-runtime';
import {
  downloadBoundedArtifact,
  materializeVerificationWorkspace,
} from '@migration/verifier-workspace';

const MAX_RESULT_BYTES = 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30_000;

export {
  executeVerificationCommand,
  runVerificationProfiles,
  downloadBoundedArtifact,
  materializeVerificationWorkspace,
};

async function main(): Promise<void> {
  const workItem = migrationVerificationWorkItemSchema.parse(
    JSON.parse(requiredEnvironment('VERIFICATION_WORK_ITEM')),
  );
  const startedAt = new Date();
  const [snapshot, patch] = await Promise.all([
    downloadBoundedArtifact({
      url: workItem.transfers.snapshotDownloadUrl,
      expectedDigest: workItem.snapshot.digest,
      expectedBytes: workItem.snapshot.bytes,
      maximumBytes: 256 * 1024 * 1024,
      artifactBucket: workItem.transfers.artifactBucket,
      awsRegion: workItem.transfers.awsRegion,
    }),
    downloadBoundedArtifact({
      url: workItem.transfers.patchDownloadUrl,
      expectedDigest: workItem.patch.digest,
      expectedBytes: workItem.patch.bytes,
      maximumBytes: 1024 * 1024,
      artifactBucket: workItem.transfers.artifactBucket,
      awsRegion: workItem.transfers.awsRegion,
    }),
  ]);
  await mkdir('/workspace/home', { recursive: true, mode: 0o700 });
  const workspace = await materializeVerificationWorkspace({
    workspaceRoot: '/workspace',
    verificationAttemptId: workItem.verificationAttemptId,
    baseCommitSha: workItem.baseCommitSha,
    snapshot: { bytes: snapshot, digest: workItem.snapshot.digest },
    patch: { bytes: patch, digest: workItem.patch.digest },
  });

  try {
    const runtime = await runVerificationProfiles({
      workspaceRoot: workspace.rootPath,
      repositoryPath: workspace.repositoryPath,
      verificationPolicyVersion: workItem.authority.verificationPolicyVersion,
      selectedProfiles: workItem.authority.verificationProfile.profiles
        .filter(profile => profile.availability === 'available')
        .map(profile => profile.profile),
      authorizedProfiles: workItem.authority.verificationProfile.profiles,
      approvedRegistryUrl: workItem.transfers.approvedRegistryUrl,
    });
    const stdout = artifactReference(
      workItem.transfers.stdoutObjectKey,
      runtime.stdout,
    );
    const stderr = artifactReference(
      workItem.transfers.stderrObjectKey,
      runtime.stderr,
    );
    await Promise.all([
      stdout === null
        ? Promise.resolve()
        : uploadArtifact(
            workItem.transfers.stdoutUploadUrl,
            runtime.stdout,
            workItem,
            'text/plain',
          ),
      stderr === null
        ? Promise.resolve()
        : uploadArtifact(
            workItem.transfers.stderrUploadUrl,
            runtime.stderr,
            workItem,
            'text/plain',
          ),
    ]);
    const commands =
      runtime.outcome === 'policy_rejected' &&
      !runtime.commands.some(command => command.status === 'policy_rejected')
        ? [
            ...runtime.commands,
            {
              commandId: 'policy.runtime',
              status: 'policy_rejected' as const,
              exitCode: null,
              signal: null,
              durationMs: 0,
              stdoutTruncated: false,
              stderrTruncated: false,
            },
          ]
        : runtime.commands;
    const result = migrationVerificationResultSchema.parse({
      schemaVersion: '1.0',
      organisationId: workItem.organisationId,
      repositoryId: workItem.repositoryId,
      migrationRunId: workItem.migrationRunId,
      approvalId: workItem.approvalId,
      verificationAttemptId: workItem.verificationAttemptId,
      attemptNumber: workItem.attemptNumber,
      patchAttemptId: workItem.patchAttemptId,
      baseCommitSha: workItem.baseCommitSha,
      snapshotDigest: workItem.snapshot.digest,
      patchDigest: workItem.patch.digest,
      patchValidationDigest: workItem.patch.validationDigest,
      verificationPolicyVersion: workItem.authority.verificationPolicyVersion,
      verificationProfileDigest: workItem.authority.verificationProfileDigest,
      outcome: runtime.outcome,
      safeErrorCode: runtime.safeErrorCode,
      commands,
      artifacts: { stdout, stderr },
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
    });
    const resultBytes = Buffer.from(JSON.stringify(result), 'utf8');
    if (resultBytes.byteLength > MAX_RESULT_BYTES) {
      throw new Error('The verification result exceeds its size budget.');
    }
    await uploadArtifact(
      workItem.transfers.resultUploadUrl,
      resultBytes,
      workItem,
      'application/json',
    );
    writeLog(result);
  } finally {
    await rm(workspace.rootPath, { recursive: true, force: true });
  }
}

function artifactReference(
  objectKey: string,
  bytes: Buffer,
): MigrationVerificationResult['artifacts']['stdout'] {
  return bytes.byteLength === 0
    ? null
    : {
        objectKey,
        digest: sha256(bytes),
        bytes: bytes.byteLength,
      };
}

async function uploadArtifact(
  urlValue: string,
  bytes: Buffer,
  workItem: {
    readonly transfers: {
      readonly artifactBucket: string;
      readonly artifactKmsKeyArn: string;
      readonly awsRegion: string;
    };
  },
  contentType: string,
): Promise<void> {
  const url = new URL(urlValue);
  const expectedHost = `${workItem.transfers.artifactBucket}.s3.${workItem.transfers.awsRegion}.amazonaws.com`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new Error('The verification upload destination is invalid.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'PUT',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        'content-type': contentType,
        'x-amz-server-side-encryption': 'aws:kms',
        'x-amz-server-side-encryption-aws-kms-key-id':
          workItem.transfers.artifactKmsKeyArn,
        'if-none-match': '*',
      },
      body: new Uint8Array(bytes),
    });
    if ((response.status < 200 || response.status >= 300) && response.status !== 412) {
      throw new Error('The verification artifact upload failed.');
    }
  } finally {
    clearTimeout(timeout);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Invalid service configuration: ${name} is required.`);
  }
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function writeLog(result: MigrationVerificationResult): void {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: result.outcome === 'passed' ? 'info' : 'warn',
      service: 'migration-api',
      event: 'verification_result_written',
      verificationAttemptId: result.verificationAttemptId,
      outcome: result.outcome,
      ...(result.safeErrorCode === null ? {} : { safeErrorCode: result.safeErrorCode }),
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'migration-api',
      event: 'verification_worker_failed',
      safeErrorCode: 'VERIFICATION_INFRASTRUCTURE_FAILED',
      errorClass: error instanceof Error ? error.name : 'Unknown',
    })}\n`,
  );
  if (
    error instanceof Error &&
    error.message.startsWith('Invalid service configuration:')
  ) {
    process.stderr.write(`${error.message}\n`);
  }
  process.exitCode = 1;
});
