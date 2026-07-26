import { randomUUID } from 'node:crypto';

import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { z } from 'zod';

import {
  repositoryAcquisitionResultSchema,
  repositoryScanWorkflowInputSchema,
  type RepositoryAcquisitionResult,
  type RepositoryScanWorkflowInput,
} from '@migration/contracts';
import { reconcileCandidatesForRepository } from '@migration/candidate-matching';
import {
  parseConfig,
  repositoryScanControlConfigSchema,
  type RepositoryScanControlConfig,
} from '@migration/config';
import { createDatabase, type AppDatabase } from '@migration/database';
import { isRepositoryScannable } from '@migration/domain';
import { writeLog } from '@migration/observability';

const MAX_RESULT_BYTES = 1024 * 1024;

const commandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('mark_started'),
      workflow: repositoryScanWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('ingest_result'),
      workflow: repositoryScanWorkflowInputSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal('mark_failed'),
      workflow: repositoryScanWorkflowInputSchema,
      safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/u),
    })
    .strict(),
]);

interface ScanControlDependencies {
  readonly config: RepositoryScanControlConfig;
  readonly database: AppDatabase;
  readonly s3: S3Client;
}

let cachedDependencies: ScanControlDependencies | undefined;

async function dependencies(): Promise<ScanControlDependencies> {
  if (cachedDependencies) return cachedDependencies;
  const config = parseConfig(repositoryScanControlConfigSchema);
  cachedDependencies = {
    config,
    database: await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN),
    s3: new S3Client({ region: config.AWS_REGION }),
  };
  return cachedDependencies;
}

export async function handler(event: unknown, context: Context): Promise<unknown> {
  return handleScanCommand(event, context.awsRequestId, await dependencies());
}

export async function handleScanCommand(
  event: unknown,
  requestId: string,
  dependency: ScanControlDependencies,
): Promise<{ readonly status: string }> {
  const command = commandSchema.parse(event);
  if (command.operation === 'mark_started') {
    await markStarted(dependency.database, command.workflow);
    writeLog('info', {
      event: 'repository_scan_started',
      requestId,
      correlationId: command.workflow.correlationId,
      organisationId: command.workflow.organisationId,
      repositoryId: command.workflow.repositoryId,
      repositoryScanId: command.workflow.repositoryScanId,
    });
    return { status: 'running' };
  }
  if (command.operation === 'mark_failed') {
    await markTerminal(
      dependency.database,
      command.workflow,
      'failed',
      command.safeErrorCode,
    );
    return { status: 'failed' };
  }

  const result = await readResult(dependency, command.workflow);
  if (result.status !== 'succeeded') {
    await markTerminal(
      dependency.database,
      command.workflow,
      result.status,
      result.safeErrorCode ?? 'SOURCE_FETCHER_FAILED',
    );
    return { status: result.status };
  }
  await verifySnapshot(dependency, command.workflow, result);
  await persistSuccess(dependency.database, command.workflow, result);
  writeLog('info', {
    event: 'repository_scan_completed',
    requestId,
    correlationId: command.workflow.correlationId,
    organisationId: command.workflow.organisationId,
    repositoryId: command.workflow.repositoryId,
    repositoryScanId: command.workflow.repositoryScanId,
    outcome: String(result.inventory?.observations.length ?? 0),
  });
  return { status: 'succeeded' };
}

