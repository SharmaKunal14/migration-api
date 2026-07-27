begin;

alter table migration_artifacts
  drop constraint migration_artifacts_object_key_check;

alter table migration_artifacts
  add constraint migration_artifacts_object_key_check check (
    length(object_key) between 1 and 1024
    and object_key !~ '^/'
    and object_key !~ '//'
    and object_key !~ '(^|/)\.\.?(/|$)'
    and object_key !~ '\\'
    and object_key !~ '[[:cntrl:]]'
    and object_key ~ (
      '^env/[a-z][a-z0-9-]{1,31}/org/'
      || organisation_id::text
      || '/run/'
      || migration_run_id::text
      || '/(input|agent|patch)/[A-Za-z0-9._/-]{1,512}$'
    )
  );

commit;
