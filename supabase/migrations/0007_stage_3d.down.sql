begin;

drop function if exists reconcile_migration_candidate(
  uuid, uuid, uuid, timestamptz
);
drop function if exists promote_migration_specification(
  uuid, uuid, integer, jsonb, timestamptz, uuid
);
drop function if exists is_platform_operator(uuid);

drop table if exists platform_audit_events;
drop table if exists platform_operators;

commit;
