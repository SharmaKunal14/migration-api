begin;

do $$
begin
  if exists (
    select 1 from impact_analysis_runs where model_calls > 4
  ) then
    raise exception
      'cannot restore the four-call limit while five-call impact runs exist';
  end if;
end;
$$;

alter table impact_analysis_runs
  drop constraint impact_analysis_runs_model_calls_check;

alter table impact_analysis_runs
  add constraint impact_analysis_runs_model_calls_check
  check (model_calls between 0 and 4);

commit;
