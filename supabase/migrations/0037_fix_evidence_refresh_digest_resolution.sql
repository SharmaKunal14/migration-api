begin;

-- Supabase installs pgcrypto in the trusted extensions schema. The evidence
-- refresh function previously searched only public and pg_temp, so its digest
-- call failed at runtime even though pgcrypto was installed.
alter function request_package_evidence_refresh(uuid, uuid, integer, uuid)
  set search_path = extensions, public, pg_temp;

commit;
