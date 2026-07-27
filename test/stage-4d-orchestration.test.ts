import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { cancelMigrationRunRequestSchema } from '@migration/contracts';
import { requireAction } from '@migration/domain';

const migration = readFileSync(
  new URL('../supabase/migrations/0012_stage_4d_orchestration.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL(
    '../supabase/migrations/0012_stage_4d_orchestration.down.sql',
    import.meta.url,
  ),
  'utf8',
);
const compute = readFileSync(
  new URL('../infra/terraform/environments/development/compute.tf', import.meta.url),
  'utf8',
);
const workflowControl = readFileSync(
  new URL('../services/workflow-control/src/handler.ts', import.meta.url),
  'utf8',
);
const migrationStateMachine = compute.slice(
  compute.indexOf('resource "aws_sfn_state_machine" "migration"'),
  compute.indexOf('data "aws_iam_policy_document" "outbox_workflow"'),
);

describe('Stage 4D durable migration orchestration', () => {
  it('accepts only version-bound user cancellation requests', () => {
    expect(
      cancelMigrationRunRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'USER_REQUESTED',
      }),
    ).toEqual({ expectedVersion: 3, reasonCode: 'USER_REQUESTED' });
    expect(() =>
      cancelMigrationRunRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'arbitrary text',
      }),
    ).toThrow();
    expect(() =>
      cancelMigrationRunRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'USER_REQUESTED',
        force: true,
      }),
    ).toThrow();
  });

  it('allows viewers to inspect runs but not cancel them', () => {
    const membership = {
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      userId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      role: 'viewer',
    } as const;
    expect(requireAction(membership, 'migration:read')).toBe(membership);
    expect(() => requireAction(membership, 'migration:cancel')).toThrow(
      'The actor is not authorized',
    );
  });

  it('stores an immutable, tenant-scoped, ordered run timeline', () => {
    expect(migration).toContain('create table migration_run_events');
    expect(migration).toContain('unique (migration_run_id, sequence)');
    expect(migration).toContain('unique (migration_run_id, event_key)');
    expect(migration).toContain('migration_run_events_immutable');
    expect(migration).toContain('actor_type =');
    expect(migration).toContain('inner join migration_approvals');
    expect(rollback).toContain('drop table if exists migration_run_events');
  });

  it('checks cancellation before entering the first effectful future stage', () => {
    expect(migrationStateMachine).toContain('EnterAcquisition');
    expect(migrationStateMachine).toContain('EvaluateAcquisition');
    expect(migrationStateMachine).toContain('Cancelled');
    expect(migrationStateMachine).toContain('StopAtUnavailableBoundary');
    expect(workflowControl).toContain('cancellationRequestedAt');
    expect(workflowControl).toContain('markMigrationCancelled');
    expect(workflowControl).toContain('migration_cancelled_at_safe_boundary');
  });

  it('adds only bounded Stage 5B acquisition without model or GitHub mutation', () => {
    expect(migrationStateMachine).toContain('ecs:runTask.sync');
    expect(migrationStateMachine).not.toContain('github');
    expect(migrationStateMachine).not.toContain('OPENAI');
    expect(workflowControl).toContain('MIGRATION_AGENT_NOT_IMPLEMENTED');
  });
});
