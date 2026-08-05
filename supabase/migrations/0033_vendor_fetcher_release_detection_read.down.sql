begin;

revoke select (
  vendor_release_id,
  source_id,
  evidence_object_key,
  evidence_digest
) on package_release_detections from app_runtime;

commit;
