begin;

alter table package_source_candidates
  drop constraint package_source_candidates_provenance_check,
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
        'NPM_BUGS_DECLARATION',
        'NPM_REPOSITORY_RELEASES_DERIVED',
        'NPM_REPOSITORY_CHANGELOG_DERIVED',
        'NPM_REPOSITORY_MIGRATION_DERIVED'
      )
    )
    or (
      discovery_method = 'operator_replacement'
      and supersedes_candidate_id is not null
      and proposed_by_user_id is not null
      and proposal_reason_code = 'OPERATOR_REPLACEMENT'
    )
    or (
      discovery_method = 'operator_addition'
      and supersedes_candidate_id is null
      and proposed_by_user_id is not null
      and proposal_reason_code = 'OPERATOR_ADDITION'
    )
  );

create or replace function assign_npm_package_source_candidate_provenance()
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
      when 'changelog' then 'NPM_REPOSITORY_CHANGELOG_DERIVED'
      when 'release_feed' then 'NPM_REPOSITORY_RELEASES_DERIVED'
      when 'migration_guide' then 'NPM_REPOSITORY_MIGRATION_DERIVED'
      when 'homepage' then 'NPM_HOMEPAGE_DECLARATION'
      when 'issue_tracker' then 'NPM_BUGS_DECLARATION'
      else null
    end;
  end if;
  return new;
end;
$$;

create function propose_github_package_evidence_candidates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  repository_root text;
begin
  if new.source_kind <> 'sdk_repository_release'
    or new.discovery_method <> 'npm_registry_metadata'
    or new.canonical_domain <> 'github.com'
  then
    return new;
  end if;

  repository_root := regexp_replace(new.canonical_url, '/$', '');
  if repository_root !~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' then
    return new;
  end if;

  insert into package_source_candidates (
    mapping_id, resolution_run_id, source_kind, canonical_url,
    canonical_domain, evidence_digest, review_state, created_at
  ) values
    (
      new.mapping_id, new.resolution_run_id, 'release_feed',
      repository_root || '/releases', 'github.com', new.evidence_digest,
      'pending_review', new.created_at
    ),
    (
      new.mapping_id, new.resolution_run_id, 'changelog',
      repository_root || '/blob/HEAD/CHANGELOG.md', 'github.com',
      new.evidence_digest, 'pending_review', new.created_at
    ),
    (
      new.mapping_id, new.resolution_run_id, 'migration_guide',
      repository_root || '/blob/HEAD/MIGRATION.md', 'github.com',
      new.evidence_digest, 'pending_review', new.created_at
    )
  on conflict (mapping_id, source_kind, canonical_url) do nothing;
  return new;
end;
$$;

create trigger package_source_candidate_github_evidence_suggestions
after insert on package_source_candidates
for each row execute function propose_github_package_evidence_candidates();

-- Existing mappings were resolved before these bounded suggestions existed.
-- Backfill only exact GitHub repository roots; the resulting URLs remain
-- pending and are never fetched until an operator confirms the exact source.
insert into package_source_candidates (
  mapping_id, resolution_run_id, source_kind, canonical_url,
  canonical_domain, evidence_digest, review_state, created_at
)
select
  candidate.mapping_id, candidate.resolution_run_id, suggestion.source_kind,
  regexp_replace(candidate.canonical_url, '/$', '') || suggestion.path,
  'github.com', candidate.evidence_digest, 'pending_review', now()
from package_source_candidates as candidate
cross join (values
  ('release_feed', '/releases'),
  ('changelog', '/blob/HEAD/CHANGELOG.md'),
  ('migration_guide', '/blob/HEAD/MIGRATION.md')
) as suggestion(source_kind, path)
where candidate.source_kind = 'sdk_repository_release'
  and candidate.discovery_method = 'npm_registry_metadata'
  and candidate.canonical_domain = 'github.com'
  and candidate.canonical_url ~ '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
on conflict (mapping_id, source_kind, canonical_url) do nothing;

revoke all on function propose_github_package_evidence_candidates()
from public, anon, authenticated, app_runtime;

