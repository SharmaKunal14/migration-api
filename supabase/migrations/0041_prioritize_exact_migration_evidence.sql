begin;

-- npm metadata proves which GitHub repository the publisher declared. It does
-- not prove that guessed files such as MIGRATION.md or CHANGELOG.md exist or
-- cover the requested version route. Exact migration guides, changelogs, and
-- target release pages must be added by an operator after opening and verifying
-- the publisher-owned page.
create or replace function propose_github_package_evidence_candidates()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return new;
end;
$$;

revoke all on function propose_github_package_evidence_candidates()
from public, anon, authenticated, app_runtime;

-- Preserve the existing transaction and audit implementation behind a narrow
-- gate. A newly approved repository root is useful for identity, but it must
-- not make a blocked migration eligible for regeneration because the fetcher
-- intentionally excludes repository roots from migration evidence.
alter function request_package_evidence_refresh(uuid, uuid, integer, uuid)
rename to request_package_evidence_refresh_unfiltered;

revoke all on function request_package_evidence_refresh_unfiltered(
  uuid, uuid, integer, uuid
) from public, anon, authenticated, app_runtime;

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
  ambiguous_release_id uuid;
begin
  if not is_platform_operator(p_operator_user_id) then
    raise exception using errcode = '42501', message = 'platform operator required';
  end if;

  select release.id into ambiguous_release_id
  from package_source_mappings as mapping
  join vendor_releases as release
    on release.api_product_id = mapping.api_product_id
  join migration_specifications as specification
    on specification.vendor_release_id = release.id
  where mapping.id = p_mapping_id
    and specification.trust_state = 'draft'
    and jsonb_path_exists(
      specification.specification,
      '$.changes[*] ? (@.certainty == "ambiguous")'
    )
  order by release.revision desc, specification.revision desc
  limit 1;

  if ambiguous_release_id is not null and not exists (
    select 1
    from package_source_mappings as mapping
    join vendor_sources as source
      on source.api_product_id = mapping.api_product_id
    where mapping.id = p_mapping_id
      and source.trust_state = 'trusted'
      and source.source_kind in (
        'migration_guide', 'changelog', 'release_feed', 'api_definition'
      )
      and not exists (
        select 1
        from vendor_evidence_items as item
        where item.vendor_release_id = ambiguous_release_id
          and item.vendor_source_id = source.id
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'no newly trusted migration evidence source is available';
  end if;

  return query
  select *
  from request_package_evidence_refresh_unfiltered(
    p_mapping_id,
    p_operator_user_id,
    p_expected_mapping_version,
    p_request_id
  );
end;
$$;

revoke all on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) to app_runtime;

commit;
