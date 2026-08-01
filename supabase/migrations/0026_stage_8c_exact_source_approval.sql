begin;

create function review_exact_package_source_candidate(
  p_candidate_id uuid,
  p_operator_user_id uuid,
  p_expected_candidate_version integer,
  p_expected_mapping_version integer,
  p_decision text,
  p_poll_interval_seconds integer,
  p_rejection_reason_code text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_candidate package_source_candidates%rowtype;
  current_mapping package_source_mappings%rowtype;
  current_control package_source_mapping_controls%rowtype;
  current_product api_products%rowtype;
  current_vendor vendors%rowtype;
  current_source vendor_sources%rowtype;
  source_key_value text;
  expected_media_types_value text[];
  reviewed_at_value timestamptz := now();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_request_id is null or p_decision not in ('approve', 'reject') then
    raise exception using errcode = '22023', message = 'invalid package source review';
  end if;

  select candidate.* into current_candidate
  from package_source_candidates as candidate
  where candidate.id = p_candidate_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package source candidate not found';
  end if;

  select mapping.* into current_mapping
  from package_source_mappings as mapping
  where mapping.id = current_candidate.mapping_id
  for update;
  select control.* into current_control
  from package_source_mapping_controls as control
  where control.mapping_id = current_mapping.id
  for update;

  if not found or current_control.disabled then
    raise exception using errcode = '23514', message = 'package source mapping disabled';
  end if;
  if current_candidate.review_state <> 'pending_review'
    or current_candidate.version <> p_expected_candidate_version
    or current_mapping.version <> p_expected_mapping_version
  then
    raise exception using errcode = '40001', message = 'package source review conflict';
  end if;
  if current_candidate.evidence_digest is distinct from current_mapping.registry_metadata_digest
    or not exists (
      select 1
      from package_source_resolution_runs as resolution_run
      where resolution_run.id = current_candidate.resolution_run_id
        and resolution_run.mapping_id = current_mapping.id
        and resolution_run.status = 'succeeded'
        and resolution_run.evidence_digest = current_candidate.evidence_digest
    )
  then
    raise exception using errcode = '23514', message = 'package source evidence changed';
  end if;

  if p_decision = 'approve' then
    if current_candidate.source_kind not in (
      'package_registry_release', 'sdk_repository_release', 'changelog',
      'release_feed', 'migration_guide'
    ) or p_poll_interval_seconds is null
      or p_poll_interval_seconds not between 3600 and 2592000
      or p_rejection_reason_code is not null
    then
      raise exception using errcode = '22023', message = 'invalid package source approval';
    end if;
    if current_candidate.source_kind = 'package_registry_release'
      and current_candidate.canonical_domain <> 'registry.npmjs.org'
    then
      raise exception using errcode = '23514', message = 'invalid npm registry source';
    end if;

    if current_mapping.api_product_id is not null then
      select product.* into current_product
      from api_products as product
      where product.id = current_mapping.api_product_id
      for update;
    else
      select product.* into current_product
      from api_products as product
      where product.ecosystem = 'npm'
        and product.canonical_identifier = current_mapping.package_name
      for update;
    end if;

    if current_product.id is null then
      insert into vendors (
        slug, name, official_domains, trust_state, synthetic, created_at, updated_at
      ) values (
        'npm-' || substring(replace(current_mapping.id::text, '-', '') from 1 for 16),
        left(current_mapping.package_name, 120),
        array[current_candidate.canonical_domain],
        'trusted',
        false,
        reviewed_at_value,
        reviewed_at_value
      ) returning * into current_vendor;
      insert into api_products (
        vendor_id, ecosystem, canonical_identifier, status, created_at, updated_at
      ) values (
        current_vendor.id, 'npm', current_mapping.package_name, 'active',
        reviewed_at_value, reviewed_at_value
      ) returning * into current_product;
    else
      select vendor.* into current_vendor
      from vendors as vendor
      where vendor.id = current_product.vendor_id
      for update;
      if current_product.status <> 'active'
        or current_vendor.synthetic
        or current_vendor.trust_state = 'disabled'
      then
        raise exception using errcode = '23514', message = 'package catalog entry unavailable';
      end if;
      if not current_candidate.canonical_domain = any(current_vendor.official_domains) then
        if cardinality(current_vendor.official_domains) >= 20 then
          raise exception using errcode = '23514', message = 'package source domain limit reached';
        end if;
        update vendors
        set official_domains = array_append(
              official_domains,
              current_candidate.canonical_domain
            ),
            updated_at = reviewed_at_value
        where id = current_vendor.id
        returning * into current_vendor;
      end if;
    end if;

    source_key_value := case current_candidate.source_kind
      when 'package_registry_release' then 'package_registry'
      when 'sdk_repository_release' then 'sdk_repository'
      when 'changelog' then 'changelog'
      when 'release_feed' then 'release_feed'
      else 'migration_guide'
    end;
    expected_media_types_value := case current_candidate.source_kind
      when 'package_registry_release' then array['application/json']
      when 'release_feed' then array['application/atom+xml', 'application/rss+xml', 'application/json']
      else array['text/html', 'application/xhtml+xml']
    end;

    select source.* into current_source
    from vendor_sources as source
    where source.api_product_id = current_product.id
      and source.source_key = source_key_value
    for update;
    if not found then
      if exists (
        select 1 from vendor_sources as source
        where source.api_product_id = current_product.id
          and source.canonical_url = current_candidate.canonical_url
      ) then
        raise exception using errcode = '23514', message = 'package source conflicts with catalog';
      end if;
      insert into vendor_sources (
        api_product_id, source_key, source_kind, canonical_url, canonical_domain,
        expected_media_types, trust_state, poll_interval_seconds, created_at, updated_at
      ) values (
        current_product.id, source_key_value, current_candidate.source_kind,
        current_candidate.canonical_url, current_candidate.canonical_domain,
        expected_media_types_value, 'trusted', p_poll_interval_seconds,
        reviewed_at_value, reviewed_at_value
      );
    elsif current_source.source_kind <> current_candidate.source_kind
      or current_source.canonical_url <> current_candidate.canonical_url
      or current_source.canonical_domain <> current_candidate.canonical_domain
    then
      raise exception using errcode = '23514', message = 'package source conflicts with catalog';
    else
      update vendor_sources
      set trust_state = 'trusted',
          poll_interval_seconds = p_poll_interval_seconds,
          expected_media_types = expected_media_types_value,
          updated_at = reviewed_at_value
      where id = current_source.id;
    end if;

    update package_source_candidates
    set review_state = 'approved', reviewed_by_user_id = p_operator_user_id,
        reviewed_at = reviewed_at_value, rejection_reason_code = null,
        version = version + 1
    where id = current_candidate.id;
    update package_source_mappings
    set status = 'mapped', api_product_id = current_product.id,
        safe_error_code = null, updated_at = reviewed_at_value,
        version = version + 1
    where id = current_mapping.id;
  else
    if p_poll_interval_seconds is not null
      or p_rejection_reason_code is null
      or p_rejection_reason_code not in ('NOT_OFFICIAL', 'DUPLICATE', 'UNSUPPORTED_SOURCE')
    then
      raise exception using errcode = '22023', message = 'invalid package source rejection';
    end if;
    update package_source_candidates
    set review_state = 'rejected', reviewed_by_user_id = p_operator_user_id,
        reviewed_at = reviewed_at_value,
        rejection_reason_code = p_rejection_reason_code,
        version = version + 1
    where id = current_candidate.id;
    update package_source_mappings as mapping
    set status = case
          when mapping.api_product_id is not null then 'mapped'
          when exists (
            select 1 from package_source_candidates as candidate
            where candidate.mapping_id = mapping.id
              and candidate.id <> current_candidate.id
              and candidate.review_state = 'pending_review'
          ) then 'needs_review'
          else 'rejected'
        end,
        updated_at = reviewed_at_value,
        version = version + 1
    where mapping.id = current_mapping.id;
  end if;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id,
    'package_source_candidate.' || case p_decision when 'approve' then 'approved' else 'rejected' end,
    'package_source_candidate', current_candidate.id, p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'source_kind', current_candidate.source_kind,
      'decision', p_decision,
      'approval_scope', 'exact_url',
      'fetch_origin', current_candidate.canonical_domain,
      'api_product_id', current_product.id
    ),
    reviewed_at_value
  );
  return current_mapping.id;
end;
$$;

revoke all on function review_exact_package_source_candidate(
  uuid, uuid, integer, integer, text, integer, text, uuid
) from public, anon, authenticated;
grant execute on function review_exact_package_source_candidate(
  uuid, uuid, integer, integer, text, integer, text, uuid
) to app_runtime;

commit;
