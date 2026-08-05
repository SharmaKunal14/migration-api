begin;

revoke execute on function requeue_current_package_release_pilot_backfill(
  uuid, uuid, text, uuid
) from app_runtime;
drop function requeue_current_package_release_pilot_backfill(
  uuid, uuid, text, uuid
);

commit;
