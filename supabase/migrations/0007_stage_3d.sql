begin;

create table platform_operators (
  user_id uuid primary key references app_users(id) on delete restrict,
  status text not null check (status in ('active', 'revoked')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  reason text not null check (length(reason) between 1 and 500),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

create table platform_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references app_users(id) on delete restrict,
  action text not null check (length(action) between 1 and 100),
  resource_type text not null check (length(resource_type) between 1 and 100),
  resource_id uuid not null,
  request_id uuid not null,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384),
  created_at timestamptz not null default now()
);

create index platform_audit_events_resource_idx
  on platform_audit_events (resource_type, resource_id, created_at desc);

revoke all on platform_operators, platform_audit_events from anon, authenticated;
grant select on platform_operators, platform_audit_events to app_readonly;

create function is_platform_operator(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from platform_operators
    where user_id = p_user_id
      and status = 'active'
  );
$$;

create function promote_migration_specification(
  p_specification_id uuid,
  p_operator_user_id uuid,
  p_expected_revision integer,
  p_specification jsonb,
  p_reviewed_at timestamptz,
  p_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_specification migration_specifications%rowtype;
  release_is_eligible boolean;
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using
      errcode = '42501',
      message = 'platform operator authorization required';
  end if;

  select specification.*
  into current_specification
  from migration_specifications as specification
  where specification.id = p_specification_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'migration specification not found';
  end if;

  if current_specification.revision is distinct from p_expected_revision then
    raise exception using
      errcode = '40001',
      message = 'migration specification revision changed';
  end if;

  if current_specification.trust_state in ('reviewed', 'vendor_verified') then
    return false;
  end if;

  select true
  into release_is_eligible
  from vendor_releases as release
  inner join api_products as product on product.id = release.api_product_id
  inner join vendors as vendor on vendor.id = product.vendor_id
  where release.id = current_specification.vendor_release_id
    and release.processing_state = 'validated'
    and product.status = 'active'
    and vendor.trust_state = 'trusted';

  if coalesce(release_is_eligible, false) is false then
    raise exception using
      errcode = '23514',
      message = 'vendor release is not eligible for review';
  end if;

  if
    jsonb_typeof(p_specification) is distinct from 'object'
    or (p_specification - 'trust')
      is distinct from (current_specification.specification - 'trust')
    or p_specification #>> '{trust,status}' is distinct from 'reviewed'
    or p_specification #>> '{trust,generatedBy}'
      is distinct from current_specification.specification #>> '{trust,generatedBy}'
    or (p_specification #>> '{trust,reviewedAt}')::timestamptz
      is distinct from p_reviewed_at
  then
    raise exception using
      errcode = '23514',
      message = 'reviewed specification changed immutable content';
  end if;

  update vendor_releases
  set trust_state = 'reviewed'
  where id = current_specification.vendor_release_id
    and trust_state = 'draft';

  update migration_specifications
  set
    specification = p_specification,
    trust_state = 'reviewed',
    reviewed_by_user_id = p_operator_user_id,
    reviewed_at = p_reviewed_at
  where id = p_specification_id
    and trust_state = 'draft';

  insert into platform_audit_events (
    actor_user_id,
    action,
    resource_type,
    resource_id,
    request_id,
    metadata,
    created_at
  ) values (
    p_operator_user_id,
    'migration_specification.reviewed',
    'migration_specification',
    p_specification_id,
    p_request_id,
    jsonb_build_object('revision', p_expected_revision),
    p_reviewed_at
  );

  return true;
end;
$$;

create function reconcile_migration_candidate(
  p_repository_id uuid,
  p_migration_specification_id uuid,
  p_dependency_observation_id uuid,
  p_detected_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  repository_organisation_id uuid;
  product_id uuid;
  product_identifier text;
  specification_source_compatibility text;
  specification_target_version text;
  specification_revision integer;
  specification_created_at timestamptz;
  release_revision integer;
  candidate_id uuid;
begin
  select repository.organisation_id
  into repository_organisation_id
  from repositories as repository
  where repository.id = p_repository_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'repository not found';
  end if;

  select
    release.api_product_id,
    product.canonical_identifier,
    specification.source_compatibility,
    specification.target_version,
    specification.revision,
    specification.created_at,
    release.revision
  into
    product_id,
    product_identifier,
    specification_source_compatibility,
    specification_target_version,
    specification_revision,
    specification_created_at,
    release_revision
  from migration_specifications as specification
  inner join vendor_releases as release
    on release.id = specification.vendor_release_id
  inner join api_products as product on product.id = release.api_product_id
  where specification.id = p_migration_specification_id
    and specification.trust_state in ('reviewed', 'vendor_verified')
    and product.status = 'active';

  if not found then
    raise exception using
      errcode = '23514',
      message = 'migration specification is not eligible for matching';
  end if;

  if exists (
    select 1
    from migration_specifications as newer_specification
    inner join vendor_releases as newer_release
      on newer_release.id = newer_specification.vendor_release_id
    where newer_release.api_product_id = product_id
      and newer_specification.source_compatibility
        = specification_source_compatibility
      and newer_specification.target_version = specification_target_version
      and newer_specification.trust_state in ('reviewed', 'vendor_verified')
      and (
        newer_release.revision,
        newer_specification.revision,
        newer_specification.created_at,
        newer_specification.id
      ) > (
        release_revision,
        specification_revision,
        specification_created_at,
        p_migration_specification_id
      )
  ) then
    return null;
  end if;

  if p_dependency_observation_id is null then
    update migration_candidates as candidate
    set
      status = 'superseded',
      version = candidate.version + 1,
      updated_at = p_detected_at
    from migration_specifications as existing_specification
    inner join vendor_releases as existing_release
      on existing_release.id = existing_specification.vendor_release_id
    where candidate.repository_id = p_repository_id
      and candidate.status = 'open'
      and existing_specification.id = candidate.migration_specification_id
      and existing_release.api_product_id = product_id
      and existing_specification.id = p_migration_specification_id;
    return null;
  end if;

  perform 1
  from dependency_observations as observation
  inner join repository_snapshots as snapshot
    on snapshot.id = observation.repository_snapshot_id
  inner join repositories as repository on repository.id = snapshot.repository_id
  inner join github_installations as installation
    on installation.id = repository.installation_id
  where observation.id = p_dependency_observation_id
    and observation.organisation_id = repository_organisation_id
    and observation.package_name = product_identifier
    and snapshot.repository_id = p_repository_id
    and snapshot.status = 'available'
    and snapshot.expires_at > p_detected_at
    and repository.selected
    and repository.enabled
    and not repository.archived
    and installation.status = 'active'
    and not exists (
      select 1
      from repository_snapshots as newer_snapshot
      where newer_snapshot.repository_id = snapshot.repository_id
        and newer_snapshot.status = 'available'
        and (newer_snapshot.updated_at, newer_snapshot.id)
          > (snapshot.updated_at, snapshot.id)
    );

  if not found then
    raise exception using
      errcode = '23514',
      message = 'dependency observation is not eligible for matching';
  end if;

  update migration_candidates as candidate
  set
    status = 'superseded',
    version = candidate.version + 1,
    updated_at = p_detected_at
  from migration_specifications as existing_specification
  inner join vendor_releases as existing_release
    on existing_release.id = existing_specification.vendor_release_id
  where candidate.repository_id = p_repository_id
    and candidate.status = 'open'
    and existing_specification.id = candidate.migration_specification_id
    and existing_release.api_product_id = product_id
    and existing_specification.source_compatibility
      = specification_source_compatibility
    and existing_specification.target_version = specification_target_version
    and candidate.migration_specification_id <> p_migration_specification_id;

  insert into migration_candidates (
    id,
    organisation_id,
    repository_id,
    migration_specification_id,
    dependency_observation_id,
    status,
    first_detected_at,
    last_detected_at,
    version,
    created_at,
    updated_at
  ) values (
    gen_random_uuid(),
    repository_organisation_id,
    p_repository_id,
    p_migration_specification_id,
    p_dependency_observation_id,
    'open',
    p_detected_at,
    p_detected_at,
    1,
    p_detected_at,
    p_detected_at
  )
  on conflict (repository_id, migration_specification_id) where status = 'open'
  do update set
    dependency_observation_id = excluded.dependency_observation_id,
    last_detected_at = excluded.last_detected_at,
    version = migration_candidates.version + 1,
    updated_at = excluded.updated_at
  returning id into candidate_id;

  return candidate_id;
end;
$$;

revoke all on function is_platform_operator(uuid) from public;
revoke all on function promote_migration_specification(
  uuid, uuid, integer, jsonb, timestamptz, uuid
) from public;
revoke all on function reconcile_migration_candidate(
  uuid, uuid, uuid, timestamptz
) from public;

grant execute on function is_platform_operator(uuid) to app_runtime;
grant execute on function promote_migration_specification(
  uuid, uuid, integer, jsonb, timestamptz, uuid
) to app_runtime;
grant execute on function reconcile_migration_candidate(
  uuid, uuid, uuid, timestamptz
) to app_runtime;

commit;
