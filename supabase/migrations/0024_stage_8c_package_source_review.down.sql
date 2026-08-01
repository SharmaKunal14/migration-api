begin;

revoke execute on function set_package_source_mapping_enabled(
  uuid, uuid, integer, boolean, text, uuid
) from app_runtime;
drop function set_package_source_mapping_enabled(
  uuid, uuid, integer, boolean, text, uuid
);

revoke execute on function replace_package_source_candidate(
  uuid, uuid, integer, integer, text, text, text, text, uuid
) from app_runtime;
drop function replace_package_source_candidate(
  uuid, uuid, integer, integer, text, text, text, text, uuid
);

revoke execute on function review_package_source_candidate(
  uuid, uuid, integer, integer, text, text, uuid, uuid, text, text,
  text[], boolean, integer, text, uuid
) from app_runtime;
drop function review_package_source_candidate(
  uuid, uuid, integer, integer, text, text, uuid, uuid, text, text,
  text[], boolean, integer, text, uuid
);

drop trigger package_source_mapping_control_insert on package_source_mappings;
drop function initialize_package_source_mapping_control();
update vendor_sources as source
set trust_state = disabled_source.previous_trust_state,
    updated_at = now()
from package_source_mapping_disabled_sources as disabled_source
where source.id = disabled_source.source_id
  and source.trust_state = 'disabled'
  and source.updated_at = disabled_source.disabled_at;
drop table package_source_mapping_disabled_sources;
drop table package_source_mapping_controls;

drop trigger package_source_candidate_provenance_insert on package_source_candidates;
drop function assign_npm_package_source_candidate_provenance();

alter table vendor_sources
  drop constraint vendor_sources_source_kind_check,
  add constraint vendor_sources_source_kind_check check (
    source_kind in (
      'package_registry_release',
      'migration_guide',
      'changelog',
      'api_definition',
      'sdk_repository_release'
    )
  );

alter table package_source_candidates
  drop constraint package_source_candidates_review_check,
  drop constraint package_source_candidates_provenance_check,
  drop constraint package_source_candidates_source_kind_check,
  add constraint package_source_candidates_source_kind_check check (
    source_kind in (
      'package_registry_release',
      'sdk_repository_release',
      'homepage',
      'issue_tracker'
    )
  ),
  drop column rejection_reason_code,
  drop column proposed_by_user_id,
  drop column supersedes_candidate_id,
  drop column proposal_note,
  drop column proposal_reason_code,
  drop column discovery_method,
  drop column version,
  add constraint package_source_candidates_check check (
    (review_state = 'pending_review' and reviewed_by_user_id is null and reviewed_at is null)
    or (review_state in ('approved', 'rejected') and reviewed_by_user_id is not null and reviewed_at is not null)
  );

commit;
