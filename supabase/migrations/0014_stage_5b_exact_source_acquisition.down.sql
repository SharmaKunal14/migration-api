begin;

do $$
begin
  if exists (
    select 1
    from migration_artifacts
    where artifact_type = 'source_snapshot'
  ) then
    raise exception
      'Cannot roll back Stage 5B while source snapshot artifacts exist';
  end if;
end
$$;

drop index migration_artifacts_source_snapshot_run_unique;

alter table migration_run_events
  drop constraint migration_run_events_event_type_check;

alter table migration_run_events
  add constraint migration_run_events_event_type_check check (
    event_type in (
      'run_requested',
      'approval_validated',
      'stage_entered',
      'cancellation_requested',
      'run_cancelled',
      'run_failed',
      'run_stale',
      'run_completed'
    )
  );

alter table migration_artifacts
  drop constraint migration_artifacts_artifact_type_check,
  drop constraint migration_artifacts_bytes_check,
  drop constraint migration_artifacts_media_type_check;

alter table migration_artifacts
  add constraint migration_artifacts_artifact_type_check check (
    artifact_type in (
      'context_manifest',
      'agent_checkpoint',
      'migration_plan',
      'patch_proposal',
      'patch_manifest',
      'patch_validation'
    )
  ),
  add constraint migration_artifacts_bytes_check check (
    (artifact_type = 'patch_proposal' and bytes between 1 and 1048576)
    or (
      artifact_type <> 'patch_proposal'
      and bytes between 1 and 10485760
    )
  ),
  add constraint migration_artifacts_check1 check (
    (artifact_type = 'patch_proposal' and media_type = 'text/x-diff')
    or (
      artifact_type <> 'patch_proposal'
      and media_type = 'application/json'
    )
  );

commit;
