begin;

do $$
begin
  if exists (select 1 from publication_attempts)
    or exists (select 1 from github_publications)
    or exists (select 1 from publication_notification_outbox)
  then
    raise exception 'Cannot roll back Stage 7A while publication records exist';
  end if;
end
$$;

drop table if exists publication_notification_outbox;
drop table if exists github_publications;
drop table if exists publication_attempts;

drop function if exists enforce_publication_notification_identity();
drop function if exists enforce_github_publication_identity();
drop function if exists enforce_publication_attempt_transition();

alter table verification_attempt_results
  drop constraint if exists verification_results_publication_binding_unique;

alter table verification_attempts
  drop constraint if exists verification_attempts_publication_binding_unique;

alter table migration_approvals
  drop constraint if exists migration_approvals_publication_binding_unique;

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

commit;
