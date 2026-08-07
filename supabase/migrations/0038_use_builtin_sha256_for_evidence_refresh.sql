begin;

-- PostgreSQL provides SHA-256 in pg_catalog. Using the built-in function keeps
-- this security-definer function independent of pgcrypto schema visibility and
-- lets it retain the narrower search path used by the rest of the catalogue.
create or replace function request_package_evidence_refresh(
  p_mapping_id uuid,
  p_operator_user_id uuid,
  p_expected_mapping_version integer,
  p_request_id uuid
)
returns table (
  previous_vendor_release_id uuid,
  vendor_release_id uuid,
  source_version text,
  target_version text,
  release_revision integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_mapping package_source_mappings%rowtype;
  current_control package_source_mapping_controls%rowtype;
  current_release vendor_releases%rowtype;
  next_release_id uuid := gen_random_uuid();
  next_revision integer;
  catalogue_digest text;
  correlation_id_value uuid := gen_random_uuid();
  created_at_value timestamptz := now();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_request_id is null or p_expected_mapping_version is null
    or p_expected_mapping_version < 1
  then
    raise exception using errcode = '22023', message = 'invalid evidence refresh';
  end if;

  select mapping.* into current_mapping
  from package_source_mappings as mapping
  where mapping.id = p_mapping_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package source mapping not found';
  end if;
  select control.* into current_control
  from package_source_mapping_controls as control
  where control.mapping_id = current_mapping.id
  for update;
  if not found or current_control.disabled then
    raise exception using errcode = '23514', message = 'package source mapping disabled';
  end if;
  if current_mapping.version <> p_expected_mapping_version then
    raise exception using errcode = '40001', message = 'package source mapping changed';
  end if;
  if current_mapping.status <> 'mapped' or current_mapping.api_product_id is null then
    raise exception using errcode = '23514', message = 'package source mapping is not ready';
  end if;

  select release.* into current_release
  from vendor_releases as release
  join migration_specifications as specification
    on specification.vendor_release_id = release.id
  where release.api_product_id = current_mapping.api_product_id
    and specification.trust_state = 'draft'
    and jsonb_path_exists(
      specification.specification,
      '$.changes[*] ? (@.certainty == "ambiguous")'
    )
  order by release.revision desc, specification.revision desc
  limit 1
  for update of release;
  if not found then
    raise exception using errcode = '23514', message = 'no ambiguous migration draft requires refresh';
  end if;

  if exists (
    select 1
    from vendor_releases as newer_release
    where newer_release.api_product_id = current_release.api_product_id
      and newer_release.version = current_release.version
      and newer_release.revision > current_release.revision
      and newer_release.processing_state in ('registered', 'fetched', 'validated')
      and not exists (
        select 1 from migration_specifications as newer_specification
        where newer_specification.vendor_release_id = newer_release.id
      )
  ) then
    raise exception using errcode = '40001', message = 'evidence refresh already in progress';
  end if;

  if not exists (
    select 1
    from vendor_sources as source
    where source.api_product_id = current_mapping.api_product_id
      and source.trust_state = 'trusted'
      and not exists (
        select 1 from vendor_evidence_items as item
        where item.vendor_release_id = current_release.id
          and item.vendor_source_id = source.id
      )
  ) then
    raise exception using errcode = '23514', message = 'no newly trusted evidence source is available';
  end if;

  select encode(
    pg_catalog.sha256(
      convert_to(
        string_agg(
          source.id::text || ':' || source.source_kind || ':' || source.canonical_url,
          E'\n' order by source.id
        ),
        'UTF8'
      )
    ),
    'hex'
  ) into catalogue_digest
  from vendor_sources as source
  where source.api_product_id = current_mapping.api_product_id
    and source.trust_state = 'trusted';

  select coalesce(max(release.revision), 0) + 1 into next_revision
  from vendor_releases as release
  where release.api_product_id = current_release.api_product_id
    and release.version = current_release.version;

  insert into vendor_releases (
    id, api_product_id, version, source_compatibility, revision, published_at,
    source_digest, processing_state, trust_state, created_at
  ) values (
    next_release_id, current_release.api_product_id, current_release.version,
    current_release.source_compatibility, next_revision, current_release.published_at,
    catalogue_digest, 'registered', 'draft', created_at_value
  );

  insert into release_intelligence_outbox (
    event_type, aggregate_id, aggregate_version, idempotency_key, payload
  ) values (
    'release_intelligence.requested', next_release_id, next_revision,
    'release-intelligence:' || next_release_id::text,
    jsonb_build_object(
      'schemaVersion', '1.0',
      'vendorReleaseId', next_release_id,
      'correlationId', correlation_id_value
    )
  );

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id, 'package_evidence.refresh_requested',
    'vendor_release', next_release_id, p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'previous_vendor_release_id', current_release.id,
      'release_revision', next_revision
    ),
    created_at_value
  );

  previous_vendor_release_id := current_release.id;
  vendor_release_id := next_release_id;
  source_version := current_release.source_compatibility;
  target_version := current_release.version;
  release_revision := next_revision;
  return next;
end;
$$;

commit;
