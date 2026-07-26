begin;

drop function if exists create_change_intelligence_draft(
  uuid, uuid, text, text, jsonb, text, text, integer, timestamptz
);

drop table if exists change_intelligence_runs;

commit;
