begin;

revoke select (
  api_product_id,
  version,
  source_version,
  latest_deprecated,
  status
) on package_release_detections from app_runtime;

commit;
