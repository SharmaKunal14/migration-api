begin;

drop trigger if exists migration_agent_checkpoints_immutable
  on migration_agent_checkpoints;
drop trigger if exists patch_attempts_immutable on patch_attempts;
drop trigger if exists migration_plans_immutable on migration_plans;
drop trigger if exists migration_artifacts_immutable on migration_artifacts;

drop table if exists migration_agent_checkpoints;
drop table if exists patch_attempts;
drop table if exists migration_plans;
drop table if exists migration_artifacts;

alter table migration_runs
  drop constraint if exists migration_runs_patch_binding_unique;

drop function if exists reject_immutable_stage5_record_change();

commit;
