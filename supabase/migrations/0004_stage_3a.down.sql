begin;

drop table if exists impact_reports;
drop table if exists migration_candidates;

alter table dependency_observations
  drop constraint if exists dependency_observations_id_organisation_unique;

alter table repository_snapshots
  drop constraint if exists repository_snapshots_id_repository_unique;

alter table repositories
  drop constraint if exists repositories_id_organisation_unique;

drop table if exists migration_specifications;
drop table if exists vendor_releases;
drop table if exists vendor_sources;
drop table if exists api_products;
drop table if exists vendors;

commit;
