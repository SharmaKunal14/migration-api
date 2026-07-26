begin;

alter table github_installations
  add constraint github_installations_stage4_organisation_identity_unique
  unique (id, organisation_id);

alter table repositories
  add constraint repositories_stage4_approval_identity_unique
  unique (id, organisation_id, installation_id, github_repository_id);

alter table repositories
  add constraint repositories_stage4_installation_organisation_fk
  foreign key (installation_id, organisation_id)
  references github_installations(id, organisation_id) on delete cascade;

alter table migration_candidates
  add constraint migration_candidates_stage4_approval_identity_unique
  unique (id, organisation_id, repository_id, migration_specification_id);

alter table migration_candidates
  add constraint migration_candidates_stage4_run_identity_unique
  unique (id, organisation_id, repository_id);

alter table repository_snapshots
  add constraint repository_snapshots_stage4_approval_identity_unique
  unique (id, organisation_id, repository_id, commit_sha, digest);

alter table repository_snapshots
  add constraint repository_snapshots_stage4_repository_organisation_fk
  foreign key (repository_id, organisation_id)
  references repositories(id, organisation_id) on delete cascade;

alter table migration_specifications
  add constraint migration_specifications_stage4_approval_identity_unique
  unique (id, revision, evidence_digest);

alter table impact_reports
  add constraint impact_reports_stage4_approval_identity_unique
  unique (
    id,
    candidate_id,
    repository_id,
    repository_snapshot_id,
    revision,
    artifact_digest
  );

