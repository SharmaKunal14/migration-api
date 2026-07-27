begin;

alter table migration_runs
  add constraint migration_runs_patch_binding_unique
  unique (id, organisation_id, approval_id, base_commit_sha);

create table migration_artifacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  artifact_type text not null check (
    artifact_type in (
      'context_manifest',
      'agent_checkpoint',
      'migration_plan',
      'patch_proposal',
      'patch_manifest',
      'patch_validation'
    )
  ),
  object_key text not null unique check (
    length(object_key) between 1 and 1024
    and object_key !~ '^/'
    and object_key !~ '//'
    and object_key !~ '(^|/)\.\.?(/|$)'
    and object_key !~ '\\'
    and object_key !~ '[[:cntrl:]]'
    and object_key ~ (
      '^env/[a-z][a-z0-9-]{1,31}/org/'
      || organisation_id::text
      || '/run/'
      || migration_run_id::text
      || '/(input|agent|patch)/[A-Za-z0-9._/-]{1,512}$'
    )
  ),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (
    (artifact_type = 'patch_proposal' and bytes between 1 and 1048576)
    or (
      artifact_type <> 'patch_proposal'
      and bytes between 1 and 10485760
    )
  ),
  media_type text not null check (length(media_type) between 1 and 255),
  retention_class text not null check (
    retention_class in ('workflow_ephemeral', 'audit')
  ),
  created_at timestamptz not null,
  expires_at timestamptz,
  foreign key (migration_run_id, organisation_id)
    references migration_runs(id, organisation_id) on delete restrict,
  unique (id, organisation_id, migration_run_id, digest),
  check (
    (retention_class = 'workflow_ephemeral' and expires_at is not null)
    or (retention_class = 'audit')
  ),
  check (
    (artifact_type = 'patch_proposal' and media_type = 'text/x-diff')
    or (
      artifact_type <> 'patch_proposal'
      and media_type = 'application/json'
    )
  ),
  check (expires_at is null or expires_at > created_at)
);

create index migration_artifacts_run_idx
  on migration_artifacts (organisation_id, migration_run_id, created_at);

create table migration_plans (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  approval_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 10),
  artifact_id uuid not null,
  artifact_digest text not null check (artifact_digest ~ '^[a-f0-9]{64}$'),
  schema_version text not null check (schema_version = '1.0'),
  trust_state text not null check (trust_state = 'proposed'),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  migration_specification_id uuid not null,
  migration_specification_revision integer not null check (
    migration_specification_revision > 0
  ),
  migration_specification_digest text not null check (
    migration_specification_digest ~ '^[a-f0-9]{64}$'
  ),
  impact_report_id uuid not null,
  impact_report_revision integer not null check (impact_report_revision > 0),
  impact_report_digest text not null check (
    impact_report_digest ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null,
  foreign key (
    migration_run_id,
    organisation_id,
    approval_id,
    base_commit_sha
  ) references migration_runs (
    id,
    organisation_id,
    approval_id,
    base_commit_sha
  ) on delete restrict,
  foreign key (
    artifact_id,
    organisation_id,
    migration_run_id,
    artifact_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  unique (id, organisation_id, migration_run_id, attempt_number),
  unique (migration_run_id, attempt_number)
);

create table patch_attempts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 10),
  parent_patch_attempt_id uuid,
  migration_plan_id uuid not null,
  patch_artifact_id uuid,
  patch_digest text check (
    patch_digest is null or patch_digest ~ '^[a-f0-9]{64}$'
  ),
  validation_artifact_id uuid,
  validation_digest text check (
    validation_digest is null or validation_digest ~ '^[a-f0-9]{64}$'
  ),
  policy_version text not null check (
    policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('accepted', 'rejected', 'failed')),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  summary_code text not null check (
    summary_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  changed_files integer not null check (changed_files between 0 and 100),
  added_lines integer not null check (added_lines between 0 and 10000),
  deleted_lines integer not null check (deleted_lines between 0 and 10000),
  patch_bytes integer not null check (patch_bytes between 0 and 1048576),
  created_at timestamptz not null,
  foreign key (migration_run_id, organisation_id)
    references migration_runs(id, organisation_id) on delete restrict,
  foreign key (
    migration_plan_id,
    organisation_id,
    migration_run_id,
    attempt_number
  )
    references migration_plans(
      id,
      organisation_id,
      migration_run_id,
      attempt_number
    )
    on delete restrict,
  foreign key (
    patch_artifact_id,
    organisation_id,
    migration_run_id,
    patch_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  foreign key (
    validation_artifact_id,
    organisation_id,
    migration_run_id,
    validation_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  unique (id, organisation_id, migration_run_id),
  unique (migration_run_id, attempt_number),
  foreign key (
    parent_patch_attempt_id,
    organisation_id,
    migration_run_id
  ) references patch_attempts (
    id,
    organisation_id,
    migration_run_id
  ) on delete restrict,
  check (parent_patch_attempt_id is null or parent_patch_attempt_id <> id),
  check (
    (attempt_number = 1 and parent_patch_attempt_id is null)
    or (attempt_number > 1 and parent_patch_attempt_id is not null)
  ),
  check (
    (patch_artifact_id is null and patch_digest is null)
    or (patch_artifact_id is not null and patch_digest is not null)
  ),
  check (
    (validation_artifact_id is null and validation_digest is null)
    or (validation_artifact_id is not null and validation_digest is not null)
  ),
  check (
    (
      status = 'accepted'
      and safe_error_code is null
      and patch_artifact_id is not null
      and validation_artifact_id is not null
      and changed_files > 0
      and patch_bytes > 0
    )
    or (
      status = 'rejected'
      and safe_error_code is not null
      and patch_artifact_id is not null
      and validation_artifact_id is not null
    )
    or (status = 'failed' and safe_error_code is not null)
  )
);

create index patch_attempts_run_idx
  on patch_attempts (organisation_id, migration_run_id, attempt_number);

create table migration_agent_checkpoints (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 10),
  sequence integer not null check (sequence between 1 and 100),
  phase text not null check (phase in ('context', 'planning', 'patching')),
  artifact_id uuid not null,
  artifact_digest text not null check (artifact_digest ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  foreign key (migration_run_id, organisation_id)
    references migration_runs(id, organisation_id) on delete restrict,
  foreign key (
    artifact_id,
    organisation_id,
    migration_run_id,
    artifact_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  unique (migration_run_id, sequence)
);

create function reject_immutable_stage5_record_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'immutable Stage 5 record cannot be changed';
end;
$$;

create trigger migration_artifacts_immutable
before update or delete on migration_artifacts
for each row execute function reject_immutable_stage5_record_change();

create trigger migration_plans_immutable
before update or delete on migration_plans
for each row execute function reject_immutable_stage5_record_change();

create trigger patch_attempts_immutable
before update or delete on patch_attempts
for each row execute function reject_immutable_stage5_record_change();

create trigger migration_agent_checkpoints_immutable
before update or delete on migration_agent_checkpoints
for each row execute function reject_immutable_stage5_record_change();

revoke all on
  migration_artifacts,
  migration_plans,
  patch_attempts,
  migration_agent_checkpoints
from anon, authenticated;

revoke all on function reject_immutable_stage5_record_change() from public;

grant select, insert on
  migration_artifacts,
  migration_plans,
  patch_attempts,
  migration_agent_checkpoints
to app_runtime;

grant select on
  migration_artifacts,
  migration_plans,
  patch_attempts,
  migration_agent_checkpoints
to app_readonly;

commit;
