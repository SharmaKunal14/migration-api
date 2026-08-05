begin;

revoke execute on function load_package_release_pilot_backfill_dispatch(
  uuid, uuid
) from app_runtime;
drop function load_package_release_pilot_backfill_dispatch(uuid, uuid);

commit;
