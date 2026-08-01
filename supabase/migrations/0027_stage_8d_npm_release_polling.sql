begin;

create table package_source_poll_states (
  source_id uuid primary key references vendor_sources(id) on delete cascade,
  next_poll_at timestamptz not null default now(),
  lease_owner uuid,
  lease_expires_at timestamptz,
  consecutive_failures integer not null default 0 check (consecutive_failures between 0 and 1000000),
  exhausted_alerted_at timestamptz,
  last_success_at timestamptz,
  last_observed_version text,
  last_observed_published_at timestamptz,
  last_metadata_digest text,
  latest_deprecated boolean,
  inconsistency_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check (last_observed_version is null or length(last_observed_version) between 1 and 100),
  check (last_metadata_digest is null or last_metadata_digest ~ '^[a-f0-9]{64}$'),
  check (inconsistency_code is null or inconsistency_code ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

create index package_source_poll_states_due_idx
  on package_source_poll_states (next_poll_at, source_id)
  where lease_expires_at is null;

create table package_source_poll_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references vendor_sources(id) on delete cascade,
  attempt integer not null check (attempt > 0),
  correlation_id uuid not null,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  outcome text check (
    outcome is null or outcome in (
      'baseline', 'not_modified', 'unchanged', 'release_detected', 'inconsistent'
    )
  ),
  previous_version text,
  observed_version text,
  observed_published_at timestamptz,
  latest_deprecated boolean,
  registry_etag text,
  evidence_object_key text,
  evidence_digest text,
  metadata_digest text,
  retryable boolean,
  safe_error_code text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (source_id, attempt),
  check (previous_version is null or length(previous_version) between 1 and 100),
  check (observed_version is null or length(observed_version) between 1 and 100),
  check (registry_etag is null or length(registry_etag) <= 512),
  check (evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'),
  check (metadata_digest is null or metadata_digest ~ '^[a-f0-9]{64}$'),
  check (safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  check (
    (status = 'running' and outcome is null and completed_at is null and safe_error_code is null)
    or (
      status = 'succeeded' and outcome is not null and completed_at is not null
      and safe_error_code is null and retryable is null
      and (
        (outcome = 'not_modified' and evidence_object_key is null and evidence_digest is null
          and metadata_digest is null and observed_version is null)
        or
        (outcome <> 'not_modified' and evidence_object_key is not null
          and evidence_digest is not null and metadata_digest is not null
          and observed_version is not null and latest_deprecated is not null)
      )
    )
    or (
      status = 'failed' and outcome is null and completed_at is not null
      and safe_error_code is not null and retryable is not null
      and evidence_object_key is null and evidence_digest is null and metadata_digest is null
    )
  )
);

create index package_source_poll_runs_source_idx
  on package_source_poll_runs (source_id, started_at desc);

create table package_release_detections (
  id uuid primary key default gen_random_uuid(),
  api_product_id uuid not null references api_products(id) on delete restrict,
  source_id uuid not null references vendor_sources(id) on delete restrict,
  version text not null check (length(version) between 1 and 100),
  published_at timestamptz,
  first_detected_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  latest_deprecated boolean not null,
  evidence_object_key text not null,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  metadata_digest text not null check (metadata_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'detected' check (status in ('detected', 'superseded')),
  unique (api_product_id, version)
);

create index package_release_detections_product_idx
  on package_release_detections (api_product_id, first_detected_at desc);

create table package_version_deprecation_states (
  api_product_id uuid not null references api_products(id) on delete cascade,
  version text not null check (length(version) between 1 and 100),
  source_id uuid not null references vendor_sources(id) on delete restrict,
  deprecated boolean not null,
  evidence_object_key text not null,
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  primary key (api_product_id, version)
);

revoke all on package_source_poll_states, package_source_poll_runs,
  package_release_detections, package_version_deprecation_states
  from public, anon, authenticated, app_runtime;
grant select on package_source_poll_states, package_source_poll_runs,
  package_release_detections, package_version_deprecation_states
  to app_readonly;

create function claim_due_npm_package_sources(
  p_worker_id uuid,
  p_correlation_id uuid,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  source_id uuid,
  api_product_id uuid,
  package_name text,
  canonical_url text,
  poll_run_id uuid,
  previous_etag text,
  previous_version text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  claimed record;
  new_run_id uuid;
  new_attempt integer;
  poll_now timestamptz := clock_timestamp();
begin
  if p_worker_id is null or p_correlation_id is null
    or p_limit is null or p_limit not between 1 and 10
    or p_lease_seconds is null or p_lease_seconds not between 30 and 300
  then
    raise exception using errcode = '22023', message = 'invalid package source poll claim';
  end if;

  for claimed in
    select
      source.id as source_id,
      source.api_product_id,
      source.canonical_url,
      source.last_etag,
      product.canonical_identifier as package_name,
      source.poll_interval_seconds
    from vendor_sources as source
    join api_products as product on product.id = source.api_product_id
    join vendors as vendor on vendor.id = product.vendor_id
    left join package_source_poll_states as state on state.source_id = source.id
    where source.source_kind = 'package_registry_release'
      and source.trust_state = 'trusted'
      and source.canonical_domain = 'registry.npmjs.org'
      and product.ecosystem = 'npm'
      and product.status = 'active'
      and vendor.trust_state = 'trusted'
      and (state.lease_expires_at is null or state.lease_expires_at <= poll_now)
      and coalesce(
        state.next_poll_at,
        source.last_checked_at + make_interval(secs => source.poll_interval_seconds),
        '-infinity'::timestamptz
      ) <= poll_now
    order by coalesce(state.next_poll_at, '-infinity'::timestamptz), source.id
    for update of source skip locked
    limit p_limit
  loop
    insert into package_source_poll_states (
      source_id,
      next_poll_at,
      last_observed_version,
      last_metadata_digest,
      latest_deprecated,
      created_at,
      updated_at
    )
    select
      claimed.source_id,
      poll_now,
      mapping.latest_version,
      mapping.registry_metadata_digest,
      mapping.latest_deprecated,
      poll_now,
      poll_now
    from (select 1) as seed
    left join lateral (
      select mapping.latest_version, mapping.registry_metadata_digest,
        mapping.latest_deprecated
      from package_source_mappings as mapping
      where mapping.api_product_id = claimed.api_product_id
        and mapping.status = 'mapped'
      order by mapping.resolved_at desc nulls last, mapping.id
      limit 1
    ) as mapping on true
    on conflict (source_id) do nothing;

    perform 1 from package_source_poll_states
    where package_source_poll_states.source_id = claimed.source_id
    for update;

    update package_source_poll_runs
    set status = 'failed', retryable = true,
        safe_error_code = 'PACKAGE_SOURCE_POLL_LEASE_EXPIRED',
        completed_at = poll_now
    where package_source_poll_runs.source_id = claimed.source_id
      and status = 'running';

    select coalesce(max(run.attempt), 0) + 1 into new_attempt
    from package_source_poll_runs as run
    where run.source_id = claimed.source_id;
    new_run_id := gen_random_uuid();

    update package_source_poll_states
    set lease_owner = p_worker_id,
        lease_expires_at = poll_now + make_interval(secs => p_lease_seconds),
        updated_at = poll_now
    where package_source_poll_states.source_id = claimed.source_id;

    insert into package_source_poll_runs (
      id, source_id, attempt, correlation_id, status, previous_version, started_at
    )
    select new_run_id, claimed.source_id, new_attempt, p_correlation_id, 'running',
      state.last_observed_version, poll_now
    from package_source_poll_states as state
    where state.source_id = claimed.source_id;

    source_id := claimed.source_id;
    api_product_id := claimed.api_product_id;
    package_name := claimed.package_name;
    canonical_url := claimed.canonical_url;
    poll_run_id := new_run_id;
    previous_etag := claimed.last_etag;
    select state.last_observed_version into previous_version
    from package_source_poll_states as state
    where state.source_id = claimed.source_id;
    return next;
  end loop;
end;
$$;

create function complete_npm_package_source_poll(
  p_source_id uuid,
  p_poll_run_id uuid,
  p_worker_id uuid,
  p_outcome text,
  p_evidence_object_key text,
  p_evidence_digest text,
  p_metadata_digest text,
  p_observed_version text,
  p_observed_published_at timestamptz,
  p_latest_deprecated boolean,
  p_registry_etag text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_source vendor_sources%rowtype;
  current_state package_source_poll_states%rowtype;
  completion_now timestamptz := clock_timestamp();
begin
  if p_outcome is null
    or p_outcome not in ('baseline', 'not_modified', 'unchanged', 'release_detected', 'inconsistent')
    or (p_registry_etag is not null and length(p_registry_etag) > 512)
    or (
      p_outcome = 'not_modified' and (
        p_evidence_object_key is not null or p_evidence_digest is not null
        or p_metadata_digest is not null or p_observed_version is not null
        or p_observed_published_at is not null or p_latest_deprecated is not null
      )
    )
    or (
      p_outcome <> 'not_modified' and (
        p_evidence_object_key is null
        or p_evidence_object_key !~ '^env/(development|staging|production)/package-release/npm/source/[0-9a-f-]{36}/poll/[0-9a-f-]{36}/metadata\.json$'
        or p_evidence_object_key not like (
          '%/source/' || p_source_id::text || '/poll/' || p_poll_run_id::text
          || '/metadata.json'
        )
        or p_evidence_digest is null
        or p_evidence_digest !~ '^[a-f0-9]{64}$'
        or p_metadata_digest is null
        or p_metadata_digest !~ '^[a-f0-9]{64}$'
        or p_observed_version is null
        or length(p_observed_version) not between 1 and 100
        or p_latest_deprecated is null
      )
    )
  then
    raise exception using errcode = '22023', message = 'invalid package source poll completion';
  end if;

  select source.* into current_source
  from vendor_sources as source
  join api_products as product on product.id = source.api_product_id
  join vendors as vendor on vendor.id = product.vendor_id
  where source.id = p_source_id
    and source.source_kind = 'package_registry_release'
    and source.trust_state = 'trusted'
    and source.canonical_domain = 'registry.npmjs.org'
    and product.ecosystem = 'npm'
    and product.status = 'active'
    and vendor.trust_state = 'trusted'
  for update of source;
  if not found then
    raise exception using errcode = 'P0001', message = 'trusted package source is unavailable';
  end if;

  select state.* into current_state
  from package_source_poll_states as state
  where state.source_id = p_source_id
    and state.lease_owner = p_worker_id
    and state.lease_expires_at > completion_now
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'package source poll lease is not active';
  end if;

  perform 1 from package_source_poll_runs as run
  where run.id = p_poll_run_id and run.source_id = p_source_id and run.status = 'running'
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'package source poll run is not active';
  end if;

  if p_outcome = 'baseline' and current_state.last_observed_version is not null
    or p_outcome = 'unchanged' and current_state.last_observed_version is distinct from p_observed_version
    or p_outcome = 'release_detected' and (
      current_state.last_observed_version is null
      or current_state.last_observed_version = p_observed_version
    )
    or p_outcome = 'inconsistent' and (
      current_state.last_observed_version is null
      or current_state.last_observed_version = p_observed_version
    )
  then
    raise exception using errcode = '22023', message = 'package source poll outcome mismatch';
  end if;

  if p_outcome = 'release_detected' then
    insert into package_release_detections (
      api_product_id, source_id, version, published_at, first_detected_at,
      last_observed_at, latest_deprecated, evidence_object_key,
      evidence_digest, metadata_digest
    ) values (
      current_source.api_product_id, p_source_id, p_observed_version,
      p_observed_published_at, completion_now, completion_now, p_latest_deprecated,
      p_evidence_object_key, p_evidence_digest, p_metadata_digest
    )
    on conflict (api_product_id, version) do update
    set last_observed_at = excluded.last_observed_at,
        latest_deprecated = excluded.latest_deprecated,
        evidence_object_key = excluded.evidence_object_key,
        evidence_digest = excluded.evidence_digest,
        metadata_digest = excluded.metadata_digest;
  end if;

  if p_outcome not in ('not_modified', 'inconsistent') then
    insert into package_version_deprecation_states (
      api_product_id, version, source_id, deprecated, evidence_object_key,
      evidence_digest, first_observed_at, last_observed_at
    ) values (
      current_source.api_product_id, p_observed_version, p_source_id,
      p_latest_deprecated, p_evidence_object_key, p_evidence_digest,
      completion_now, completion_now
    )
    on conflict (api_product_id, version) do update
    set deprecated = excluded.deprecated,
        source_id = excluded.source_id,
        evidence_object_key = excluded.evidence_object_key,
        evidence_digest = excluded.evidence_digest,
        last_observed_at = excluded.last_observed_at;
  end if;

  update package_source_poll_runs
  set status = 'succeeded', outcome = p_outcome,
      observed_version = p_observed_version,
      observed_published_at = p_observed_published_at,
      latest_deprecated = p_latest_deprecated,
      registry_etag = p_registry_etag,
      evidence_object_key = p_evidence_object_key,
      evidence_digest = p_evidence_digest,
      metadata_digest = p_metadata_digest,
      completed_at = completion_now
  where id = p_poll_run_id;

  update vendor_sources
  set last_checked_at = completion_now,
      last_etag = case when p_outcome = 'inconsistent' then last_etag else p_registry_etag end,
      last_digest = case when p_outcome in ('not_modified', 'inconsistent') then last_digest else p_metadata_digest end,
      updated_at = completion_now
  where id = p_source_id;

  update package_source_poll_states
  set lease_owner = null,
      lease_expires_at = null,
      consecutive_failures = 0,
      exhausted_alerted_at = null,
      last_success_at = completion_now,
      next_poll_at = completion_now + case
        when p_outcome = 'inconsistent' then interval '15 minutes'
        else make_interval(secs => current_source.poll_interval_seconds)
      end,
      last_observed_version = case
        when p_outcome in ('not_modified', 'inconsistent') then last_observed_version
        else p_observed_version
      end,
      last_observed_published_at = case
        when p_outcome in ('not_modified', 'inconsistent') then last_observed_published_at
        else p_observed_published_at
      end,
      last_metadata_digest = case
        when p_outcome in ('not_modified', 'inconsistent') then last_metadata_digest
        else p_metadata_digest
      end,
      latest_deprecated = case
        when p_outcome in ('not_modified', 'inconsistent') then latest_deprecated
        else p_latest_deprecated
      end,
      inconsistency_code = case
        when p_outcome = 'inconsistent' then 'NPM_REGISTRY_VERSION_ROLLBACK'
        else null
      end,
      updated_at = completion_now
  where source_id = p_source_id;
end;
$$;

create function fail_npm_package_source_poll(
  p_source_id uuid,
  p_poll_run_id uuid,
  p_worker_id uuid,
  p_safe_error_code text,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_state package_source_poll_states%rowtype;
  current_source vendor_sources%rowtype;
  failure_count integer;
  should_alert boolean;
  failure_now timestamptz := clock_timestamp();
begin
  if p_safe_error_code is null or p_safe_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$'
    or p_retryable is null
  then
    raise exception using errcode = '22023', message = 'invalid package source poll failure';
  end if;

  select state.* into current_state
  from package_source_poll_states as state
  where state.source_id = p_source_id
    and state.lease_owner = p_worker_id
    and state.lease_expires_at > failure_now
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'package source poll lease is not active';
  end if;
  select source.* into current_source from vendor_sources as source
  where source.id = p_source_id for update;

  update package_source_poll_runs
  set status = 'failed', retryable = p_retryable,
      safe_error_code = p_safe_error_code, completed_at = failure_now
  where id = p_poll_run_id and source_id = p_source_id and status = 'running';
  if not found then
    raise exception using errcode = 'P0001', message = 'package source poll run is not active';
  end if;

  failure_count := current_state.consecutive_failures + 1;
  should_alert := (not p_retryable or failure_count >= 5)
    and current_state.exhausted_alerted_at is null;

  update package_source_poll_states
  set lease_owner = null,
      lease_expires_at = null,
      consecutive_failures = failure_count,
      next_poll_at = failure_now + case
        when p_retryable then make_interval(
          secs => least(current_source.poll_interval_seconds,
            300 * (2 ^ least(failure_count - 1, 6))::integer)
        )
        else make_interval(secs => current_source.poll_interval_seconds)
      end,
      exhausted_alerted_at = case
        when should_alert then failure_now else exhausted_alerted_at
      end,
      updated_at = failure_now
  where source_id = p_source_id;
  return should_alert;
end;
$$;

revoke all on function claim_due_npm_package_sources(uuid, uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function complete_npm_package_source_poll(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, text
) from public, anon, authenticated;
revoke all on function fail_npm_package_source_poll(uuid, uuid, uuid, text, boolean)
  from public, anon, authenticated;

grant execute on function claim_due_npm_package_sources(uuid, uuid, integer, integer)
  to app_runtime;
grant execute on function complete_npm_package_source_poll(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, text
) to app_runtime;
grant execute on function fail_npm_package_source_poll(uuid, uuid, uuid, text, boolean)
  to app_runtime;

commit;
