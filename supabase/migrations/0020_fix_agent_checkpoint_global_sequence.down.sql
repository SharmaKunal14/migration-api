begin;

alter table migration_agent_checkpoints
  drop constraint if exists
    migration_agent_checkpoints_attempt_sequence_range_check;

commit;
