begin;

alter table impact_analysis_runs
  drop constraint impact_analysis_runs_model_calls_check;

alter table impact_analysis_runs
  add constraint impact_analysis_runs_model_calls_check
  check (model_calls between 0 and 5);

commit;
