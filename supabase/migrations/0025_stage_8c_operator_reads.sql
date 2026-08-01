begin;

-- The authenticated API uses app_runtime for both bounded mutations and reads.
-- These tables contain global package-source metadata; tenant repository details
-- remain behind the existing API authorization and are returned only as counts.
grant select on
  package_source_mappings,
  package_source_candidates,
  package_source_mapping_controls
to app_runtime;

commit;
