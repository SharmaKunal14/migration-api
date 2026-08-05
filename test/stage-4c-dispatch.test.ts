import { readFileSync } from 'node:fs';

import { ExecutionAlreadyExists } from '@aws-sdk/client-sfn';
import { describe, expect, it, vi } from 'vitest';

import type { DispatcherConfig } from '@migration/config';

import {
  deterministicExecutionArn,
  retryBackoffSeconds,
  startWorkflowExecution,
  workflowExecutionName,
  type ClaimedEvent,
  type WorkflowStarter,
} from '../services/outbox-dispatcher/src/handler.js';
import { isMigrationApprovalStale } from '../services/workflow-control/src/handler.js';

const migrationRunId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const migrationEvent: ClaimedEvent = {
  kind: 'migration',
  id: '30a75bfd-6a69-4368-a341-10362df73007',
  attempts: 1,
  payload: {
    schemaVersion: '1.0',
    organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
    migrationRunId,
    candidateId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
    approvalId: '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
    repositoryId: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
    correlationId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
    expectedAttempt: 1,
    expectedVersion: 1,
  },
};
const vendorReleaseId = '86b908bf-9fb3-4808-8d47-58c9c0ccb417';
const releaseIntelligenceEvent: ClaimedEvent = {
  kind: 'release_intelligence',
  id: 'd686af04-a313-4427-88ff-b62ffddf4071',
  attempts: 1,
  payload: {
    schemaVersion: '1.0',
    vendorReleaseId,
    correlationId: 'f68add37-af58-4535-83ed-cf550d72d7ed',
  },
};
const dispatcherConfig: DispatcherConfig = {
  APP_ENVIRONMENT: 'development',
  AWS_REGION: 'ap-southeast-2',
  DATABASE_SECRET_ARN:
    'arn:aws:secretsmanager:ap-southeast-2:393209814365:secret:runtime',
  MIGRATION_STATE_MACHINE_ARN:
    'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration-api-development-migration',
  REPOSITORY_SCAN_STATE_MACHINE_ARN:
    'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration-api-development-repository-scan',
  RELEASE_INTELLIGENCE_STATE_MACHINE_ARN:
    'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration-api-development-vendor-ingestion',
  STATE_MACHINE_ARN:
    'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration-api-development-agent',
};

const compute = readFileSync(
  new URL('../infra/terraform/environments/development/compute.tf', import.meta.url),
  'utf8',
);
const dispatcher = readFileSync(
  new URL('../services/outbox-dispatcher/src/handler.ts', import.meta.url),
  'utf8',
);
const workflowControl = readFileSync(
  new URL('../services/workflow-control/src/handler.ts', import.meta.url),
  'utf8',
);
const currentApproval = {
  expiresAt: null,
  approvedBaseBranch: 'main',
  baseCommitSha: 'a'.repeat(40),
  approvedGithubRepositoryId: '1311052469',
  approvedSnapshotDigest: 'b'.repeat(64),
  migrationSpecificationRevision: 1,
  migrationSpecificationDigest: 'c'.repeat(64),
  impactReportRevision: 1,
  impactReportDigest: 'd'.repeat(64),
  candidateStatus: 'open',
  selected: true,
  enabled: true,
  archived: false,
  currentBaseBranch: 'main',
  currentGithubRepositoryId: '1311052469',
  installationStatus: 'active',
  snapshotStatus: 'available',
  commitSha: 'a'.repeat(40),
  currentSnapshotDigest: 'b'.repeat(64),
  snapshotExpiresAt: new Date('2026-08-27T00:00:00.000Z'),
  trustState: 'reviewed',
  specificationRevision: 1,
  evidenceDigest: 'c'.repeat(64),
  reportRevision: 1,
  artifactDigest: 'd'.repeat(64),
  revokedApprovalId: null,
} as const;

