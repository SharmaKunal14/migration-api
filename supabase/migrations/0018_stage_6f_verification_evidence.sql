begin;

alter table verification_attempt_results
  add column commands jsonb not null default '[]'::jsonb,
  add constraint verification_attempt_results_commands_check check (
    jsonb_typeof(commands) = 'array'
    and jsonb_array_length(commands) <= 20
    and octet_length(commands::text) <= 65536
  );

commit;
