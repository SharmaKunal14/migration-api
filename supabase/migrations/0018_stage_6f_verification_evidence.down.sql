begin;

alter table verification_attempt_results
  drop constraint if exists verification_attempt_results_commands_check,
  drop column if exists commands;

commit;
