begin;

create table repository_scan_outbox (
  id uuid primary key default gen_random_uuid(),
  repository_scan_id uuid not null unique
    references repository_scans(id) on delete cascade,
  aggregate_version integer not null check (aggregate_version > 0),
  idempotency_key text not null unique
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  payload jsonb not null check (pg_column_size(payload) <= 65536),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 20),
  delivered_at timestamptz,
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  created_at timestamptz not null default now()
);

create index repository_scan_outbox_pending_idx
  on repository_scan_outbox (available_at, created_at)
  where delivered_at is null;

grant select, insert, update on repository_scan_outbox to app_runtime;
grant select on repository_scan_outbox to app_readonly;

commit;
