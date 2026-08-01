begin;

revoke execute on function fail_npm_package_source_poll(uuid, uuid, uuid, text, boolean)
  from app_runtime;
revoke execute on function complete_npm_package_source_poll(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, text
) from app_runtime;
revoke execute on function claim_due_npm_package_sources(uuid, uuid, integer, integer)
  from app_runtime;

drop function fail_npm_package_source_poll(uuid, uuid, uuid, text, boolean);
drop function complete_npm_package_source_poll(
  uuid, uuid, uuid, text, text, text, text, text, timestamptz, boolean, text
);
drop function claim_due_npm_package_sources(uuid, uuid, integer, integer);

drop table package_version_deprecation_states;
drop table package_release_detections;
drop table package_source_poll_runs;
drop table package_source_poll_states;

commit;
