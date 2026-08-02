import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

const migration = source(
  'supabase/migrations/0031_stage_8g_candidate_notifications.sql',
);
const repository = source('services/api/src/repository.ts');
const handler = source('services/api/src/handler.ts');
const web = source('apps/web/src/app.tsx');

describe('Stage 8G candidate-ready notifications', () => {
  it('uses a separate idempotent notification model at candidate reconciliation', () => {
    expect(migration).toContain('create table organisation_notifications');
    expect(migration).toContain('create table notification_recipient_states');
    expect(migration).toContain("event_type = 'migration_candidate_ready'");
    expect(migration).toContain('unique (candidate_id, event_type)');
    expect(migration).toContain('primary key (notification_id, user_id)');
    expect(migration).toContain('migration_candidate_notification_provisioning');
    expect(migration).not.toContain('insert into publication_notification_outbox');
  });

  it('requires the full trusted-release gate before notifying', () => {
    expect(migration).toContain(
      "specification.trust_state in ('reviewed', 'vendor_verified')",
    );
    expect(migration).toContain("release.processing_state = 'validated'");
    expect(migration).toContain(
      "release.trust_state in ('reviewed', 'vendor_verified')",
    );
    expect(migration).toContain("vendor.trust_state = 'trusted'");
    expect(migration).toContain("mapping.status = 'mapped'");
    expect(migration).toContain('not coalesce(mapping_control.disabled, false)');
    expect(migration).toContain("snapshot.status = 'available'");
    expect(migration).toContain('snapshot.expires_at > now()');
    expect(migration).toContain('from repository_snapshots as newer_snapshot');
    expect(migration).toContain("source.source_kind = 'package_registry_release'");
    expect(migration).toContain("source.canonical_domain = 'registry.npmjs.org'");
    expect(migration).toContain("source.trust_state = 'trusted'");
  });

  it('delivers only to current reviewer roles and protects per-user state', () => {
    expect(migration).toContain("membership.role in ('owner', 'admin', 'reviewer')");
    expect(migration).not.toContain(
      "membership.role in ('owner', 'admin', 'reviewer', 'viewer')",
    );
    expect(migration).toContain('create function update_notification_recipient_state(');
    expect(migration).toContain('recipient_state.user_id = p_user_id');
    expect(migration).toContain('notification.organisation_id = p_organisation_id');
    expect(migration).toContain(
      'grant execute on function update_notification_recipient_state(',
    );
    expect(migration).not.toContain('grant update on notification_recipient_states');
    expect(repository).toContain("if (membership.role === 'viewer')");
  });

  it('exposes bounded in-app state operations and no arbitrary source links', () => {
    expect(handler).toContain('/dependency-notifications');
    expect(handler).toContain('candidateNotificationStateRequestSchema.parse');
    expect(repository).toContain(
      "sourceProvenance: 'trusted_registry_and_reviewed_specification'",
    );
    expect(repository).not.toContain('notification.canonicalUrl');
    expect(web).toContain('Updates ready to review');
    expect(web).toContain('Trusted npm source');
    expect(web).toContain('Guidance reviewed');
    expect(web).toContain('Show dismissed');
  });
});
