begin;

alter table vendor_releases drop column source_compatibility;

commit;
