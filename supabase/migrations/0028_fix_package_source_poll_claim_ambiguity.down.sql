begin;

create or replace function claim_due_npm_package_sources(
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

revoke all on function claim_due_npm_package_sources(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function claim_due_npm_package_sources(uuid, uuid, integer, integer)
  to app_runtime;

commit;
