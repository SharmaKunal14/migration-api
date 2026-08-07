begin;

create or replace function propose_github_package_evidence_candidates()
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

revoke all on function propose_github_package_evidence_candidates()
from public, anon, authenticated, app_runtime;

drop function request_package_evidence_refresh(uuid, uuid, integer, uuid);

alter function request_package_evidence_refresh_unfiltered(
  uuid, uuid, integer, uuid
) rename to request_package_evidence_refresh;

revoke all on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function request_package_evidence_refresh(
  uuid, uuid, integer, uuid
) to app_runtime;

commit;
