begin;

alter table package_source_candidates
  add column version integer not null default 1 check (version > 0),
  add column discovery_method text,
  add column proposal_reason_code text,
  add column proposal_note text check (
    proposal_note is null or length(proposal_note) between 1 and 500
  ),
  add column supersedes_candidate_id uuid
    references package_source_candidates(id) on delete restrict,
  add column proposed_by_user_id uuid references app_users(id) on delete restrict,
  add column rejection_reason_code text check (
    rejection_reason_code is null
    or rejection_reason_code in (
      'NOT_OFFICIAL',
      'DUPLICATE',
      'UNSUPPORTED_SOURCE',
      'REPLACED'
    )
  );

create function assign_npm_package_source_candidate_provenance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.discovery_method is null then
    new.discovery_method := 'npm_registry_metadata';
    new.proposal_reason_code := case new.source_kind
      when 'package_registry_release' then 'NPM_REGISTRY_AUTHORITATIVE'
      when 'sdk_repository_release' then 'NPM_REPOSITORY_DECLARATION'
      when 'homepage' then 'NPM_HOMEPAGE_DECLARATION'
      when 'issue_tracker' then 'NPM_BUGS_DECLARATION'
      else null
    end;
  end if;
  return new;
end;
$$;

create trigger package_source_candidate_provenance_insert
before insert on package_source_candidates
for each row execute function assign_npm_package_source_candidate_provenance();
revoke all on function assign_npm_package_source_candidate_provenance()
from public, anon, authenticated, app_runtime;

update package_source_candidates
set discovery_method = 'npm_registry_metadata',
    proposal_reason_code = case source_kind
      when 'package_registry_release' then 'NPM_REGISTRY_AUTHORITATIVE'
      when 'sdk_repository_release' then 'NPM_REPOSITORY_DECLARATION'
      when 'homepage' then 'NPM_HOMEPAGE_DECLARATION'
      else 'NPM_BUGS_DECLARATION'
    end;

alter table package_source_candidates
  alter column discovery_method set not null,
  alter column proposal_reason_code set not null,
  drop constraint package_source_candidates_source_kind_check,
  add constraint package_source_candidates_source_kind_check check (
    source_kind in (
      'package_registry_release',
      'sdk_repository_release',
      'changelog',
      'release_feed',
      'migration_guide',
      'homepage',
      'issue_tracker'
    )
  ),
  add constraint package_source_candidates_provenance_check check (
    (
      discovery_method = 'npm_registry_metadata'
      and supersedes_candidate_id is null
      and proposed_by_user_id is null
      and proposal_note is null
      and proposal_reason_code in (
        'NPM_REGISTRY_AUTHORITATIVE',
        'NPM_REPOSITORY_DECLARATION',
        'NPM_HOMEPAGE_DECLARATION',
        'NPM_BUGS_DECLARATION'
      )
    )
    or (
      discovery_method = 'operator_replacement'
      and supersedes_candidate_id is not null
      and proposed_by_user_id is not null
      and proposal_reason_code = 'OPERATOR_REPLACEMENT'
    )
  );

alter table vendor_sources
  drop constraint vendor_sources_source_kind_check,
  add constraint vendor_sources_source_kind_check check (
    source_kind in (
      'package_registry_release',
      'migration_guide',
      'changelog',
      'release_feed',
      'api_definition',
      'sdk_repository_release'
    )
  );

create table package_source_mapping_controls (
  mapping_id uuid primary key
    references package_source_mappings(id) on delete cascade,
  disabled boolean not null default false,
  disabled_reason_code text check (
    disabled_reason_code is null
    or disabled_reason_code in (
      'OPERATOR_DISABLED',
      'PACKAGE_UNSUPPORTED',
      'SECURITY_CONCERN'
    )
  ),
  disabled_by_user_id uuid references app_users(id) on delete restrict,
  disabled_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (not disabled and disabled_reason_code is null and disabled_by_user_id is null and disabled_at is null)
    or (disabled and disabled_reason_code is not null and disabled_by_user_id is not null and disabled_at is not null)
  )
);

create table package_source_mapping_disabled_sources (
  mapping_id uuid not null
    references package_source_mappings(id) on delete cascade,
  source_id uuid not null references vendor_sources(id) on delete cascade,
  previous_trust_state text not null check (
    previous_trust_state in ('draft', 'trusted')
  ),
  disabled_at timestamptz not null,
  primary key (mapping_id, source_id)
);

