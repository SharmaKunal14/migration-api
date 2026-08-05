begin;

-- The Stage 8F vendor fetcher joins a registered vendor release to the
-- detection that contains its immutable registry evidence. Stage 8D revoked
-- app_runtime access to this table and exposed polling only through bounded
-- functions, so the later join needs an explicit, column-scoped read grant.
grant select (
  vendor_release_id,
  source_id,
  evidence_object_key,
  evidence_digest
) on package_release_detections to app_runtime;

commit;
