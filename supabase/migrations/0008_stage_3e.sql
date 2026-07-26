begin;

create table impact_analysis_runs (
  id uuid primary key,
  candidate_id uuid not null references migration_candidates(id) on delete cascade,
  repository_snapshot_id uuid not null
    references repository_snapshots(id) on delete restrict,
  migration_specification_id uuid not null
    references migration_specifications(id) on delete restrict,
  snapshot_digest text not null check (snapshot_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempt integer not null check (attempt between 1 and 10),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  correlation_id uuid not null,
  input_object_key text not null check (
    length(input_object_key) between 1 and 1024
    and input_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  input_digest text not null check (input_digest ~ '^[a-f0-9]{64}$'),
  result_object_key text not null check (
    length(result_object_key) between 1 and 1024
    and result_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  impact_report_id uuid,
  requested_model text not null check (length(requested_model) between 1 and 200),
  returned_model text check (
    returned_model is null or length(returned_model) between 1 and 200
  ),
  openai_request_id text check (
    openai_request_id is null or length(openai_request_id) between 1 and 128
  ),
  model_calls integer not null default 0 check (model_calls between 0 and 4),
  tool_calls integer not null default 0 check (tool_calls between 0 and 30),
  iterations integer not null default 0 check (iterations between 0 and 6),
  input_tokens integer not null default 0 check (input_tokens between 0 and 100000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 16000),
  started_at timestamptz not null,
  completed_at timestamptz,
  updated_at timestamptz not null,
  unique (
    candidate_id,
    repository_snapshot_id,
    migration_specification_id,
    snapshot_digest
  ),
  check (
    (status = 'running' and completed_at is null and safe_error_code is null)
    or
    (status = 'succeeded' and completed_at is not null
      and safe_error_code is null and impact_report_id is not null)
    or
    (status = 'failed' and completed_at is not null
      and safe_error_code is not null and impact_report_id is null)
  )
);

create index impact_analysis_runs_candidate_idx
  on impact_analysis_runs (candidate_id, updated_at desc);

alter table impact_reports
  drop constraint impact_reports_impact_agent_run_id_fkey;

alter table impact_reports
  add constraint impact_reports_impact_analysis_run_fk
  foreign key (impact_agent_run_id)
  references impact_analysis_runs(id) on delete restrict;

alter table impact_analysis_runs
  add constraint impact_analysis_runs_report_fk
  foreign key (impact_report_id)
  references impact_reports(id) deferrable initially deferred;

grant select, insert, update on impact_analysis_runs to app_runtime;

commit;
