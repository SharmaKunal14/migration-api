begin;

revoke execute on function fail_npm_package_source_resolution(uuid, uuid, uuid, text)
  from app_runtime;
revoke execute on function complete_npm_package_source_resolution(uuid, uuid, uuid, text, text, text, boolean, text, jsonb)
  from app_runtime;
revoke execute on function claim_npm_package_source_mappings(uuid, uuid, integer, integer)
  from app_runtime;

drop function fail_npm_package_source_resolution(uuid, uuid, uuid, text);
drop function complete_npm_package_source_resolution(uuid, uuid, uuid, text, text, text, boolean, text, jsonb);
drop function claim_npm_package_source_mappings(uuid, uuid, integer, integer);

drop table package_source_candidates;
drop table package_source_resolution_runs;

drop index package_source_mappings_pending_idx;

alter table package_source_mappings
  drop constraint package_source_mappings_review_evidence_check,
  drop constraint package_source_mappings_registry_metadata_check,
  drop constraint package_source_mappings_registry_etag_check,
  drop constraint package_source_mappings_lease_check,
  drop column resolved_at,
  drop column latest_deprecated,
  drop column latest_version,
  drop column registry_metadata_digest,
  drop column registry_metadata_object_key,
  drop column registry_etag,
  drop column lease_expires_at,
  drop column lease_owner;

create index package_source_mappings_pending_idx
  on package_source_mappings (status, last_checked_at, last_observed_at desc, id)
  where status in ('pending_registry_lookup', 'failed');

commit;
