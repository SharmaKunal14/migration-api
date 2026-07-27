import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { revokeMigrationApprovalRequestSchema } from '@migration/contracts';
import { requireAction } from '@migration/domain';

const apiRepository = readFileSync(
  new URL('../services/api/src/repository.ts', import.meta.url),
  'utf8',
);
const webApplication = readFileSync(
  new URL('../apps/web/src/app.tsx', import.meta.url),
  'utf8',
);
const controlPlaneMigration = readFileSync(
  new URL('../supabase/migrations/0010_stage_4a_control_plane.sql', import.meta.url),
  'utf8',
);
const eventMigration = readFileSync(
  new URL('../supabase/migrations/0012_stage_4d_orchestration.sql', import.meta.url),
  'utf8',
);

describe('Stage 4F run history and authorization lifecycle', () => {
  it('accepts only version-bound approval revocation requests', () => {
    expect(
      revokeMigrationApprovalRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'USER_REQUESTED',
      }),
    ).toEqual({ expectedVersion: 3, reasonCode: 'USER_REQUESTED' });
    expect(() =>
      revokeMigrationApprovalRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'free-form reason',
      }),
    ).toThrow();
    expect(() =>
      revokeMigrationApprovalRequestSchema.parse({
        expectedVersion: 3,
        reasonCode: 'USER_REQUESTED',
        force: true,
      }),
    ).toThrow();
  });

  it('allows viewers to inspect history but not revoke approvals', () => {
    const membership = {
      organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      userId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      role: 'viewer',
    } as const;
    expect(requireAction(membership, 'migration:read')).toBe(membership);
    expect(() => requireAction(membership, 'migration:revoke')).toThrow(
      'The actor is not authorized',
    );
  });

  it('uses immutable approval, revocation, and timeline records as audit evidence', () => {
    expect(controlPlaneMigration).toContain('migration_approval_revocations_immutable');
    expect(eventMigration).toContain('migration_run_events_immutable');
    expect(apiRepository).toContain("action: 'migration.approval_revoked'");
    expect(apiRepository).toContain('actor.displayName as actorDisplayName');
  });

  it('fails closed for revocation races and terminal runs', () => {
    expect(apiRepository).toContain(".forUpdate('run')");
    expect(apiRepository).toContain("where('version', '=', run.version)");
    expect(apiRepository).toContain("'MIGRATION_RUN_CHANGED'");
    expect(apiRepository).toContain("'MIGRATION_RUN_TERMINAL'");
    expect(apiRepository).toContain("cancellationReasonCode: 'APPROVAL_REVOKED'");
  });

  it('presents history, safe outcomes, and the no-mutation boundary', () => {
    expect(webApplication).toContain('MigrationRunHistoryPage');
    expect(webApplication).toContain('migrationRunOutcome');
    expect(webApplication).toContain('MIGRATION_APPROVAL_STALE');
    expect(webApplication).toContain('MIGRATION_APPROVAL_REVOKED');
    expect(webApplication).toContain('this run changed no repository content');
  });
});
