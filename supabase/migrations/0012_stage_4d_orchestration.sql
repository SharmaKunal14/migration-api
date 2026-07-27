begin;

create table migration_run_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  sequence integer not null check (sequence > 0),
  event_key text not null check (
    event_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,191}$'
  ),
  event_type text not null check (
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
  ),
  status text not null check (
    status in ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'stale')
  ),
  stage text not null check (
    stage in (
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
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_user_id uuid references app_users(id) on delete restrict,
  request_id uuid not null,
  created_at timestamptz not null,
  foreign key (migration_run_id, organisation_id)
    references migration_runs(id, organisation_id) on delete cascade,
  unique (migration_run_id, sequence),
  unique (migration_run_id, event_key),
  check (
    (actor_type = 'user' and actor_user_id is not null)
    or (actor_type = 'system' and actor_user_id is null)
  )
);

create index migration_run_events_timeline_idx
  on migration_run_events (organisation_id, migration_run_id, sequence);

insert into migration_run_events (
  id,
  organisation_id,
  migration_run_id,
  sequence,
  event_key,
  event_type,
  status,
  stage,
  safe_error_code,
  actor_type,
  actor_user_id,
  request_id,
  created_at
)
select
  gen_random_uuid(),
  run.organisation_id,
  run.id,
  1,
  'run:' || run.id::text || ':requested',
  'run_requested',
  'queued',
  'queued',
  null,
  'user',
  approval.approved_by_user_id,
  approval.request_id,
  run.created_at
from migration_runs as run
inner join migration_approvals as approval on approval.id = run.approval_id;

create function reject_migration_run_event_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception using
    errcode = '55000',
    message = 'migration run events are immutable';
end;
$$;

create trigger migration_run_events_immutable
before update or delete on migration_run_events
for each row execute function reject_migration_run_event_change();

revoke all on migration_run_events from anon, authenticated;
revoke all on function reject_migration_run_event_change() from public;

grant select, insert on migration_run_events to app_runtime;
grant select on migration_run_events to app_readonly;

commit;