insert into package_source_mapping_controls (mapping_id)
select id from package_source_mappings;

create function initialize_package_source_mapping_control()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into package_source_mapping_controls (mapping_id)
  values (new.id)
  on conflict (mapping_id) do nothing;
  return new;
end;
$$;

create trigger package_source_mapping_control_insert
after insert on package_source_mappings
for each row execute function initialize_package_source_mapping_control();
revoke all on function initialize_package_source_mapping_control()
from public, anon, authenticated, app_runtime;

revoke all on package_source_mapping_controls from public, anon, authenticated, app_runtime;
grant select on package_source_mapping_controls to app_readonly;
revoke all on package_source_mapping_disabled_sources
from public, anon, authenticated, app_runtime;

alter table package_source_candidates
  drop constraint package_source_candidates_check,
  add constraint package_source_candidates_review_check check (
    (
      review_state = 'pending_review'
      and reviewed_by_user_id is null
      and reviewed_at is null
      and rejection_reason_code is null
    )
    or (
      review_state = 'approved'
      and reviewed_by_user_id is not null
      and reviewed_at is not null
      and rejection_reason_code is null
    )
    or (
      review_state = 'rejected'
      and reviewed_by_user_id is not null
      and reviewed_at is not null
      and rejection_reason_code is not null
    )
  );

