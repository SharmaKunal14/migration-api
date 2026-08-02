begin;

alter table vendor_releases
  add column source_compatibility text
  check (
    source_compatibility is null
    or length(source_compatibility) between 1 and 100
  );

-- Preserve the compatibility route for the existing synthetic release. New
-- releases remain ineligible for analysis until trusted ingestion records an
-- explicit compatibility range.
update vendor_releases
set source_compatibility = '1.x'
where id = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';

commit;
