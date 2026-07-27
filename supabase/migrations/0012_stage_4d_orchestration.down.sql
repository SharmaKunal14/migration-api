begin;

drop trigger if exists migration_run_events_immutable on migration_run_events;
drop function if exists reject_migration_run_event_change();
drop table if exists migration_run_events;

commit;