create function review_package_source_candidate(
  p_candidate_id uuid,
  p_operator_user_id uuid,
  p_expected_candidate_version integer,
  p_expected_mapping_version integer,
  p_decision text,
  p_catalog_mode text,
  p_existing_api_product_id uuid,
  p_existing_vendor_id uuid,
  p_vendor_slug text,
  p_vendor_name text,
  p_official_domains text[],
  p_approve_candidate_domain boolean,
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
  current_vendor vendors%rowtype;
  current_product api_products%rowtype;
  current_source vendor_sources%rowtype;
  current_control package_source_mapping_controls%rowtype;
  source_key_value text;
  expected_media_types_value text[];
  domain_added boolean := false;
  reviewed_at_value timestamptz := clock_timestamp();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using
      errcode = '42501',
      message = 'platform operator authorization required';
  end if;
  if p_request_id is null
    or p_expected_candidate_version is null
    or p_expected_mapping_version is null
    or p_expected_candidate_version < 1
    or p_expected_mapping_version < 1
    or p_decision is null
    or p_decision not in ('approve', 'reject')
  then
    raise exception using errcode = '22023', message = 'invalid package source review';
  end if;

  select candidate.*
  into current_candidate
  from package_source_candidates as candidate
  where candidate.id = p_candidate_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package source candidate not found';
  end if;

  select mapping.*
  into current_mapping
  from package_source_mappings as mapping
  where mapping.id = current_candidate.mapping_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package source mapping not found';
  end if;

  select control.*
  into current_control
  from package_source_mapping_controls as control
  where control.mapping_id = current_mapping.id
  for update;
  if not found or current_control.disabled then
    raise exception using errcode = '23514', message = 'package source mapping is disabled';
  end if;

  if current_candidate.version <> p_expected_candidate_version
    or current_mapping.version <> p_expected_mapping_version
  then
    raise exception using errcode = '40001', message = 'package source review version changed';
  end if;
  if current_candidate.review_state <> 'pending_review' then
    raise exception using errcode = '23514', message = 'package source candidate already reviewed';
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
      'package_registry_release',
      'sdk_repository_release',
      'changelog',
      'release_feed',
      'migration_guide'
    ) then
      raise exception using errcode = '23514', message = 'package source kind cannot be promoted';
    end if;
    if p_catalog_mode not in ('existing_product', 'existing_vendor', 'new_vendor')
      or p_approve_candidate_domain is null
      or p_poll_interval_seconds is null
      or p_poll_interval_seconds not between 3600 and 2592000
      or p_rejection_reason_code is not null
    then
      raise exception using errcode = '22023', message = 'invalid package source approval';
    end if;

    if p_catalog_mode = 'existing_product' then
      if p_existing_api_product_id is null
        or p_existing_vendor_id is not null
        or p_vendor_slug is not null
        or p_vendor_name is not null
        or p_official_domains is not null
      then
        raise exception using errcode = '22023', message = 'invalid existing product binding';
      end if;
      select product.*
      into current_product
      from api_products as product
      where product.id = p_existing_api_product_id
      for update;
      if not found
        or current_product.ecosystem <> 'npm'
        or current_product.canonical_identifier <> current_mapping.package_name
        or current_product.status <> 'active'
      then
        raise exception using errcode = '23514', message = 'existing product binding conflicts with catalog';
      end if;
      select vendor.*
      into current_vendor
      from vendors as vendor
      where vendor.id = current_product.vendor_id
      for update;
      if not found or current_vendor.synthetic or current_vendor.trust_state = 'disabled' then
        raise exception using errcode = '23514', message = 'existing product vendor conflicts with catalog';
      end if;
    elsif p_catalog_mode = 'existing_vendor' then
      if p_existing_vendor_id is null
        or p_existing_api_product_id is not null
        or p_vendor_slug is not null
        or p_vendor_name is not null
        or p_official_domains is not null
      then
        raise exception using errcode = '22023', message = 'invalid existing vendor binding';
      end if;
      select vendor.*
      into current_vendor
      from vendors as vendor
      where vendor.id = p_existing_vendor_id
      for update;
      if not found or current_vendor.synthetic or current_vendor.trust_state = 'disabled' then
        raise exception using errcode = '23514', message = 'existing vendor binding conflicts with catalog';
      end if;
    else
      if p_existing_api_product_id is not null
        or p_existing_vendor_id is not null
        or p_vendor_slug is null
        or p_vendor_slug !~ '^[a-z][a-z0-9-]{1,62}$'
        or p_vendor_name is null
        or length(trim(p_vendor_name)) not between 1 and 120
        or p_vendor_name <> trim(p_vendor_name)
        or p_official_domains is null
        or cardinality(p_official_domains) not between 1 and 20
        or exists (
          select 1 from unnest(p_official_domains) as domain(value)
          where domain.value is null
            or domain.value <> lower(domain.value)
            or position('.' in domain.value) = 0
            or domain.value ~ '^\d+\.\d+\.\d+\.\d+$'
            or domain.value !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$'
        )
      then
        raise exception using errcode = '22023', message = 'invalid new vendor binding';
      end if;
      if exists (select 1 from vendors where slug = p_vendor_slug) then
        raise exception using errcode = '23514', message = 'vendor already exists';
      end if;
      insert into vendors (
        slug,
        name,
        official_domains,
        trust_state,
        synthetic,
        created_at,
        updated_at
      ) values (
        p_vendor_slug,
        p_vendor_name,
        array(
          select distinct approved_domain.value
          from unnest(p_official_domains) as approved_domain(value)
        ),
        'trusted',
        false,
        reviewed_at_value,
        reviewed_at_value
      )
      returning * into current_vendor;
    end if;

    if p_catalog_mode <> 'existing_product' then
      select product.*
      into current_product
      from api_products as product
      where product.ecosystem = 'npm'
        and product.canonical_identifier = current_mapping.package_name
      for update;
    end if;
    if current_product.id is null then
      insert into api_products (
        vendor_id,
        ecosystem,
        canonical_identifier,
        status,
        created_at,
        updated_at
      ) values (
        current_vendor.id,
        'npm',
        current_mapping.package_name,
        'active',
        reviewed_at_value,
        reviewed_at_value
      )
      returning * into current_product;
    elsif current_product.vendor_id <> current_vendor.id
      or current_product.status <> 'active'
    then
      raise exception using errcode = '23514', message = 'package identity conflicts with catalog';
    end if;

    if current_candidate.source_kind = 'package_registry_release' then
      if current_candidate.canonical_domain <> 'registry.npmjs.org'
        or p_approve_candidate_domain
      then
        raise exception using errcode = '23514', message = 'invalid package registry domain approval';
      end if;
    elsif not current_candidate.canonical_domain = any(current_vendor.official_domains) then
      if not p_approve_candidate_domain then
        raise exception using errcode = '23514', message = 'candidate domain is not approved';
      end if;
      if cardinality(current_vendor.official_domains) >= 20 then
        raise exception using errcode = '23514', message = 'vendor domain limit reached';
      end if;
      update vendors as vendor
      set official_domains = array_append(
            vendor.official_domains,
            current_candidate.canonical_domain
          ),
          updated_at = reviewed_at_value
      where vendor.id = current_vendor.id
      returning * into current_vendor;
      domain_added := true;
    end if;

    if current_vendor.trust_state = 'draft' then
      update vendors as vendor
      set trust_state = 'trusted', updated_at = reviewed_at_value
      where vendor.id = current_vendor.id
      returning * into current_vendor;
    end if;

    if current_mapping.api_product_id is not null
      and current_mapping.api_product_id <> current_product.id
    then
      raise exception using errcode = '23514', message = 'package mapping conflicts with catalog';
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

    select source.*
    into current_source
    from vendor_sources as source
    where source.api_product_id = current_product.id
      and source.source_key = source_key_value
    for update;
    if not found then
      if exists (
        select 1
        from vendor_sources as source
        where source.api_product_id = current_product.id
          and source.canonical_url = current_candidate.canonical_url
      ) then
        raise exception using errcode = '23514', message = 'package source conflicts with catalog';
      end if;
      insert into vendor_sources (
        api_product_id,
        source_key,
        source_kind,
        canonical_url,
        canonical_domain,
        expected_media_types,
        trust_state,
        poll_interval_seconds,
        created_at,
        updated_at
      ) values (
        current_product.id,
        source_key_value,
        current_candidate.source_kind,
        current_candidate.canonical_url,
        current_candidate.canonical_domain,
        expected_media_types_value,
        'trusted',
        p_poll_interval_seconds,
        reviewed_at_value,
        reviewed_at_value
      )
      returning * into current_source;
    elsif current_source.source_kind <> current_candidate.source_kind
      or current_source.canonical_url <> current_candidate.canonical_url
      or current_source.canonical_domain <> current_candidate.canonical_domain
    then
      raise exception using errcode = '23514', message = 'package source conflicts with catalog';
    else
      update vendor_sources as source
      set trust_state = 'trusted',
          poll_interval_seconds = p_poll_interval_seconds,
          expected_media_types = expected_media_types_value,
          updated_at = reviewed_at_value
      where source.id = current_source.id;
    end if;

    update package_source_candidates as candidate
    set review_state = 'approved',
        reviewed_by_user_id = p_operator_user_id,
        reviewed_at = reviewed_at_value,
        rejection_reason_code = null,
        version = candidate.version + 1
    where candidate.id = current_candidate.id;

    update package_source_mappings as mapping
    set status = 'mapped',
        api_product_id = current_product.id,
        safe_error_code = null,
        updated_at = reviewed_at_value,
        version = mapping.version + 1
    where mapping.id = current_mapping.id;
  else
    if p_catalog_mode is not null
      or p_existing_api_product_id is not null
      or p_existing_vendor_id is not null
      or p_vendor_slug is not null
      or p_vendor_name is not null
      or p_official_domains is not null
      or p_approve_candidate_domain is not null
      or p_poll_interval_seconds is not null
      or p_rejection_reason_code is null
      or p_rejection_reason_code not in (
        'NOT_OFFICIAL',
        'DUPLICATE',
        'UNSUPPORTED_SOURCE'
      )
    then
      raise exception using errcode = '22023', message = 'invalid package source rejection';
    end if;

    update package_source_candidates as candidate
    set review_state = 'rejected',
        reviewed_by_user_id = p_operator_user_id,
        reviewed_at = reviewed_at_value,
        rejection_reason_code = p_rejection_reason_code,
        version = candidate.version + 1
    where candidate.id = current_candidate.id;

    update package_source_mappings as mapping
    set status = case
          when mapping.api_product_id is not null then 'mapped'
          when exists (
            select 1
            from package_source_candidates as candidate
            where candidate.mapping_id = mapping.id
              and candidate.id <> current_candidate.id
              and candidate.review_state = 'pending_review'
          ) then 'needs_review'
          else 'rejected'
        end,
        updated_at = reviewed_at_value,
        version = mapping.version + 1
    where mapping.id = current_mapping.id;
  end if;

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
    'package_source_candidate.' || case p_decision
      when 'approve' then 'approved'
      else 'rejected'
    end,
    'package_source_candidate',
    current_candidate.id,
    p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'source_kind', current_candidate.source_kind,
      'decision', p_decision,
      'catalog_mode', p_catalog_mode,
      'vendor_id', current_vendor.id,
      'api_product_id', current_product.id,
      'candidate_domain_added', domain_added
    ),
    reviewed_at_value
  );

  return current_mapping.id;
