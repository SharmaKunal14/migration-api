begin;

alter table migration_run_events
  drop constraint migration_run_events_event_type_check;

alter table migration_run_events
  add constraint migration_run_events_event_type_check check (
    event_type in (
      'run_requested',
      'approval_validated',
      'stage_entered',
      'source_acquired',
      'plan_created',
      'patch_proposed',
      'patch_validated',
      'verification_prepared',
      'verification_started',
      'verification_completed',
      'repair_requested',
      'cancellation_requested',
      'run_cancelled',
      'run_failed',
      'run_stale',
      'run_completed'
    )
  );

do $$
declare
  constraint_name text;
  constraint_count integer;
begin
  select min(constraint_definition.conname), count(*)
  into constraint_name, constraint_count
  from pg_constraint as constraint_definition
  where constraint_definition.conrelid = 'migration_artifacts'::regclass
    and constraint_definition.contype = 'c'
    and position(
      'artifact_type'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'source_snapshot'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'media_type'
      in pg_get_constraintdef(constraint_definition.oid)
    ) = 0
    and position(
      'bytes'
      in pg_get_constraintdef(constraint_definition.oid)
    ) = 0;

  if constraint_count <> 1 then
    raise exception
      'Stage 6A expected exactly one migration artifact type constraint, found %',
      constraint_count;
  end if;

  execute format(
    'alter table migration_artifacts drop constraint %I',
    constraint_name
  );
end
$$;

alter table migration_artifacts
  add constraint migration_artifacts_artifact_type_check check (
    artifact_type in (
      'source_snapshot',
      'context_manifest',
      'agent_checkpoint',
      'migration_plan',
      'patch_proposal',
      'patch_manifest',
      'patch_validation',
      'verification_input',
      'verification_result',
      'verification_stdout',
      'verification_stderr'
    )
  );

alter table migration_artifacts
  drop constraint migration_artifacts_object_key_check;

alter table migration_artifacts
  add constraint migration_artifacts_object_key_check check (
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
      || '/(input|agent|patch|verification)/[A-Za-z0-9._/-]+$'
    )
  );

do $$
declare
  constraint_name text;
  constraint_count integer;