async function markStarted(
  database: AppDatabase,
  workflow: RepositoryScanWorkflowInput,
): Promise<void> {
  await database.transaction().execute(async transaction => {
    const scan = await transaction
      .selectFrom('repositoryScans as scan')
      .innerJoin('repositories as repository', join =>
        join
          .onRef('repository.id', '=', 'scan.repositoryId')
          .onRef('repository.organisationId', '=', 'scan.organisationId'),
      )
      .innerJoin(
        'githubInstallations as installation',
        'installation.id',
        'repository.installationId',
      )
      .select([
        'scan.status',
        'scan.version',
        'repository.selected',
        'repository.enabled',
        'repository.archived',
        'installation.status as installationStatus',
      ])
      .where('scan.id', '=', workflow.repositoryScanId)
      .where('scan.repositoryId', '=', workflow.repositoryId)
      .where('scan.organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (scan.status === 'running') return;
    if (
      scan.status !== 'queued' ||
      scan.version !== workflow.expectedVersion ||
      !isRepositoryScannable(scan)
    ) {
      throw new ScanControlError('REPOSITORY_SCAN_STATE_INVALID');
    }
    await transaction
      .updateTable('repositoryScans')
      .set(expression => ({
        status: 'running',
        attempt: expression('attempt', '+', 1),
        startedAt: new Date(),
        updatedAt: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', workflow.repositoryScanId)
      .where('version', '=', workflow.expectedVersion)
      .executeTakeFirstOrThrow();
  });
}

async function readResult(
  dependency: ScanControlDependencies,
  workflow: RepositoryScanWorkflowInput,
): Promise<RepositoryAcquisitionResult> {
  const response = await dependency.s3.send(
    new GetObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: resultObjectKey(dependency.config.APP_ENVIRONMENT, workflow),
    }),
  );
  if (
    response.ContentLength === undefined ||
    response.ContentLength < 1 ||
    response.ContentLength > MAX_RESULT_BYTES
  ) {
    throw new ScanControlError('SCAN_RESULT_SIZE_INVALID');
  }
  const bytes = await response.Body?.transformToByteArray();
  if (bytes?.byteLength !== response.ContentLength) {
    throw new ScanControlError('SCAN_RESULT_READ_FAILED');
  }
  let result: RepositoryAcquisitionResult;
  try {
    result = repositoryAcquisitionResultSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
  } catch {
    throw new ScanControlError('SCAN_RESULT_INVALID');
  }
  if (
    result.organisationId !== workflow.organisationId ||
    result.repositoryId !== workflow.repositoryId ||
    result.repositoryScanId !== workflow.repositoryScanId
  ) {
    throw new ScanControlError('SCAN_RESULT_OWNERSHIP_INVALID');
  }
  return result;
}

async function verifySnapshot(
  dependency: ScanControlDependencies,
  workflow: RepositoryScanWorkflowInput,
  result: RepositoryAcquisitionResult,
): Promise<void> {
  if (!result.snapshot) throw new ScanControlError('SCAN_RESULT_INVALID');
  const expectedKey = snapshotObjectKey(
    dependency.config.APP_ENVIRONMENT,
    workflow,
    result.snapshot.commitSha,
  );
  if (result.snapshot.objectKey !== expectedKey) {
    throw new ScanControlError('SNAPSHOT_KEY_INVALID');
  }
  const head = await dependency.s3.send(
    new HeadObjectCommand({
      Bucket: dependency.config.ARTIFACT_BUCKET,
      Key: expectedKey,
    }),
  );
  if (
    head.ContentLength !== result.snapshot.bytes ||
    head.Metadata?.digest !== result.snapshot.digest ||
    head.Metadata['repository-scan-id'] !== workflow.repositoryScanId ||
    head.Metadata['commit-sha'] !== result.snapshot.commitSha
  ) {
    throw new ScanControlError('SNAPSHOT_METADATA_INVALID');
  }
}

async function persistSuccess(
  database: AppDatabase,
  workflow: RepositoryScanWorkflowInput,
  result: RepositoryAcquisitionResult,
): Promise<void> {
  if (!result.snapshot || !result.inventory) {
    throw new ScanControlError('SCAN_RESULT_INVALID');
  }
  const snapshotResult = result.snapshot;
  const inventoryResult = result.inventory;
  await database.transaction().execute(async transaction => {
    const scan = await transaction
      .selectFrom('repositoryScans')
      .select(['status', 'repositoryId'])
      .where('id', '=', workflow.repositoryScanId)
      .where('organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (scan.status === 'succeeded') return;
    if (scan.status !== 'running' || scan.repositoryId !== workflow.repositoryId) {
      throw new ScanControlError('REPOSITORY_SCAN_STATE_INVALID');
    }
    const existingSnapshot = await transaction
      .selectFrom('repositorySnapshots')
      .select(['id', 'digest'])
      .where('repositoryId', '=', workflow.repositoryId)
      .where('commitSha', '=', snapshotResult.commitSha)
      .where('acquisitionPurpose', '=', 'inventory')
      .executeTakeFirst();
    if (existingSnapshot && existingSnapshot.digest !== snapshotResult.digest) {
      throw new ScanControlError('SNAPSHOT_DIGEST_CONFLICT');
    }
    const observedAt = new Date();
    let snapshotId = existingSnapshot?.id;
    if (!snapshotId) {
      snapshotId = randomUUID();
      const createdSnapshotId = snapshotId;
      await transaction
        .insertInto('repositorySnapshots')
        .values({
          id: createdSnapshotId,
          organisationId: workflow.organisationId,
          repositoryId: workflow.repositoryId,
          repositoryScanId: workflow.repositoryScanId,
          commitSha: snapshotResult.commitSha,
          acquisitionPurpose: 'inventory',
          status: 'available',
          objectKey: snapshotResult.objectKey,
          digest: snapshotResult.digest,
          bytes: snapshotResult.bytes,
          fileCount: snapshotResult.fileCount,
          expiresAt: new Date(snapshotResult.expiresAt),
          createdAt: observedAt,
          updatedAt: observedAt,
        })
        .executeTakeFirstOrThrow();
      if (inventoryResult.observations.length > 0) {
        await transaction
          .insertInto('dependencyObservations')
          .values(
            inventoryResult.observations.map(observation => ({
              id: randomUUID(),
              organisationId: workflow.organisationId,
              repositorySnapshotId: createdSnapshotId,
              packageName: observation.packageName,
              dependencyKind: observation.kind,
              manifestPath: observation.manifestPath,
              lockfilePath: observation.lockfilePath,
              declaredRange: observation.declaredRange,
              resolvedVersion: observation.resolvedVersion,
              discoveryMethod: observation.discoveryMethod,
              createdAt: observedAt,
              updatedAt: observedAt,
            })),
          )
          .execute();
      }
    } else {
      await transaction
        .updateTable('repositorySnapshots')
        .set({
          status: 'available',
          expiresAt: new Date(snapshotResult.expiresAt),
          updatedAt: observedAt,
        })
        .where('id', '=', snapshotId)
        .executeTakeFirstOrThrow();
    }
    await reconcileCandidatesForRepository(
      transaction,
      workflow.repositoryId,
      snapshotId,
      observedAt,
    );
    await transaction
      .updateTable('repositoryScans')
      .set(expression => ({
        requestedCommit: snapshotResult.commitSha,
        status: 'succeeded',
        safeErrorCode: null,
        completedAt: new Date(),
        updatedAt: new Date(),
        version: expression('version', '+', 1),
      }))
      .where('id', '=', workflow.repositoryScanId)
      .where('status', '=', 'running')
      .executeTakeFirstOrThrow();
  });
}

async function markTerminal(
  database: AppDatabase,
  workflow: RepositoryScanWorkflowInput,
  status: 'failed' | 'unsupported',
  safeErrorCode: string,
): Promise<void> {
  await database.transaction().execute(async transaction => {
    const current = await transaction
      .selectFrom('repositoryScans')
      .select(['status', 'startedAt'])
      .where('id', '=', workflow.repositoryScanId)
      .where('repositoryId', '=', workflow.repositoryId)
      .where('organisationId', '=', workflow.organisationId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (!['queued', 'running'].includes(current.status)) return;
    const now = new Date();
    await transaction
      .updateTable('repositoryScans')
      .set(expression => ({
        status,
        safeErrorCode,
        startedAt: current.startedAt ?? now,
        completedAt: now,
        updatedAt: now,
        version: expression('version', '+', 1),
      }))
      .where('id', '=', workflow.repositoryScanId)
      .where('status', 'in', ['queued', 'running'])
      .executeTakeFirstOrThrow();
  });
}

function resultObjectKey(
  environment: string,
  workflow: RepositoryScanWorkflowInput,
): string {
  return `env/${environment}/org/${workflow.organisationId}/repository/${workflow.repositoryId}/scan/${workflow.repositoryScanId}/result.json`;
}

function snapshotObjectKey(
  environment: string,
  workflow: RepositoryScanWorkflowInput,
  commitSha: string,
): string {
  return `env/${environment}/org/${workflow.organisationId}/repository/${workflow.repositoryId}/scan/${workflow.repositoryScanId}/snapshot/${commitSha}.tar.gz`;
}

class ScanControlError extends Error {
  public constructor(public readonly safeCode: string) {
    super('Repository scan control failed.');
    this.name = 'ScanControlError';
  }
}
