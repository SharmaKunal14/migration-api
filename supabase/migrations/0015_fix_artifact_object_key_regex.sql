begin;

do $$
declare
  constraint_name text;
  constraint_count integer;
begin
  select min(constraint_definition.conname), count(*)
  into constraint_name, constraint_count
  from pg_constraint as constraint_definition
  where constraint_definition.conrelid = 'migration_artifacts'::regclass
    and constraint_definition.contype = 'c'
    and position(
      'object_key'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0
    and position(
      '{1,512}'
      in pg_get_constraintdef(constraint_definition.oid)
    ) > 0;

  if constraint_count <> 1 then
    raise exception
      'Expected exactly one migration artifact object key constraint, found %',
      constraint_count;
  end if;

  execute format(
    'alter table migration_artifacts drop constraint %I',
    constraint_name
  );
end
$$;

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
      || '/(input|agent|patch)/[A-Za-z0-9._/-]+$'
    )
  );

commit;
