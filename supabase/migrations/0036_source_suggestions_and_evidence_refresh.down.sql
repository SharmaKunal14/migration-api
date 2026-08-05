begin;

drop function if exists request_package_evidence_refresh(uuid, uuid, integer, uuid);
drop function if exists add_package_source_candidate(uuid, uuid, integer, text, text, text, text, uuid);
drop trigger if exists vendor_source_github_release_media_type on vendor_sources;
drop function if exists allow_github_release_page_media_type();
drop trigger if exists package_source_candidate_github_evidence_suggestions
  on package_source_candidates;
drop function if exists propose_github_package_evidence_candidates();

with recursive new_candidates as (
  select candidate.id
  from package_source_candidates as candidate
  where candidate.discovery_method = 'operator_addition'
    or candidate.proposal_reason_code in (
      'NPM_REPOSITORY_RELEASES_DERIVED',
      'NPM_REPOSITORY_CHANGELOG_DERIVED',
      'NPM_REPOSITORY_MIGRATION_DERIVED'
    )
  union
  select child.id
  from package_source_candidates as child
  inner join new_candidates as parent
    on child.supersedes_candidate_id = parent.id
)
delete from package_source_candidates
where id in (select id from new_candidates);

update package_source_mappings as mapping
set status = 'mapped', updated_at = now(), version = version + 1
where mapping.status = 'needs_review'
  and mapping.api_product_id is not null
  and not exists (
    select 1 from package_source_candidates as candidate
    where candidate.mapping_id = mapping.id
      and candidate.review_state = 'pending_review'
  );

alter table package_source_candidates
  drop constraint package_source_candidates_provenance_check,
  add constraint package_source_candidates_provenance_check check (
    (
      discovery_method = 'npm_registry_metadata'
      and supersedes_candidate_id is null
      and proposed_by_user_id is null
      and proposal_note is null
      and proposal_reason_code in (
        'NPM_REGISTRY_AUTHORITATIVE', 'NPM_REPOSITORY_DECLARATION',
        'NPM_HOMEPAGE_DECLARATION', 'NPM_BUGS_DECLARATION'
      )
    )
    or (
      discovery_method = 'operator_replacement'
      and supersedes_candidate_id is not null
      and proposed_by_user_id is not null
      and proposal_reason_code = 'OPERATOR_REPLACEMENT'
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
      when 'homepage' then 'NPM_HOMEPAGE_DECLARATION'
      when 'issue_tracker' then 'NPM_BUGS_DECLARATION'
      else null
    end;
  end if;
  return new;
end;
$$;

commit;
