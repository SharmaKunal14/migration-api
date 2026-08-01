begin;

alter table package_source_mappings
  add column lease_owner uuid,
  add column lease_expires_at timestamptz,
  add column registry_etag text,
  add column registry_metadata_object_key text,
  add column registry_metadata_digest text,
  add column latest_version text,
  add column latest_deprecated boolean,
  add column resolved_at timestamptz;

alter table package_source_mappings
  add constraint package_source_mappings_lease_check check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  add constraint package_source_mappings_registry_etag_check
    check (registry_etag is null or length(registry_etag) <= 512),
  add constraint package_source_mappings_registry_metadata_check check (
    (
      registry_metadata_object_key is null
      and registry_metadata_digest is null
      and latest_version is null
      and latest_deprecated is null
      and resolved_at is null
    )
    or (
      registry_metadata_object_key ~ '^env/[a-z]+/package-source/npm/mapping/[0-9a-f-]{36}/resolution/[0-9a-f-]{36}/metadata\.json$'
      and registry_metadata_digest ~ '^[a-f0-9]{64}$'
      and length(latest_version) between 1 and 100
      and latest_deprecated is not null
      and resolved_at is not null
    )
  ),
  add constraint package_source_mappings_review_evidence_check check (
    status <> 'needs_review' or registry_metadata_digest is not null
  );

drop index package_source_mappings_pending_idx;

create index package_source_mappings_pending_idx
  on package_source_mappings (last_checked_at nulls first, first_observed_at, id)
  where status in ('pending_registry_lookup', 'failed') and attempt_count < 5;

