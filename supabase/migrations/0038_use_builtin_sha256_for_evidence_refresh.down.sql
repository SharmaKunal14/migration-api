begin;

-- Deliberately retain the built-in SHA-256 implementation: restoring the
-- extension-dependent digest call would recreate the production outage. This
-- rollback restores only the pre-0038 function search path from migration 0037.
alter function request_package_evidence_refresh(uuid, uuid, integer, uuid)
  set search_path = extensions, public, pg_temp;

commit;
