begin;

create or replace function claim_npm_package_source_mappings(
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

    update package_source_resolution_runs as resolution_run
    set status = 'failed',
        safe_error_code = 'NPM_REGISTRY_LEASE_EXPIRED',
        completed_at = resolver_now
    where resolution_run.mapping_id = claimed.id
      and resolution_run.status = 'running';

    update package_source_mappings as mapping
    set lease_owner = p_worker_id,
        lease_expires_at = resolver_now + make_interval(secs => p_lease_seconds),
        attempt_count = new_attempt,
        last_checked_at = resolver_now,
        updated_at = resolver_now,
        version = mapping.version + 1
    where mapping.id = claimed.id;

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

revoke all on function claim_npm_package_source_mappings(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function claim_npm_package_source_mappings(uuid, uuid, integer, integer)
  to app_runtime;

commit;
