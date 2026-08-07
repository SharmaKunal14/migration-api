begin;

-- Evidence refresh revisions locate the original fixed-origin npm detection by
-- its exact product, source version, and target version. Keep this read access
-- column-scoped rather than exposing the polling table to app_runtime.
grant select (
  api_product_id,
  version,
  source_version,
  latest_deprecated,
  status
) on package_release_detections to app_runtime;

commit;
