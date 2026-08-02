begin;

do $$
begin
  if exists (select 1 from notification_recipient_states)
    or exists (select 1 from organisation_notifications)
  then
    raise exception using
      errcode = '2BP01',
      message = 'stage 8g notification audit data must be retained';
  end if;
end;
$$;

drop function if exists update_notification_recipient_state(
  uuid, uuid, uuid, text, uuid
);
drop trigger if exists migration_candidate_notification_provisioning
  on migration_candidates;
drop function if exists provision_migration_candidate_notification_trigger();
drop function if exists provision_migration_candidate_notification(uuid);
drop table if exists notification_recipient_states;
drop table if exists organisation_notifications;

alter table migration_candidates
  drop constraint if exists migration_candidates_id_organisation_unique;

commit;
