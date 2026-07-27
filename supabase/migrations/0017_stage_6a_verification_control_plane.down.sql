begin;

do $$
begin
  if exists (
    select 1
    from migration_run_events
    where event_type in (
      'verification_prepared',
      'verification_started',
      'verification_completed',
      'repair_requested'
    )
  ) then
    raise exception
      'Cannot roll back Stage 6A while verification events exist';
  end if;
end
$$;

drop table if exists verification_attempt_results;
drop table if exists verification_attempts;

alter table patch_attempts
  drop constraint if exists patch_attempts_verification_binding_unique;

alter table migration_artifacts
  drop constraint migration_artifacts_bytes_check;

alter table migration_artifacts
  add constraint migration_artifacts_bytes_check check (
    (artifact_type = 'source_snapshot' and bytes between 1 and 268435456)
    or (artifact_type = 'patch_proposal' and bytes between 1 and 1048576)
    or (
      artifact_type not in ('source_snapshot', 'patch_proposal')
      and bytes between 1 and 10485760
    )
  );

alter table migration_artifacts
  drop constraint migration_artifacts_media_type_check;

alter table migration_artifacts
  add constraint migration_artifacts_stage_5b_media_check check (
    (artifact_type = 'source_snapshot' and media_type = 'application/gzip')
    or (artifact_type = 'patch_proposal' and media_type = 'text/x-diff')
    or (
      artifact_type not in ('source_snapshot', 'patch_proposal')
      and media_type = 'application/json'
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
      || '/(input|agent|patch)/[A-Za-z0-9._/-]+$'
    )
  );

alter table migration_artifacts
  drop constraint migration_artifacts_artifact_type_check;

alter table migration_artifacts
  add constraint migration_artifacts_artifact_type_check check (
    artifact_type in (
      'source_snapshot',
      'context_manifest',
      'agent_checkpoint',
      'migration_plan',
      'patch_proposal',
      'patch_manifest',
      'patch_validation'
    )
  );

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
      'cancellation_requested',
      'run_cancelled',
      'run_failed',
      'run_stale',
      'run_completed'
    )
  );

commit;
