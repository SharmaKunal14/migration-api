begin;

drop table if exists audit_events;
drop table if exists api_idempotency_keys;
drop table if exists workflow_outbox;
alter table if exists agent_runs drop constraint if exists agent_runs_result_artifact_fk;
drop table if exists artifacts;
drop table if exists agent_actions;
drop table if exists agent_runs;
drop table if exists organisation_memberships;
drop table if exists organisations;
drop table if exists app_users;

commit;

