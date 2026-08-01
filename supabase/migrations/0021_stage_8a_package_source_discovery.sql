begin;

create table package_source_mappings (
  id uuid primary key default gen_random_uuid(),
  ecosystem text not null check (ecosystem = 'npm'),
  package_name text not null check (
    length(package_name) between 1 and 214
    and package_name
      ~ '^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*$'
  ),
  status text not null check (
    status in (
      'pending_registry_lookup',
      'needs_review',
      'mapped',
      'rejected',
      'failed'
    )
  ),
  api_product_id uuid references api_products(id) on delete restrict,
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (ecosystem, package_name),
  unique (api_product_id),
  check (last_observed_at >= first_observed_at),
  check (
    (status = 'failed' and safe_error_code is not null)
    or (status <> 'failed' and safe_error_code is null)
  ),
  check (
    (status = 'mapped' and api_product_id is not null and safe_error_code is null)
    or (status <> 'mapped' and api_product_id is null)
  )
);

create index package_source_mappings_pending_idx
  on package_source_mappings (status, last_checked_at, last_observed_at desc, id)
  where status in ('pending_registry_lookup', 'failed');

revoke all on package_source_mappings from anon, authenticated, app_runtime;
grant select on package_source_mappings to app_readonly;

create function observe_npm_package_sources(
  p_package_names text[],
  p_observed_at timestamptz
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  affected_count integer;
begin
  if p_observed_at is null then
    raise exception using
      errcode = '22004',
      message = 'package observation timestamp is required';
  end if;

  if coalesce(cardinality(p_package_names), 0) > 10000 then
    raise exception using
      errcode = '54000',
      message = 'package source observation limit exceeded';
  end if;

  if exists (
    select 1
    from unnest(coalesce(p_package_names, array[]::text[])) as package(package_name)
    where
      package.package_name is null
      or length(package.package_name) not between 1 and 214
      or package.package_name
        !~ '^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*$'
  ) then
    raise exception using
      errcode = '22023',
      message = 'invalid npm package name';
  end if;

  insert into package_source_mappings (
    ecosystem,
    package_name,
    status,
    api_product_id,
    first_observed_at,
    last_observed_at,
    created_at,
    updated_at
  )
  select
    'npm',
    package.package_name,
    case
      when trusted_product.id is null then 'pending_registry_lookup'
      else 'mapped'
    end,
    trusted_product.id,
    p_observed_at,
    p_observed_at,
    p_observed_at,
    p_observed_at
  from (
    select distinct package_name
    from unnest(coalesce(p_package_names, array[]::text[])) as names(package_name)
  ) as package
  left join lateral (
    select product.id
    from api_products as product
    inner join vendors as vendor on vendor.id = product.vendor_id
    where product.ecosystem = 'npm'
      and product.canonical_identifier = package.package_name
      and product.status = 'active'
      and vendor.trust_state = 'trusted'
      and exists (
        select 1
        from vendor_sources as source
        where source.api_product_id = product.id
          and source.trust_state = 'trusted'
      )
    limit 1
  ) as trusted_product on true
  on conflict (ecosystem, package_name)
  do update set
    status = case
      when package_source_mappings.status in ('pending_registry_lookup', 'failed')
        and excluded.status = 'mapped'
        then 'mapped'
      else package_source_mappings.status
    end,
    api_product_id = case
      when package_source_mappings.status in ('pending_registry_lookup', 'failed')
        and excluded.status = 'mapped'
        then excluded.api_product_id
      else package_source_mappings.api_product_id
    end,
    safe_error_code = case
      when package_source_mappings.status in ('pending_registry_lookup', 'failed')
        and excluded.status = 'mapped'
        then null
      else package_source_mappings.safe_error_code
    end,
    last_observed_at = greatest(
      package_source_mappings.last_observed_at,
      excluded.last_observed_at
    ),
    updated_at = greatest(
      package_source_mappings.updated_at,
      excluded.updated_at
    ),
    version = case
      when excluded.last_observed_at > package_source_mappings.last_observed_at
        then package_source_mappings.version + 1
      else package_source_mappings.version
    end;

  get diagnostics affected_count = row_count;
  return affected_count;
end;
$$;

revoke all on function observe_npm_package_sources(text[], timestamptz) from public;
grant execute on function observe_npm_package_sources(text[], timestamptz)
to app_runtime;

commit;
