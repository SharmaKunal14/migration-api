begin;

drop table if exists dependency_observations;
drop table if exists repository_snapshots;
drop table if exists repository_scans;
drop table if exists github_webhook_deliveries;
drop table if exists repositories;
drop table if exists installation_link_states;
drop table if exists github_installations;

commit;