describe('Stage 4C durable migration dispatch', () => {
  it('derives one deterministic execution identity from the migration run', () => {
    const name = workflowExecutionName(migrationEvent);
    expect(name).toBe(`migration-${migrationRunId}`);
    expect(
      deterministicExecutionArn(
        'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration-api-development-migration',
        name,
      ),
    ).toBe(
      `arn:aws:states:ap-southeast-2:393209814365:execution:migration-api-development-migration:${name}`,
    );
  });

  it('starts one deterministic release-intelligence execution', async () => {
    const send = vi.fn<WorkflowStarter['send']>(() => Promise.resolve({}));
    const executionArn = await startWorkflowExecution(
      { send },
      releaseIntelligenceEvent,
      dispatcherConfig,
    );
    expect(workflowExecutionName(releaseIntelligenceEvent)).toBe(
      `release-intelligence-${releaseIntelligenceEvent.payload.correlationId}`,
    );
    expect(executionArn).toContain(
      `:execution:migration-api-development-vendor-ingestion:release-intelligence-${releaseIntelligenceEvent.payload.correlationId}`,
    );
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]?.input).toMatchObject({
      stateMachineArn: dispatcherConfig.RELEASE_INTELLIGENCE_STATE_MACHINE_ARN,
      name: `release-intelligence-${releaseIntelligenceEvent.payload.correlationId}`,
    });
  });

  it('rejects malformed state-machine and execution identities', () => {
    expect(() =>
      deterministicExecutionArn('not-an-arn', `migration-${migrationRunId}`),
    ).toThrow();
    expect(() =>
      deterministicExecutionArn(
        'arn:aws:states:ap-southeast-2:393209814365:stateMachine:migration',
        'contains spaces',
      ),
    ).toThrow();
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(retryBackoffSeconds(1, 0)).toBe(1);
    expect(retryBackoffSeconds(5, 1)).toBe(32);
    expect(retryBackoffSeconds(20, 1)).toBe(300);
    expect(retryBackoffSeconds(20, 0)).toBe(150);
  });

  it('reconciles an ambiguous start through the deterministic execution name', async () => {
    const send = vi.fn(() =>
      Promise.reject(
        new ExecutionAlreadyExists({
          $metadata: {},
          message: 'The execution already exists.',
        }),
      ),
    );
    const starter: WorkflowStarter = {
      send,
    };
    await expect(
      startWorkflowExecution(starter, migrationEvent, dispatcherConfig),
    ).resolves.toContain(
      `:execution:migration-api-development-migration:migration-${migrationRunId}`,
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it('propagates transient start failures for leased retry handling', async () => {
    const starter: WorkflowStarter = {
      send: vi.fn(() => Promise.reject(new Error('temporary service failure'))),
    };
    await expect(
      startWorkflowExecution(starter, migrationEvent, dispatcherConfig),
    ).rejects.toThrow('temporary service failure');
  });

  it('fails closed when approval authority is revoked, expired, or changed', () => {
    const now = new Date('2026-07-27T00:00:00.000Z');
    expect(isMigrationApprovalStale(currentApproval, now)).toBe(false);
    expect(
      isMigrationApprovalStale(
        { ...currentApproval, revokedApprovalId: migrationEvent.payload.approvalId },
        now,
      ),
    ).toBe(true);
    expect(
      isMigrationApprovalStale(
        { ...currentApproval, installationStatus: 'suspended' },
        now,
      ),
    ).toBe(true);
    expect(
      isMigrationApprovalStale(
        { ...currentApproval, evidenceDigest: 'e'.repeat(64) },
        now,
      ),
    ).toBe(true);
    expect(
      isMigrationApprovalStale(
        { ...currentApproval, currentBaseBranch: 'renamed-main' },
        now,
      ),
    ).toBe(true);
  });

  it('leases with skip-locked and reconciles already-started executions', () => {
    expect(dispatcher).toContain(".selectFrom('migrationRunOutbox')");
    expect(dispatcher).toContain('.forUpdate()');
    expect(dispatcher).toContain('.skipLocked()');
    expect(dispatcher).toContain('error instanceof ExecutionAlreadyExists');
    expect(dispatcher).toContain('workflowExecutionArn: executionArn');
    expect(dispatcher).toContain('database.transaction()');
  });

  it('creates a least-privilege receiver that delegates to the Stage 4 control plane', () => {
    expect(compute).toContain('resource "aws_sfn_state_machine" "migration"');
    expect(compute).toContain('validate_migration_approval');
    expect(compute).toContain('EnterAcquisition');
    expect(compute).toContain('AcquireExactSnapshot');
    expect(compute).toContain('StopAtUnavailableBoundary');
    expect(compute).toContain('mark_migration_stage_unavailable');
    expect(compute).toContain('aws_sfn_state_machine.migration.arn');
    expect(workflowControl).toContain('MIGRATION_APPROVAL_STALE');
    expect(workflowControl).toContain('MIGRATION_ACQUISITION_NOT_IMPLEMENTED');
  });
});
