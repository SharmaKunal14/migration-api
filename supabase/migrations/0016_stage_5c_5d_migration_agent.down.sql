begin;

do $$
begin
  if exists (
    select 1
    from migration_run_events
    where event_type in ('plan_created', 'patch_proposed', 'patch_validated')
  ) then
    raise exception
      'Cannot roll back Stage 5C/5D while migration-agent events exist';
  end if;
end
$$;

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
