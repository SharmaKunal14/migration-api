begin;

drop trigger if exists migration_approval_revocations_immutable
  on migration_approval_revocations;
drop trigger if exists migration_approvals_immutable on migration_approvals;
drop function if exists reject_immutable_stage4_record_change();

drop table if exists migration_run_outbox;
drop table if exists migration_runs;
drop table if exists migration_approval_revocations;
drop table if exists migration_approvals;

alter table impact_reports
  drop constraint if exists impact_reports_stage4_approval_identity_unique;

alter table migration_specifications
  drop constraint if exists migration_specifications_stage4_approval_identity_unique;

alter table repository_snapshots
  drop constraint if exists repository_snapshots_stage4_repository_organisation_fk;

alter table repository_snapshots
  drop constraint if exists repository_snapshots_stage4_approval_identity_unique;

alter table migration_candidates
  drop constraint if exists migration_candidates_stage4_approval_identity_unique;

alter table migration_candidates
  drop constraint if exists migration_candidates_stage4_run_identity_unique;

alter table repositories
  drop constraint if exists repositories_stage4_installation_organisation_fk;

alter table repositories
  drop constraint if exists repositories_stage4_approval_identity_unique;

alter table github_installations
  drop constraint if exists github_installations_stage4_organisation_identity_unique;

commit;
