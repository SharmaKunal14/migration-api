import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { PublicMigrationCandidateImpactReport } from '@migration/contracts';

import { createMigrationApprovalPreview } from '../services/api/src/repository.js';

const migration = readFileSync(
  new URL('../supabase/migrations/0011_stage_4b_approval.sql', import.meta.url),
  'utf8',
);
const rollback = readFileSync(
  new URL('../supabase/migrations/0011_stage_4b_approval.down.sql', import.meta.url),
  'utf8',
);

const impactReport: PublicMigrationCandidateImpactReport = {
  id: '30a75bfd-6a69-4368-a341-10362df73007',
  outcome: 'affected',
  riskCategory: 'medium',
  freshness: 'current',
  affectedFileCount: 1,
  uncertaintyCount: 0,
  analysedCommit: 'a'.repeat(40),
  snapshotDigest: 'b'.repeat(64),
  artifactDigest: 'c'.repeat(64),
  revision: 1,
  affectedFiles: [
    {
      path: 'src/orbitchat-client.ts',
      classification: 'direct_usage',
      symbols: ['sendMessage'],
      expectedChanges: ['Use messages.create.'],
      retrievalReason: 'Imports @orbitchat/sdk.',
    },
  ],
  unaffectedFiles: [],
  verification: {
    profiles: [
      {
        profile: 'typescript_static',
        availability: 'available',
        reason: 'A typecheck script is declared.',
      },
    ],
  },
  uncertainties: [],
  createdAt: '2026-07-27T00:00:00.000Z',
};

describe('Stage 4B migration approval', () => {
  it('derives deterministic bounded authority from current impact evidence', () => {
    const input = {
      role: 'reviewer',
      candidateStatus: 'open',
      repositoryMutable: true,
      manifestPath: 'package.json',
      lockfilePath: 'package-lock.json',
      impactReport,
    } as const;
    const first = createMigrationApprovalPreview(input);
    const second = createMigrationApprovalPreview(input);

    expect(first).toEqual(second);
    expect(first.eligible).toBe(true);
    expect(first.authority.patchPolicy.allowedPaths).toEqual([
      'package-lock.json',
      'package.json',
      'src/orbitchat-client.ts',
    ]);
    expect(first.authority.verificationProfile.profiles).toContainEqual({
      profile: 'typescript_static',
      availability: 'available',
      commandIds: ['npm.typecheck'],
    });
    expect(first.renderedCopy).toContain('cannot merge');
  });

  it.each([
    ['viewer', { role: 'viewer' as const }, 'APPROVAL_ROLE_REQUIRED'],
    [
      'stale report',
      { impactReport: { ...impactReport, freshness: 'stale' as const } },
      'CURRENT_IMPACT_REPORT_REQUIRED',
    ],
    ['disabled repository', { repositoryMutable: false }, 'REPOSITORY_NOT_MUTABLE'],
  ])('fails closed for a %s', (_name, override, blocker) => {
    const preview = createMigrationApprovalPreview({
      role: 'reviewer',
      candidateStatus: 'open',
      repositoryMutable: true,
      manifestPath: 'package.json',
      lockfilePath: 'package-lock.json',
      impactReport,
      ...override,
    });
    expect(preview.eligible).toBe(false);
    expect(preview.blockers).toContain(blocker);
  });

  it('enforces one active run per tenant candidate', () => {
    expect(migration).toContain('migration_runs_one_active_candidate_idx');
    expect(migration).toContain("where status in ('queued', 'running')");
    expect(rollback).toContain(
      'drop index if exists migration_runs_one_active_candidate_idx',
    );
  });
});
