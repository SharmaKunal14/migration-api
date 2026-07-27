begin;

alter table migration_agent_checkpoints
  add constraint migration_agent_checkpoints_attempt_sequence_range_check
  check (
    sequence between ((attempt_number - 1) * 3 + 1) and (attempt_number * 3)
  );

commit;
