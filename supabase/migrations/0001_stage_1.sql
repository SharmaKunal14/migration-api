begin;

create extension if not exists pgcrypto;

create table app_users (
  id uuid primary key default gen_random_uuid(),
  auth_subject text not null unique check (length(auth_subject) between 1 and 255),
  display_name text check (display_name is null or length(display_name) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organisations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{2,62}$'),
  name text not null check (length(name) between 1 and 120),
  status text not null default 'active'
    check (status in ('active', 'deleting', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table organisation_memberships (
  organisation_id uuid not null references organisations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'reviewer', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organisation_id, user_id)
);

create table agent_runs (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete restrict,
  requested_by_user_id uuid not null references app_users(id) on delete restrict,
  scenario_id text not null check (scenario_id = 'orbitchat-typescript-v1-v2'),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  terminal_code text check (
    terminal_code is null or terminal_code in (
      'completed',
      'cancelled',
      'budget_exhausted_model_calls',
      'budget_exhausted_tool_calls',
      'budget_exhausted_iterations',
      'budget_exhausted_time',
      'invalid_model_output',
      'policy_rejected',
      'upstream_transient',
      'upstream_permanent',
      'infrastructure_failed'
    )
  ),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  result_artifact_id uuid,
  requested_model text not null check (length(requested_model) between 1 and 128),
  returned_model text check (returned_model is null or length(returned_model) <= 128),
  openai_request_id text check (
    openai_request_id is null or length(openai_request_id) <= 256
  ),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  model_calls integer not null default 0 check (model_calls >= 0),
  tool_calls integer not null default 0 check (tool_calls >= 0),
  iterations integer not null default 0 check (iterations >= 0),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status in ('queued', 'running') and terminal_code is null and completed_at is null)
    or
    (status = 'succeeded' and terminal_code = 'completed' and completed_at is not null)
    or
    (status = 'failed' and terminal_code is not null and terminal_code <> 'completed'
      and completed_at is not null)
  )
);

create table agent_actions (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references agent_runs(id) on delete cascade,
  sequence integer not null check (sequence between 1 and 10000),
  tool_name text not null check (tool_name ~ '^[a-z][a-z0-9_]{2,63}$'),
  tool_version text not null,
  status text not null
    check (status in ('started', 'succeeded', 'failed', 'rejected', 'timed_out')),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  output_digest text check (output_digest is null or output_digest ~ '^[a-f0-9]{64}$'),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  started_at timestamptz not null,
  completed_at timestamptz,
  unique (agent_run_id, sequence)
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  owner_type text not null check (owner_type = 'agent_run'),
  owner_id uuid not null references agent_runs(id) on delete cascade,
  artifact_type text not null
    check (artifact_type in ('vendor_evidence', 'agent_action', 'final_result')),
  object_key text not null check (
    length(object_key) between 1 and 1024
    and object_key !~ '(^|/)\.\.?(/|$)'
  ),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 0 and 10737418240),
  media_type text not null check (length(media_type) between 1 and 255),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  unique (object_key, digest),
  check (expires_at is null or expires_at > created_at)
);

alter table agent_runs
  add constraint agent_runs_result_artifact_fk
  foreign key (result_artifact_id) references artifacts(id) deferrable initially deferred;

create table workflow_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type = 'agent_run.requested'),
  aggregate_id uuid not null references agent_runs(id) on delete cascade,
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

create index workflow_outbox_pending_idx
  on workflow_outbox (available_at, created_at)
  where delivered_at is null;

create table api_idempotency_keys (
  actor_id uuid not null references app_users(id) on delete cascade,
  action text not null check (length(action) between 1 and 100),
  idempotency_key text not null
    check (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'),
  request_digest text not null check (request_digest ~ '^[a-f0-9]{64}$'),
  result_resource_id uuid not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (actor_id, action, idempotency_key),
  check (expires_at > created_at)
);

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete restrict,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_id text not null check (length(actor_id) between 1 and 255),
  action text not null check (length(action) between 1 and 100),
  resource_type text not null check (length(resource_type) between 1 and 100),
  resource_id uuid not null,
  request_id uuid not null,
  metadata jsonb not null default '{}'::jsonb check (pg_column_size(metadata) <= 16384),
  created_at timestamptz not null default now()
);

revoke all on all tables in schema public from anon, authenticated;
grant select, insert, update on
  app_users,
  organisations,
  organisation_memberships,
  agent_runs,
  agent_actions,
  artifacts,
  workflow_outbox,
  api_idempotency_keys,
  audit_events
to app_runtime;

grant select on all tables in schema public to app_readonly;

commit;

