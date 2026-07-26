begin;

create table change_intelligence_runs (
  id uuid primary key default gen_random_uuid(),
  vendor_release_id uuid not null
    references vendor_releases(id) on delete cascade,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempt integer not null default 1 check (attempt between 1 and 10),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  correlation_id uuid not null,
  result_object_key text not null unique check (
    length(result_object_key) between 1 and 1024
    and result_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  migration_specification_id uuid
    references migration_specifications(id) on delete restrict,
  requested_model text not null check (length(requested_model) between 1 and 200),
  returned_model text check (
    returned_model is null or length(returned_model) between 1 and 200
  ),
  openai_request_id text check (
    openai_request_id is null
    or openai_request_id ~ '^[A-Za-z][A-Za-z0-9_.-]{0,127}$'
  ),
  model_calls integer not null default 0 check (model_calls between 0 and 3),
  tool_calls integer not null default 0 check (tool_calls between 0 and 12),
  iterations integer not null default 0 check (iterations between 0 and 4),
  input_tokens integer not null default 0 check (input_tokens between 0 and 60000),
  output_tokens integer not null default 0 check (output_tokens between 0 and 12000),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (vendor_release_id, evidence_digest),
  check (
    (
      status = 'running'
      and safe_error_code is null
      and migration_specification_id is null
      and completed_at is null
    )
    or
    (
      status = 'succeeded'
      and safe_error_code is null
      and migration_specification_id is not null
      and completed_at is not null
    )
    or
    (
      status = 'failed'
      and safe_error_code is not null
      and migration_specification_id is null
      and completed_at is not null
    )
  )
);

create index change_intelligence_runs_release_idx
  on change_intelligence_runs (vendor_release_id, status, updated_at desc);

revoke all on change_intelligence_runs from anon, authenticated;

grant select, insert on change_intelligence_runs to app_runtime;

grant update (
  status,
  attempt,
  safe_error_code,
  correlation_id,
  migration_specification_id,
  returned_model,
  openai_request_id,
  model_calls,
  tool_calls,
  iterations,
  input_tokens,
  output_tokens,
  started_at,
  completed_at,
  updated_at
) on change_intelligence_runs to app_runtime;

create function create_change_intelligence_draft(
  p_id uuid,
  p_vendor_release_id uuid,
  p_source_compatibility text,
  p_target_version text,
  p_specification jsonb,
  p_evidence_object_key text,
  p_evidence_digest text,
  p_revision integer,
  p_created_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if
    p_specification #>> '{trust,status}' is distinct from 'draft'
    or p_specification #>> '{trust,generatedBy}'
      is distinct from 'change_intelligence_agent'
    or p_specification #> '{trust,reviewedAt}' is distinct from 'null'::jsonb
    or (p_specification ->> 'revision')::integer is distinct from p_revision
  then
    raise exception 'invalid change-intelligence draft';
  end if;

  insert into migration_specifications (
    id,
    vendor_release_id,
    source_compatibility,
    target_version,
    schema_version,
    specification,
    evidence_object_key,
    evidence_digest,
    trust_state,
    revision,
    generated_by,
    reviewed_by_user_id,
    reviewed_at,
    created_at
  ) values (
    p_id,
    p_vendor_release_id,
    p_source_compatibility,
    p_target_version,
    '1.0',
    p_specification,
    p_evidence_object_key,
    p_evidence_digest,
    'draft',
    p_revision,
    'change_intelligence_agent',
    null,
    null,
    p_created_at
  );

  return p_id;
end;
$$;

revoke all on function create_change_intelligence_draft(
  uuid, uuid, text, text, jsonb, text, text, integer, timestamptz
) from public;

grant execute on function create_change_intelligence_draft(
  uuid, uuid, text, text, jsonb, text, text, integer, timestamptz
) to app_runtime;

grant select on change_intelligence_runs to app_readonly;

commit;