end;
$$;

create function replace_package_source_candidate(
  p_candidate_id uuid,
  p_operator_user_id uuid,
  p_expected_candidate_version integer,
  p_expected_mapping_version integer,
  p_source_kind text,
  p_canonical_url text,
  p_canonical_domain text,
  p_proposal_note text,
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
  replacement_id uuid := gen_random_uuid();
  reviewed_at_value timestamptz := clock_timestamp();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator authorization required';
  end if;
  if p_request_id is null
    or p_expected_candidate_version is null
    or p_expected_mapping_version is null
    or p_source_kind not in (
      'sdk_repository_release', 'changelog', 'release_feed', 'migration_guide'
    )
    or p_canonical_url is null
    or length(p_canonical_url) not between 9 and 2048
    or p_canonical_url not like 'https://%'
    or p_canonical_domain is null
    or p_canonical_domain <> lower(p_canonical_domain)
    or position('.' in p_canonical_domain) = 0
    or p_canonical_domain ~ '^\d+\.\d+\.\d+\.\d+$'
    or p_canonical_domain !~ '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$'
    or split_part(split_part(p_canonical_url, '://', 2), '/', 1) <> p_canonical_domain
    or p_proposal_note is null
    or length(trim(p_proposal_note)) not between 1 and 500
    or p_proposal_note <> trim(p_proposal_note)
  then
    raise exception using errcode = '22023', message = 'invalid package source replacement';
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
  if not found then
    raise exception using errcode = 'P0002', message = 'package source mapping not found';
  end if;

  select control.* into current_control
  from package_source_mapping_controls as control
  where control.mapping_id = current_mapping.id
  for update;
  if not found or current_control.disabled then
    raise exception using errcode = '23514', message = 'package source mapping is disabled';
  end if;

  if current_candidate.version <> p_expected_candidate_version
    or current_mapping.version <> p_expected_mapping_version
  then
    raise exception using errcode = '40001', message = 'package source replacement version changed';
  end if;
  if current_candidate.review_state <> 'pending_review' then
    raise exception using errcode = '23514', message = 'only pending candidates can be replaced';
  end if;
  if exists (
    select 1 from package_source_candidates as candidate
    where candidate.mapping_id = current_mapping.id
      and candidate.source_kind = p_source_kind
      and candidate.canonical_url = p_canonical_url
  ) then
    raise exception using errcode = '23514', message = 'replacement candidate already exists';
  end if;

  update package_source_candidates as candidate
  set review_state = 'rejected',
      reviewed_by_user_id = p_operator_user_id,
      reviewed_at = reviewed_at_value,
      rejection_reason_code = 'REPLACED',
      version = candidate.version + 1
  where candidate.id = current_candidate.id;

  insert into package_source_candidates (
    id, mapping_id, resolution_run_id, source_kind, canonical_url,
    canonical_domain, evidence_digest, review_state, discovery_method,
    proposal_reason_code, proposal_note, supersedes_candidate_id,
    proposed_by_user_id, created_at
  ) values (
    replacement_id, current_mapping.id, current_candidate.resolution_run_id,
    p_source_kind, p_canonical_url, p_canonical_domain,
    current_candidate.evidence_digest, 'pending_review', 'operator_replacement',
    'OPERATOR_REPLACEMENT', p_proposal_note, current_candidate.id,
    p_operator_user_id, reviewed_at_value
  );

  update package_source_mappings as mapping
  set status = case when mapping.api_product_id is null then 'needs_review' else 'mapped' end,
      updated_at = reviewed_at_value,
      version = mapping.version + 1
  where mapping.id = current_mapping.id;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id, 'package_source_candidate.replaced',
    'package_source_candidate', replacement_id, p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'supersedes_candidate_id', current_candidate.id,
      'source_kind', p_source_kind,
      'canonical_domain', p_canonical_domain
    ),
    reviewed_at_value
  );

  return replacement_id;
