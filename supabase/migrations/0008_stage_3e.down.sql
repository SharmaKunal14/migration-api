begin;

alter table impact_analysis_runs
  drop constraint impact_analysis_runs_report_fk;

alter table impact_reports
  drop constraint impact_reports_impact_analysis_run_fk;

-- Stage 3E reports cannot reference the legacy Stage 1 agent_runs table.
-- Removing them is required before restoring the previous foreign key.
delete from impact_reports;

alter table impact_reports
  add constraint impact_reports_impact_agent_run_id_fkey
  foreign key (impact_agent_run_id) references agent_runs(id) on delete restrict;

drop table impact_analysis_runs;

commit;
