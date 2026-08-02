begin;

alter table migration_specifications
  drop constraint if exists migration_specifications_reviewed_certainty_check;

drop trigger if exists package_release_detection_registration
  on package_release_detections;
drop function if exists register_detected_package_release();
drop table if exists release_intelligence_outbox;

-- Vendor releases registered from detections are retained as immutable audit
-- records. Rolling back orchestration must not delete evidence or reviewed work.
update package_release_detections
set status = 'detected'
where status = 'suppressed';

alter table package_release_detections
  drop constraint package_release_detections_status_check,
  drop column vendor_release_id,
  drop column source_version,
  add constraint package_release_detections_status_check check (
    status in ('detected', 'superseded')
  );

commit;