end;
$$;

create function set_package_source_mapping_enabled(
  p_mapping_id uuid,
  p_operator_user_id uuid,
  p_expected_mapping_version integer,
  p_enabled boolean,
  p_disabled_reason_code text,
  p_request_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  current_mapping package_source_mappings%rowtype;
  current_control package_source_mapping_controls%rowtype;
  changed_at_value timestamptz := clock_timestamp();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator authorization required';
  end if;
  if p_request_id is null
    or p_expected_mapping_version is null
    or p_enabled is null
    or (
      not p_enabled
      and (
        p_disabled_reason_code is null
        or p_disabled_reason_code not in (
          'OPERATOR_DISABLED', 'PACKAGE_UNSUPPORTED', 'SECURITY_CONCERN'
        )
      )
    )
    or (p_enabled and p_disabled_reason_code is not null)
  then
    raise exception using errcode = '22023', message = 'invalid package source mapping state change';
  end if;

  select mapping.* into current_mapping
  from package_source_mappings as mapping
  where mapping.id = p_mapping_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'package source mapping not found';
  end if;
  if current_mapping.version <> p_expected_mapping_version then
    raise exception using errcode = '40001', message = 'package source mapping version changed';
  end if;

  select control.* into current_control
  from package_source_mapping_controls as control
  where control.mapping_id = current_mapping.id
  for update;
  if not found or current_control.disabled = (not p_enabled) then
    raise exception using errcode = '23514', message = 'package source mapping state is unchanged';
  end if;

  update package_source_mapping_controls
  set disabled = not p_enabled,
      disabled_reason_code = case when p_enabled then null else p_disabled_reason_code end,
      disabled_by_user_id = case when p_enabled then null else p_operator_user_id end,
      disabled_at = case when p_enabled then null else changed_at_value end,
      updated_at = changed_at_value
  where mapping_id = current_mapping.id;

  if p_enabled then
    update vendor_sources as source
    set trust_state = disabled_source.previous_trust_state,
        updated_at = changed_at_value
    from package_source_mapping_disabled_sources as disabled_source
    where disabled_source.mapping_id = current_mapping.id
      and source.id = disabled_source.source_id
      and source.trust_state = 'disabled'
      and source.updated_at = disabled_source.disabled_at;
    delete from package_source_mapping_disabled_sources
    where mapping_id = current_mapping.id;
  elsif current_mapping.api_product_id is not null then
    insert into package_source_mapping_disabled_sources (
      mapping_id, source_id, previous_trust_state, disabled_at
    )
    select current_mapping.id, source.id, source.trust_state, changed_at_value
    from vendor_sources as source
    where source.api_product_id = current_mapping.api_product_id
      and source.trust_state in ('draft', 'trusted')
    on conflict (mapping_id, source_id) do nothing;

    update vendor_sources as source
    set trust_state = 'disabled', updated_at = changed_at_value
    where source.api_product_id = current_mapping.api_product_id
      and source.trust_state <> 'disabled';
  end if;

  update package_source_mappings as mapping
  set updated_at = changed_at_value,
      version = mapping.version + 1
  where mapping.id = current_mapping.id;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id,
    case when p_enabled then 'package_source_mapping.enabled' else 'package_source_mapping.disabled' end,
    'package_source_mapping', current_mapping.id, p_request_id,
    jsonb_build_object('disabled_reason_code', p_disabled_reason_code),
    changed_at_value
  );

  return current_mapping.id;
end;
$$;

revoke all on function review_package_source_candidate(
  uuid, uuid, integer, integer, text, text, uuid, uuid, text, text,
  text[], boolean, integer, text, uuid
) from public, anon, authenticated;
grant execute on function review_package_source_candidate(
  uuid, uuid, integer, integer, text, text, uuid, uuid, text, text,
  text[], boolean, integer, text, uuid
) to app_runtime;
revoke all on function replace_package_source_candidate(
  uuid, uuid, integer, integer, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function replace_package_source_candidate(
  uuid, uuid, integer, integer, text, text, text, text, uuid
) to app_runtime;
revoke all on function set_package_source_mapping_enabled(
  uuid, uuid, integer, boolean, text, uuid
) from public, anon, authenticated;
grant execute on function set_package_source_mapping_enabled(
  uuid, uuid, integer, boolean, text, uuid
) to app_runtime;

commit;
