begin;

create unique index migration_runs_one_active_candidate_idx
  on migration_runs (organisation_id, candidate_id)
  where status in ('queued', 'running');

commit;