begin
  select min(constraint_definition.conname), count(*)
  into constraint_name, constraint_count
  from pg_constraint as constraint_definition
  where constraint_definition.conrelid = 'migration_artifacts'::regclass
    and constraint_definition.contype = 'c'
    and position(
      'media_type'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'source_snapshot'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'patch_proposal'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'application/json'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0;

  if constraint_count <> 1 then
    raise exception
      'Stage 6A expected exactly one migration artifact media constraint, found %',
      constraint_count;
  end if;

  execute format(
    'alter table migration_artifacts drop constraint %I',
    constraint_name
  );
end
$$;

alter table migration_artifacts
  add constraint migration_artifacts_stage_6a_media_check check (
    (artifact_type = 'source_snapshot' and media_type = 'application/gzip')
    or (artifact_type = 'patch_proposal' and media_type = 'text/x-diff')
    or (
      artifact_type in ('verification_stdout', 'verification_stderr')
      and media_type = 'text/plain'
    )
    or (
      artifact_type not in (
        'source_snapshot',
        'patch_proposal',
        'verification_stdout',
        'verification_stderr'
      )
      and media_type = 'application/json'
    )
  );

do $$
declare
  constraint_name text;
  constraint_count integer;
begin
  select min(constraint_definition.conname), count(*)
  into constraint_name, constraint_count
  from pg_constraint as constraint_definition
  where constraint_definition.conrelid = 'migration_artifacts'::regclass
    and constraint_definition.contype = 'c'
    and position(
      'bytes'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'source_snapshot'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      'patch_proposal'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0;

  if constraint_count <> 1 then
    raise exception
      'Stage 6A expected exactly one migration artifact size constraint, found %',
      constraint_count;
  end if;

  execute format(
    'alter table migration_artifacts drop constraint %I',
    constraint_name
  );
end
$$;

alter table migration_artifacts
  add constraint migration_artifacts_bytes_check check (
    (artifact_type = 'source_snapshot' and bytes between 1 and 268435456)
    or (
      artifact_type in (
        'patch_proposal',
        'verification_stdout',
        'verification_stderr'
      )
      and bytes between 1 and 1048576
    )
    or (
      artifact_type not in (
        'source_snapshot',
        'patch_proposal',
        'verification_stdout',
        'verification_stderr'
      )
      and bytes between 1 and 10485760
    )
  );

alter table patch_attempts
  add constraint patch_attempts_verification_binding_unique unique (
    id,
    organisation_id,
    migration_run_id,
    patch_artifact_id,
    patch_digest,
    validation_artifact_id,
    validation_digest
  );

create table verification_attempts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  approval_id uuid not null,
  attempt_number integer not null check (attempt_number between 1 and 10),
  patch_attempt_id uuid not null,
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  snapshot_artifact_id uuid not null,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  patch_artifact_id uuid not null,
  patch_digest text not null check (patch_digest ~ '^[a-f0-9]{64}$'),
  patch_validation_artifact_id uuid not null,
  patch_validation_digest text not null check (
    patch_validation_digest ~ '^[a-f0-9]{64}$'
  ),
  verification_policy_version text not null check (
    verification_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  verification_profile jsonb not null check (
    jsonb_typeof(verification_profile) = 'object'
    and octet_length(verification_profile::text) between 2 and 32768
  ),
  verification_profile_digest text not null check (
    verification_profile_digest ~ '^[a-f0-9]{64}$'
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
    snapshot_artifact_id,
    organisation_id,
    migration_run_id,
    snapshot_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  foreign key (
    patch_attempt_id,
    organisation_id,
    migration_run_id,
    patch_artifact_id,
    patch_digest,
    patch_validation_artifact_id,
    patch_validation_digest
  ) references patch_attempts (
    id,
    organisation_id,
    migration_run_id,
    patch_artifact_id,
    patch_digest,
    validation_artifact_id,
    validation_digest
  ) on delete restrict,
  unique (id, organisation_id, migration_run_id),
  unique (migration_run_id, attempt_number),
  unique (migration_run_id, patch_attempt_id)
);

create index verification_attempts_run_idx
  on verification_attempts (organisation_id, migration_run_id, attempt_number);

create table verification_attempt_results (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  verification_attempt_id uuid not null,
  outcome text not null check (
    outcome in (
      'passed',
      'failed',
      'partial',
      'unavailable',
      'timed_out',
      'policy_rejected',
      'infrastructure_failed'
    )
  ),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  result_artifact_id uuid,
  result_digest text check (
    result_digest is null or result_digest ~ '^[a-f0-9]{64}$'
  ),
  stdout_artifact_id uuid,
  stdout_digest text check (
    stdout_digest is null or stdout_digest ~ '^[a-f0-9]{64}$'
  ),
  stderr_artifact_id uuid,
  stderr_digest text check (
    stderr_digest is null or stderr_digest ~ '^[a-f0-9]{64}$'
  ),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at),
  created_at timestamptz not null,
  foreign key (
    verification_attempt_id,
    organisation_id,
    migration_run_id
  ) references verification_attempts (
    id,
    organisation_id,
    migration_run_id
  ) on delete restrict,
  foreign key (
    result_artifact_id,
    organisation_id,
    migration_run_id,
    result_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  foreign key (
    stdout_artifact_id,
    organisation_id,
    migration_run_id,
    stdout_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  foreign key (
    stderr_artifact_id,
    organisation_id,
    migration_run_id,
    stderr_digest
  ) references migration_artifacts (
    id,
    organisation_id,
    migration_run_id,
    digest
  ) on delete restrict,
  unique (verification_attempt_id),
  check (
    (result_artifact_id is null and result_digest is null)
    or (result_artifact_id is not null and result_digest is not null)
  ),
  check (
    (stdout_artifact_id is null and stdout_digest is null)
    or (stdout_artifact_id is not null and stdout_digest is not null)
  ),
  check (
    (stderr_artifact_id is null and stderr_digest is null)
    or (stderr_artifact_id is not null and stderr_digest is not null)
  ),
  check (
    (
      outcome = 'passed'
      and safe_error_code is null
      and result_artifact_id is not null
    )
    or (
      outcome <> 'passed'
      and safe_error_code is not null
      and (
        result_artifact_id is not null
        or outcome = 'infrastructure_failed'
      )
    )
  )
);

create index verification_attempt_results_run_idx
  on verification_attempt_results (
    organisation_id,
    migration_run_id,
    completed_at
  );

create trigger verification_attempts_immutable
before update or delete on verification_attempts
for each row execute function reject_immutable_stage5_record_change();

create trigger verification_attempt_results_immutable
before update or delete on verification_attempt_results
for each row execute function reject_immutable_stage5_record_change();

revoke all on
  verification_attempts,
  verification_attempt_results
from anon, authenticated;

grant select, insert on
  verification_attempts,
  verification_attempt_results
to app_runtime;

grant select on
  verification_attempts,
  verification_attempt_results
to app_readonly;

commit;
