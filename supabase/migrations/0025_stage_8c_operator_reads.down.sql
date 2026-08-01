begin;

revoke select on
  package_source_mappings,
  package_source_candidates,
  package_source_mapping_controls
from app_runtime;

commit;
