begin;

alter table migration_artifacts
  drop constraint migration_artifacts_artifact_type_check,
  drop constraint migration_artifacts_bytes_check,
  drop constraint migration_artifacts_check1;

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
  ),
  add constraint migration_artifacts_bytes_check check (
    (artifact_type = 'source_snapshot' and bytes between 1 and 268435456)
    or (artifact_type = 'patch_proposal' and bytes between 1 and 1048576)
    or (
      artifact_type not in ('source_snapshot', 'patch_proposal')
      and bytes between 1 and 10485760
    )
  ),
  add constraint migration_artifacts_media_type_check check (
    (artifact_type = 'source_snapshot' and media_type = 'application/gzip')
    or (artifact_type = 'patch_proposal' and media_type = 'text/x-diff')
    or (
      artifact_type not in ('source_snapshot', 'patch_proposal')
      and media_type = 'application/json'
    )
  );

create unique index migration_artifacts_source_snapshot_run_unique
  on migration_artifacts (migration_run_id)
  where artifact_type = 'source_snapshot';

alter table migration_run_events
  drop constraint migration_run_events_event_type_check;

alter table migration_run_events
  add constraint migration_run_events_event_type_check check (
    event_type in (
      'run_requested',
      'approval_validated',
      'stage_entered',
      'source_acquired',
      'cancellation_requested',
      'run_cancelled',
      'run_failed',
      'run_stale',
      'run_completed'
    )
  );

commit;