create table migration_approvals (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete restrict,
  candidate_id uuid not null,
  repository_id uuid not null,
  github_repository_id bigint not null check (github_repository_id > 0),
  installation_id uuid not null,
  repository_snapshot_id uuid not null,
  base_branch text not null check (length(base_branch) between 1 and 255),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  migration_specification_id uuid not null,
  migration_specification_revision integer not null
    check (migration_specification_revision > 0),
  migration_specification_digest text not null
    check (migration_specification_digest ~ '^[a-f0-9]{64}$'),
  impact_report_id uuid not null,
  impact_report_revision integer not null check (impact_report_revision > 0),
  impact_report_digest text not null check (
    impact_report_digest ~ '^[a-f0-9]{64}$'
  ),
  approval_contract_version text not null check (
    approval_contract_version = '1.0'
  ),
  agent_policy_version text not null check (
    agent_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  tool_registry_version text not null check (
    tool_registry_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  patch_policy_version text not null check (
    patch_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  patch_policy jsonb not null check (
    jsonb_typeof(patch_policy) = 'object'
    and pg_column_size(patch_policy) <= 65536
  ),
  patch_policy_digest text not null check (
    patch_policy_digest ~ '^[a-f0-9]{64}$'
  ),
  verification_policy_version text not null check (
    verification_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  verification_profile jsonb not null check (
    jsonb_typeof(verification_profile) = 'object'
    and pg_column_size(verification_profile) <= 32768
  ),
  verification_profile_digest text not null check (
    verification_profile_digest ~ '^[a-f0-9]{64}$'
  ),
  publication_policy_version text not null check (
    publication_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  openai_processing_policy_version text not null check (
    openai_processing_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  openai_processing_mode text not null check (
    openai_processing_mode in ('default_controls', 'verified_zdr')
  ),
  acknowledgement_source_processing boolean not null,
  acknowledgement_verification_execution boolean not null,
  acknowledgement_draft_pull_request boolean not null,
  acknowledgement_human_review_required boolean not null,
  rendered_copy_digest text not null check (
    rendered_copy_digest ~ '^[a-f0-9]{64}$'
  ),
  approved_by_user_id uuid not null references app_users(id) on delete restrict,
  approved_by_role text not null check (
    approved_by_role in ('owner', 'admin', 'reviewer')
  ),
  request_id uuid not null,
  correlation_id uuid not null,
  idempotency_key text not null check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'
  ),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  approved_at timestamptz not null,
  expires_at timestamptz,
  created_at timestamptz not null,
  foreign key (
    candidate_id,
    organisation_id,
    repository_id,
    migration_specification_id
  ) references migration_candidates (
    id,
    organisation_id,
    repository_id,
    migration_specification_id
  ) on delete restrict,
  foreign key (
    repository_id,
    organisation_id,
    installation_id,
    github_repository_id
  ) references repositories (
    id,
    organisation_id,
    installation_id,
    github_repository_id
  ) on delete restrict,
  foreign key (
    repository_snapshot_id,
    organisation_id,
    repository_id,
    base_commit_sha,
    snapshot_digest
  ) references repository_snapshots (
    id,
    organisation_id,
    repository_id,
    commit_sha,
    digest
  ) on delete restrict,
  foreign key (
    migration_specification_id,
    migration_specification_revision,
    migration_specification_digest
  ) references migration_specifications (
    id,
    revision,
    evidence_digest
  ) on delete restrict,
  foreign key (
    impact_report_id,
    candidate_id,
    repository_id,
    repository_snapshot_id,
    impact_report_revision,
    impact_report_digest
  ) references impact_reports (
    id,
    candidate_id,
    repository_id,
    repository_snapshot_id,
    revision,
    artifact_digest
  ) on delete restrict,
  unique (
    id,
    organisation_id,
    candidate_id,
    repository_id,
    base_commit_sha
  ),
  unique (approved_by_user_id, idempotency_key),
  check (
    acknowledgement_source_processing
    and acknowledgement_verification_execution
    and acknowledgement_draft_pull_request
    and acknowledgement_human_review_required
  ),
  check (created_at = approved_at),
  check (expires_at is null or expires_at > approved_at)
);

create index migration_approvals_candidate_idx
  on migration_approvals (organisation_id, candidate_id, approved_at desc);

create table migration_approval_revocations (
  approval_id uuid primary key
    references migration_approvals(id) on delete restrict,
  revoked_by_user_id uuid not null references app_users(id) on delete restrict,
  revoked_by_role text not null check (
    revoked_by_role in ('owner', 'admin', 'reviewer')
  ),
  reason_code text not null check (
    reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  request_id uuid not null,
  revoked_at timestamptz not null,
  created_at timestamptz not null,
  check (created_at = revoked_at)
);

create table migration_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete restrict,
  candidate_id uuid not null,
  approval_id uuid not null unique,
  repository_id uuid not null,
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  status text not null check (
    status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale')
  ),
  current_stage text not null check (
    current_stage in (
      'queued',
      'revalidating',
      'acquiring',
      'planning',
      'patching',
      'verifying',
      'repairing',
      'publishing',
      'completed',
      'failed',
      'cancelled',
      'stale'
    )
  ),
  attempt integer not null default 1 check (attempt between 1 and 10),
  workflow_execution_arn text check (
    workflow_execution_arn is null
    or (
      length(workflow_execution_arn) between 20 and 2048
      and workflow_execution_arn
        ~ '^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9+=,.@_-]+:[A-Za-z0-9+=,.@_-]+$'
    )
  ),
  terminal_result text check (
    terminal_result is null
    or terminal_result in ('completed', 'failed', 'cancelled', 'stale')
  ),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  correlation_id uuid not null,
  cancellation_requested_at timestamptz,
  cancellation_requested_by_user_id uuid
    references app_users(id) on delete restrict,
  cancellation_reason_code text check (
    cancellation_reason_code is null
    or cancellation_reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null,
  foreign key (candidate_id, organisation_id, repository_id)
    references migration_candidates(id, organisation_id, repository_id)
    on delete restrict,
  foreign key (
    approval_id,
    organisation_id,
    candidate_id,
    repository_id,
    base_commit_sha
  ) references migration_approvals (
    id,
    organisation_id,
    candidate_id,
    repository_id,
    base_commit_sha
  ) on delete restrict,
  unique (id, organisation_id),
  check (
    (
      status = 'queued'
      and current_stage = 'queued'
      and started_at is null
      and completed_at is null
      and terminal_result is null
      and safe_error_code is null
    )
    or (
      status = 'running'
      and current_stage in (
        'revalidating',
        'acquiring',
        'planning',
        'patching',
        'verifying',
        'repairing',
        'publishing'
      )
      and started_at is not null
      and completed_at is null
      and terminal_result is null
      and safe_error_code is null
    )
    or (
      status = 'succeeded'
      and current_stage = 'completed'
      and terminal_result = 'completed'
      and completed_at is not null
      and safe_error_code is null
    )
    or (
      status = 'failed'
      and current_stage = 'failed'
      and terminal_result = 'failed'
      and completed_at is not null
      and safe_error_code is not null
    )
    or (
      status = 'cancelled'
      and current_stage = 'cancelled'
      and terminal_result = 'cancelled'
      and completed_at is not null
      and safe_error_code is null
    )
    or (
      status = 'stale'
      and current_stage = 'stale'
      and terminal_result = 'stale'
      and completed_at is not null
      and safe_error_code is not null
    )
  ),
  check (
    (cancellation_requested_at is null
      and cancellation_requested_by_user_id is null
      and cancellation_reason_code is null)
    or
    (cancellation_requested_at is not null
      and cancellation_requested_by_user_id is not null
      and cancellation_reason_code is not null)
  ),
  check (started_at is null or started_at >= created_at),
  check (completed_at is null or completed_at >= coalesce(started_at, created_at)),
  check (updated_at >= created_at)
);

create index migration_runs_organisation_idx
  on migration_runs (organisation_id, created_at desc);

create index migration_runs_active_idx
  on migration_runs (organisation_id, status, updated_at)
  where status in ('queued', 'running');

create table migration_run_outbox (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null unique,
  event_type text not null check (event_type = 'migration_run.requested'),
  aggregate_version integer not null check (aggregate_version > 0),
  idempotency_key text not null unique check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'
  ),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and pg_column_size(payload) <= 65536
    and payload ?& array[
      'schemaVersion',
      'organisationId',
      'migrationRunId',
      'candidateId',
      'approvalId',
      'repositoryId',
      'correlationId',
      'expectedAttempt',
      'expectedVersion'
    ]
    and payload - array[
      'schemaVersion',
      'organisationId',
      'migrationRunId',
      'candidateId',
      'approvalId',
      'repositoryId',
      'correlationId',
      'expectedAttempt',
      'expectedVersion'
    ]::text[] = '{}'::jsonb
  ),
  available_at timestamptz not null,
  lease_owner text check (
    lease_owner is null or length(lease_owner) between 1 and 255
  ),
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 20),
  delivered_at timestamptz,
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  created_at timestamptz not null,
  foreign key (migration_run_id, organisation_id)
    references migration_runs(id, organisation_id) on delete cascade,
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check (delivered_at is null or delivered_at >= created_at)
);

create index migration_run_outbox_pending_idx
  on migration_run_outbox (available_at, created_at)
  where delivered_at is null;

create function reject_immutable_stage4_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'immutable Stage 4 record cannot be changed';
end;
$$;

create trigger migration_approvals_immutable
before update or delete on migration_approvals
for each row execute function reject_immutable_stage4_record_change();

create trigger migration_approval_revocations_immutable
before update or delete on migration_approval_revocations
for each row execute function reject_immutable_stage4_record_change();

revoke all on
  migration_approvals,
  migration_approval_revocations,
  migration_runs,
  migration_run_outbox
from anon, authenticated;

revoke all on function reject_immutable_stage4_record_change() from public;

grant select, insert on
  migration_approvals,
  migration_approval_revocations
to app_runtime;

grant select, insert, update on
  migration_runs,
  migration_run_outbox
to app_runtime;

grant select on
  migration_approvals,
  migration_approval_revocations,
  migration_runs,
  migration_run_outbox
to app_readonly;

commit;
