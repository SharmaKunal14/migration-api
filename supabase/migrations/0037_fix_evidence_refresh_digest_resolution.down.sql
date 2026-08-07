begin;

alter function request_package_evidence_refresh(uuid, uuid, integer, uuid)
  set search_path = public, pg_temp;

commit;
