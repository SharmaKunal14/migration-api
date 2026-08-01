begin;

revoke execute on function review_exact_package_source_candidate(
  uuid, uuid, integer, integer, text, integer, text, uuid
) from app_runtime;
drop function review_exact_package_source_candidate(
  uuid, uuid, integer, integer, text, integer, text, uuid
);

commit;
