import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  migrationExecutionStageSchema,
  migrationStageCapabilityStatusSchema,
  stageUnavailableSafeErrorCode,
} from '../services/workflow-control/src/handler.js';

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

describe('Stage 4E full migration workflow skeleton', () => {
  it('models every future execution boundary explicitly', () => {
    for (const state of [
      'ValidateApproval',
      'AcquireExactSnapshot',
      'RunMigrationAgent',
      'ValidatePatch',
      'RunVerifier',
      'RunMigrationRepairAgent',
      'PublishDraftPR',
      'ReconcilePublication',
      'RecordSuccess',
      'Complete',
      'Cancelled',
      'StaleApproval',
      'MigrationInfrastructureFailed',
    ]) {
      expect(migrationStateMachine).toContain(`${state} = {`);
    }
  });

  it('keeps the current control-plane capability contract fail-closed', () => {
    expect(migrationStageCapabilityStatusSchema.parse('unavailable')).toBe(
      'unavailable',
    );
    expect(migrationStageCapabilityStatusSchema.parse('cancelled')).toBe('cancelled');
    expect(() => migrationStageCapabilityStatusSchema.parse('completed')).toThrow();
    expect(workflowControl).toContain("return 'unavailable'");
    expect(migrationStateMachine).toContain('StopAtUnavailableBoundary');
  });

  it('uses strict stage identifiers and stage-specific safe errors', () => {
    expect(migrationExecutionStageSchema.options).toEqual([
      'acquiring',
      'planning',
      'patching',
      'verifying',
      'repairing',
      'publishing',
    ]);
    expect(stageUnavailableSafeErrorCode('acquiring')).toBe(
      'MIGRATION_ACQUISITION_NOT_IMPLEMENTED',
    );
    expect(stageUnavailableSafeErrorCode('planning')).toBe(
      'MIGRATION_AGENT_NOT_IMPLEMENTED',
    );
    expect(stageUnavailableSafeErrorCode('verifying')).toBe(
      'MIGRATION_VERIFICATION_NOT_IMPLEMENTED',
    );
    expect(stageUnavailableSafeErrorCode('publishing')).toBe(
      'MIGRATION_PUBLICATION_NOT_IMPLEMENTED',
    );
  });

  it('checks cancellation at every future capability boundary', () => {
    expect(workflowControl).toContain('cancellationRequestedAt');
    expect(workflowControl).toContain('markMigrationCancelled');
    expect(
      migrationStateMachine.match(/StringEquals = "cancelled"/gu)?.length,
    ).toBeGreaterThanOrEqual(10);
  });

  it('bounds the future repair loop and records budget exhaustion', () => {
    expect(migrationStateMachine).toContain('NumericLessThan = 2');
    expect(migrationStateMachine).toContain(
      '"repairAttempts.$" = "States.MathAdd($.repairAttempts, 1)"',
    );
    expect(migrationStateMachine).toContain('RepairBudgetExhausted');
    expect(workflowControl).toContain('MIGRATION_REPAIR_BUDGET_EXHAUSTED');
  });

  it('wires only the Stage 5B source workload and keeps later capabilities closed', () => {
    expect(migrationStateMachine).toContain('ecs:runTask.sync');
    expect(migrationStateMachine).not.toContain('OPENAI');
    expect(migrationStateMachine).not.toContain('github-token');
    expect(migrationStateMachine).toContain('source-fetcher');
    expect(migrationStateMachine).toContain('ingest_migration_acquisition');
    expect(migrationStateMachine).not.toContain('impact-analysis-agent');
  });
});