create function allow_github_release_page_media_type()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source_kind = 'release_feed'
    and new.canonical_domain = 'github.com'
    and not ('text/html' = any(new.expected_media_types))
  then
    new.expected_media_types := array_append(new.expected_media_types, 'text/html');
  end if;
  return new;
end;
$$;

create trigger vendor_source_github_release_media_type
before insert or update on vendor_sources
for each row execute function allow_github_release_page_media_type();

revoke all on function allow_github_release_page_media_type()
from public, anon, authenticated, app_runtime;

create function add_package_source_candidate(
  p_mapping_id uuid,
  p_operator_user_id uuid,
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
  current_mapping package_source_mappings%rowtype;
  current_control package_source_mapping_controls%rowtype;
  current_run package_source_resolution_runs%rowtype;
  candidate_id uuid := gen_random_uuid();
  created_at_value timestamptz := now();
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;
  if p_request_id is null
    or p_expected_mapping_version is null
    or p_expected_mapping_version < 1
    or p_source_kind not in (
      'sdk_repository_release', 'changelog', 'release_feed', 'migration_guide'
    )
    or p_canonical_url is null
    or length(p_canonical_url) not between 9 and 2048
    or p_canonical_url not like 'https://%'
    or p_canonical_domain is null
    or p_canonical_domain <> lower(p_canonical_domain)
    or position('.' in p_canonical_domain) = 0
    or p_proposal_note is null
    or length(trim(p_proposal_note)) not between 1 and 500
  then
    raise exception using errcode = '22023', message = 'invalid package source addition';
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
  if current_mapping.status <> 'mapped'
    or current_mapping.api_product_id is null
    or current_mapping.registry_metadata_digest is null
  then
    raise exception using errcode = '23514', message = 'package source mapping is not ready';
  end if;

  select resolution_run.* into current_run
  from package_source_resolution_runs as resolution_run
  where resolution_run.mapping_id = current_mapping.id
    and resolution_run.status = 'succeeded'
    and resolution_run.evidence_digest = current_mapping.registry_metadata_digest
  order by resolution_run.completed_at desc, resolution_run.id desc
  limit 1;
  if not found then
    raise exception using errcode = '23514', message = 'package source evidence unavailable';
  end if;

  insert into package_source_candidates (
    id, mapping_id, resolution_run_id, source_kind, canonical_url,
    canonical_domain, evidence_digest, review_state, discovery_method,
    proposal_reason_code, proposal_note, proposed_by_user_id, created_at
  ) values (
    candidate_id, current_mapping.id, current_run.id, p_source_kind,
    p_canonical_url, p_canonical_domain, current_mapping.registry_metadata_digest,
    'pending_review', 'operator_addition', 'OPERATOR_ADDITION',
    trim(p_proposal_note), p_operator_user_id, created_at_value
  );

  update package_source_mappings
  set status = 'needs_review', updated_at = created_at_value, version = version + 1
  where id = current_mapping.id;

  insert into platform_audit_events (
    actor_user_id, action, resource_type, resource_id, request_id, metadata, created_at
  ) values (
    p_operator_user_id, 'package_source_candidate.added',
    'package_source_candidate', candidate_id, p_request_id,
    jsonb_build_object(
      'mapping_id', current_mapping.id,
      'source_kind', p_source_kind,
      'canonical_domain', p_canonical_domain,
      'approval_scope', 'untrusted_candidate'
    ),
    created_at_value
  );
  return candidate_id;
end;
$$;

revoke all on function add_package_source_candidate(
  uuid, uuid, integer, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function add_package_source_candidate(
  uuid, uuid, integer, text, text, text, text, uuid
) to app_runtime;

create function request_package_evidence_refresh(
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
    digest(
      convert_to(
        string_agg(
          source.id::text || ':' || source.source_kind || ':' || source.canonical_url,
          E'\n' order by source.id
        ),
        'UTF8'
      ),
      'sha256'
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

revoke all on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) to app_runtime;

commit;
