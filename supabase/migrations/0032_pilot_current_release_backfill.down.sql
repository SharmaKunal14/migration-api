begin;

revoke execute on function request_current_package_release_pilot_backfill(
  uuid, uuid, integer, uuid
) from app_runtime;
drop function request_current_package_release_pilot_backfill(
  uuid, uuid, integer, uuid
);

commit;
