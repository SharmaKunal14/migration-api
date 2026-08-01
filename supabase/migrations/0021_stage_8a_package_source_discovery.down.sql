begin;

drop function if exists observe_npm_package_sources(text[], timestamptz);
drop table if exists package_source_mappings;

commit;