create table package_source_resolution_runs (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references package_source_mappings(id) on delete cascade,
  attempt integer not null check (attempt between 1 and 5),
  status text not null check (status in ('running', 'succeeded', 'failed')),
  correlation_id uuid not null,
  evidence_object_key text,
  evidence_digest text,
  resolved_version text,
  registry_etag text,
  safe_error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (mapping_id, attempt),
  check (safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  check (evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'),
  check (resolved_version is null or length(resolved_version) between 1 and 100),
  check (registry_etag is null or length(registry_etag) <= 512),
  check (
    (status = 'running' and completed_at is null and safe_error_code is null)
    or (
      status = 'succeeded'
      and completed_at is not null
      and evidence_object_key is not null
      and evidence_digest is not null
      and resolved_version is not null
      and safe_error_code is null
    )
    or (
      status = 'failed'
      and completed_at is not null
      and evidence_object_key is null
      and evidence_digest is null
      and resolved_version is null
      and safe_error_code is not null
    )
  )
);

create index package_source_resolution_runs_mapping_idx
  on package_source_resolution_runs (mapping_id, started_at desc);

create table package_source_candidates (
  id uuid primary key default gen_random_uuid(),
  mapping_id uuid not null references package_source_mappings(id) on delete cascade,
  resolution_run_id uuid not null references package_source_resolution_runs(id) on delete cascade,
  source_kind text not null check (
    source_kind in ('package_registry_release', 'sdk_repository_release', 'homepage', 'issue_tracker')
  ),
  canonical_url text not null check (length(canonical_url) between 9 and 2048 and canonical_url like 'https://%'),
  canonical_domain text not null check (
    canonical_domain = lower(canonical_domain)
    and canonical_domain ~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$'
  ),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  review_state text not null default 'pending_review'
    check (review_state in ('pending_review', 'approved', 'rejected')),
  reviewed_by_user_id uuid references app_users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (mapping_id, source_kind, canonical_url),
  check (
    (review_state = 'pending_review' and reviewed_by_user_id is null and reviewed_at is null)
    or (review_state in ('approved', 'rejected') and reviewed_by_user_id is not null and reviewed_at is not null)
  )
);

create index package_source_candidates_review_queue_idx
  on package_source_candidates (created_at, id)
  where review_state = 'pending_review';

revoke all on package_source_resolution_runs from public, anon, authenticated, app_runtime;
revoke all on package_source_candidates from public, anon, authenticated, app_runtime;
grant select on package_source_resolution_runs, package_source_candidates to app_readonly;

create function claim_npm_package_source_mappings(
  p_worker_id uuid,
  p_correlation_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  mapping_id uuid,
  package_name text,
  resolution_run_id uuid,
  attempt integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed package_source_mappings%rowtype;
  new_run_id uuid;
  new_attempt integer;
  resolver_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or p_correlation_id is null then
    raise exception using errcode = '22023', message = 'invalid resolver claim';
  end if;
  if p_limit is null
    or p_lease_seconds is null
    or p_limit < 1
    or p_limit > 10
    or p_lease_seconds < 30
    or p_lease_seconds > 300
  then
    raise exception using errcode = '22023', message = 'invalid resolver claim bounds';
  end if;

  for claimed in
    select mapping.*
    from package_source_mappings mapping
    where mapping.ecosystem = 'npm'
      and mapping.attempt_count < 5
      and (mapping.lease_expires_at is null or mapping.lease_expires_at <= resolver_now)
      and (
        mapping.status = 'pending_registry_lookup'
        or (
          mapping.status = 'failed'
          and mapping.last_checked_at <= resolver_now - interval '1 hour'
        )
      )
    order by mapping.last_checked_at nulls first, mapping.first_observed_at, mapping.id
    for update skip locked
    limit p_limit
  loop
    new_run_id := gen_random_uuid();
    new_attempt := claimed.attempt_count + 1;

    update package_source_resolution_runs
    set status = 'failed',
        safe_error_code = 'NPM_REGISTRY_LEASE_EXPIRED',
        completed_at = resolver_now
    where mapping_id = claimed.id
      and status = 'running';

    update package_source_mappings
    set lease_owner = p_worker_id,
        lease_expires_at = resolver_now + make_interval(secs => p_lease_seconds),
        attempt_count = new_attempt,
        last_checked_at = resolver_now,
        updated_at = resolver_now,
        version = version + 1
    where id = claimed.id;

    insert into package_source_resolution_runs (
      id, mapping_id, attempt, status, correlation_id, started_at
    ) values (
      new_run_id, claimed.id, new_attempt, 'running', p_correlation_id, resolver_now
    );

    mapping_id := claimed.id;
    package_name := claimed.package_name;
    resolution_run_id := new_run_id;
    attempt := new_attempt;
    return next;
  end loop;
end;
$$;

create function complete_npm_package_source_resolution(
  p_mapping_id uuid,
  p_resolution_run_id uuid,
  p_worker_id uuid,
  p_evidence_object_key text,
  p_evidence_digest text,
  p_latest_version text,
  p_latest_deprecated boolean,
  p_registry_etag text,
  p_candidates jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  candidate jsonb;
  completion_now timestamptz := clock_timestamp();
begin
  if p_evidence_object_key is null
    or p_evidence_digest !~ '^[a-f0-9]{64}$'
    or p_latest_version is null
    or length(p_latest_version) not between 1 and 100
    or p_latest_deprecated is null
    or (p_registry_etag is not null and length(p_registry_etag) > 512)
    or p_candidates is null
    or jsonb_typeof(p_candidates) <> 'array'
    or jsonb_array_length(p_candidates) > 10
    or octet_length(p_candidates::text) > 65536
  then
    raise exception using errcode = '22023', message = 'invalid resolver completion';
  end if;

  perform 1
  from package_source_mappings
  where id = p_mapping_id
    and lease_owner = p_worker_id
    and lease_expires_at > completion_now
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'resolver lease is not active';
  end if;

  perform 1
  from package_source_resolution_runs
  where id = p_resolution_run_id
    and mapping_id = p_mapping_id
    and status = 'running'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'resolver run is not active';
  end if;

  for candidate in select value from jsonb_array_elements(p_candidates)
  loop
    if jsonb_typeof(candidate) <> 'object'
      or not (candidate ?& array['sourceKind', 'canonicalUrl', 'canonicalDomain'])
      or (candidate - array['sourceKind', 'canonicalUrl', 'canonicalDomain']) <> '{}'::jsonb
      or jsonb_typeof(candidate->'sourceKind') <> 'string'
      or jsonb_typeof(candidate->'canonicalUrl') <> 'string'
      or jsonb_typeof(candidate->'canonicalDomain') <> 'string'
      or candidate->>'sourceKind' not in (
        'package_registry_release', 'sdk_repository_release', 'homepage', 'issue_tracker'
      )
      or length(candidate->>'canonicalUrl') not between 9 and 2048
      or candidate->>'canonicalUrl' not like 'https://%'
      or candidate->>'canonicalDomain' <> lower(candidate->>'canonicalDomain')
      or candidate->>'canonicalDomain' !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$'
    then
      raise exception using errcode = '22023', message = 'invalid resolver candidate';
    end if;
  end loop;

  update package_source_mappings
  set status = 'needs_review',
      lease_owner = null,
      lease_expires_at = null,
      registry_etag = p_registry_etag,
      registry_metadata_object_key = p_evidence_object_key,
      registry_metadata_digest = p_evidence_digest,
      latest_version = p_latest_version,
      latest_deprecated = p_latest_deprecated,
      resolved_at = completion_now,
      safe_error_code = null,
      updated_at = completion_now,
      version = version + 1
  where id = p_mapping_id;

  update package_source_resolution_runs
  set status = 'succeeded',
      evidence_object_key = p_evidence_object_key,
      evidence_digest = p_evidence_digest,
      resolved_version = p_latest_version,
      registry_etag = p_registry_etag,
      completed_at = completion_now
  where id = p_resolution_run_id;

  insert into package_source_candidates (
    mapping_id,
    resolution_run_id,
    source_kind,
    canonical_url,
    canonical_domain,
    evidence_digest
  )
  select
    p_mapping_id,
    p_resolution_run_id,
    item->>'sourceKind',
    item->>'canonicalUrl',
    item->>'canonicalDomain',
    p_evidence_digest
  from jsonb_array_elements(p_candidates) item
  on conflict (mapping_id, source_kind, canonical_url) do nothing;
end;
$$;

create function fail_npm_package_source_resolution(
  p_mapping_id uuid,
  p_resolution_run_id uuid,
  p_worker_id uuid,
  p_safe_error_code text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  failure_now timestamptz := clock_timestamp();
begin
  if p_safe_error_code is null or p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$' then
    raise exception using errcode = '22023', message = 'invalid resolver failure';
  end if;

  perform 1
  from package_source_mappings
  where id = p_mapping_id
    and lease_owner = p_worker_id
    and lease_expires_at > failure_now
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'resolver lease is not active';
  end if;

  update package_source_resolution_runs
  set status = 'failed',
      safe_error_code = p_safe_error_code,
      completed_at = failure_now
  where id = p_resolution_run_id
    and mapping_id = p_mapping_id
    and status = 'running';
  if not found then
    raise exception using errcode = 'P0001', message = 'resolver run is not active';
  end if;

  update package_source_mappings
  set status = 'failed',
      lease_owner = null,
      lease_expires_at = null,
      safe_error_code = p_safe_error_code,
      updated_at = failure_now,
      version = version + 1
  where id = p_mapping_id;
end;
$$;

revoke all on function claim_npm_package_source_mappings(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function complete_npm_package_source_resolution(uuid, uuid, uuid, text, text, text, boolean, text, jsonb)
  from public, anon, authenticated;
revoke all on function fail_npm_package_source_resolution(uuid, uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function claim_npm_package_source_mappings(uuid, uuid, integer, integer)
  to app_runtime;
grant execute on function complete_npm_package_source_resolution(uuid, uuid, uuid, text, text, text, boolean, text, jsonb)
  to app_runtime;
grant execute on function fail_npm_package_source_resolution(uuid, uuid, uuid, text)
  to app_runtime;

commit;
