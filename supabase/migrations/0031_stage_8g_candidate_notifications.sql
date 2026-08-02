begin;

alter table migration_candidates
  add constraint migration_candidates_id_organisation_unique
  unique (id, organisation_id);

create table organisation_notifications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  event_type text not null check (event_type = 'migration_candidate_ready'),
  repository_id uuid not null,
  candidate_id uuid not null,
  migration_specification_id uuid not null
    references migration_specifications(id) on delete restrict,
  vendor_release_id uuid not null references vendor_releases(id) on delete restrict,
  title text not null check (
    length(title) between 1 and 160 and title !~ '[<>]'
  ),
  safe_summary text not null check (
    length(safe_summary) between 1 and 500 and safe_summary !~ '[<>]'
  ),
  idempotency_key text not null unique check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'
  ),
  created_at timestamptz not null default now(),
  foreign key (repository_id, organisation_id)
    references repositories(id, organisation_id) on delete cascade,
  foreign key (candidate_id, organisation_id)
    references migration_candidates(id, organisation_id) on delete cascade,
  unique (candidate_id, event_type)
);

create index organisation_notifications_inbox_idx
  on organisation_notifications (organisation_id, created_at desc);

create table notification_recipient_states (
  notification_id uuid not null
    references organisation_notifications(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete restrict,
  channel text not null default 'in_app' check (channel = 'in_app'),
  delivered_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (notification_id, user_id),
  check (read_at is null or read_at >= delivered_at),
  check (dismissed_at is null or dismissed_at >= delivered_at),
  check (dismissed_at is null or read_at is not null)
);

create index notification_recipient_states_user_inbox_idx
  on notification_recipient_states (user_id, delivered_at desc);

revoke all on organisation_notifications, notification_recipient_states
  from public, anon, authenticated, app_runtime;
grant select on organisation_notifications, notification_recipient_states
  to app_runtime, app_readonly;

create function provision_migration_candidate_notification(p_candidate_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  eligible_candidate record;
  notification_id_value uuid;
begin
  select
    candidate.organisation_id,
    candidate.repository_id,
    candidate.migration_specification_id,
    specification.vendor_release_id
  into eligible_candidate
  from migration_candidates as candidate
  inner join organisations as organisation
    on organisation.id = candidate.organisation_id
  inner join repositories as repository
    on repository.id = candidate.repository_id
    and repository.organisation_id = candidate.organisation_id
  inner join github_installations as installation
    on installation.id = repository.installation_id
  inner join dependency_observations as observation
    on observation.id = candidate.dependency_observation_id
    and observation.organisation_id = candidate.organisation_id
  inner join repository_snapshots as snapshot
    on snapshot.id = observation.repository_snapshot_id
    and snapshot.repository_id = candidate.repository_id
  inner join migration_specifications as specification
    on specification.id = candidate.migration_specification_id
  inner join vendor_releases as release
    on release.id = specification.vendor_release_id
  inner join api_products as product on product.id = release.api_product_id
  inner join vendors as vendor on vendor.id = product.vendor_id
  inner join package_source_mappings as mapping
    on mapping.ecosystem = product.ecosystem
    and mapping.package_name = product.canonical_identifier
    and mapping.api_product_id = product.id
  left join package_source_mapping_controls as mapping_control
    on mapping_control.mapping_id = mapping.id
  where candidate.id = p_candidate_id
    and candidate.status = 'open'
    and organisation.status = 'active'
    and repository.selected
    and repository.enabled
    and not repository.archived
    and installation.status = 'active'
    and snapshot.status = 'available'
    and snapshot.expires_at > now()
    and observation.package_name = product.canonical_identifier
    and specification.trust_state in ('reviewed', 'vendor_verified')
    and release.processing_state = 'validated'
    and release.trust_state in ('reviewed', 'vendor_verified')
    and product.status = 'active'
    and vendor.trust_state = 'trusted'
    and mapping.status = 'mapped'
    and not coalesce(mapping_control.disabled, false)
    and not exists (
      select 1
      from repository_snapshots as newer_snapshot
      where newer_snapshot.repository_id = snapshot.repository_id
        and newer_snapshot.status = 'available'
        and (newer_snapshot.updated_at, newer_snapshot.id)
          > (snapshot.updated_at, snapshot.id)
    )
    and exists (
      select 1
      from vendor_sources as source
      where source.api_product_id = product.id
        and source.source_kind = 'package_registry_release'
        and source.canonical_domain = 'registry.npmjs.org'
        and source.trust_state = 'trusted'
    );

  if not found then
    return null;
  end if;

  insert into organisation_notifications (
    organisation_id,
    event_type,
    repository_id,
    candidate_id,
    migration_specification_id,
    vendor_release_id,
    title,
    safe_summary,
    idempotency_key
  ) values (
    eligible_candidate.organisation_id,
    'migration_candidate_ready',
    eligible_candidate.repository_id,
    p_candidate_id,
    eligible_candidate.migration_specification_id,
    eligible_candidate.vendor_release_id,
    'Dependency update ready',
    'A trusted package release has reviewed migration guidance and matches this repository.',
    'migration-candidate-ready:' || p_candidate_id::text
  )
  on conflict (candidate_id, event_type) do update
    set candidate_id = excluded.candidate_id
  returning id into notification_id_value;

  insert into notification_recipient_states (
    notification_id,
    user_id,
    channel,
    delivered_at,
    created_at,
    updated_at
  )
  select
    notification_id_value,
    membership.user_id,
    'in_app',
    now(),
    now(),
    now()
  from organisation_memberships as membership
  where membership.organisation_id = eligible_candidate.organisation_id
    and membership.role in ('owner', 'admin', 'reviewer')
  on conflict (notification_id, user_id) do nothing;

  return notification_id_value;
end;
$$;

create function provision_migration_candidate_notification_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'open' then
    perform provision_migration_candidate_notification(new.id);
  end if;
  return new;
end;
$$;

create trigger migration_candidate_notification_provisioning
after insert or update on migration_candidates
for each row execute function provision_migration_candidate_notification_trigger();

create function update_notification_recipient_state(
  p_user_id uuid,
  p_organisation_id uuid,
  p_notification_id uuid,
  p_action text,
  p_request_id uuid
)
returns table (
  notification_id uuid,
  read_at timestamptz,
  dismissed_at timestamptz,
  version integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  state_changed boolean := false;
begin
  if p_action not in ('mark_read', 'dismiss') then
    raise exception using errcode = '22023', message = 'invalid notification action';
  end if;

  if not exists (
    select 1
    from organisation_memberships as membership
    inner join organisations as organisation
      on organisation.id = membership.organisation_id
    where membership.organisation_id = p_organisation_id
      and membership.user_id = p_user_id
      and membership.role in ('owner', 'admin', 'reviewer')
      and organisation.status = 'active'
  ) then
    raise exception using errcode = '42501', message = 'notification access denied';
  end if;

  perform 1
  from notification_recipient_states as recipient_state
  inner join organisation_notifications as notification
    on notification.id = recipient_state.notification_id
  where recipient_state.notification_id = p_notification_id
    and recipient_state.user_id = p_user_id
    and notification.organisation_id = p_organisation_id
  for update of recipient_state;

  if not found then
    raise exception using errcode = 'P0002', message = 'notification not found';
  end if;

  if p_action = 'mark_read' then
    update notification_recipient_states as recipient_state
    set
      read_at = now(),
      version = recipient_state.version + 1,
      updated_at = now()
    where recipient_state.notification_id = p_notification_id
      and recipient_state.user_id = p_user_id
      and recipient_state.read_at is null;
    state_changed := found;
  else
    update notification_recipient_states as recipient_state
    set
      read_at = coalesce(recipient_state.read_at, now()),
      dismissed_at = now(),
      version = recipient_state.version + 1,
      updated_at = now()
    where recipient_state.notification_id = p_notification_id
      and recipient_state.user_id = p_user_id
      and recipient_state.dismissed_at is null;
    state_changed := found;
  end if;

  if state_changed then
    insert into audit_events (
      organisation_id,
      actor_type,
      actor_id,
      action,
      resource_type,
      resource_id,
      request_id,
      metadata
    ) values (
      p_organisation_id,
      'user',
      p_user_id::text,
      case p_action
        when 'mark_read' then 'notification.read'
        else 'notification.dismissed'
      end,
      'organisation_notification',
      p_notification_id,
      p_request_id,
      jsonb_build_object('channel', 'in_app')
    );
  end if;

  return query
  select
    recipient_state.notification_id,
    recipient_state.read_at,
    recipient_state.dismissed_at,
    recipient_state.version
  from notification_recipient_states as recipient_state
  where recipient_state.notification_id = p_notification_id
    and recipient_state.user_id = p_user_id;
end;
$$;

revoke all on function provision_migration_candidate_notification(uuid)
  from public, anon, authenticated, app_runtime;
revoke all on function provision_migration_candidate_notification_trigger()
  from public, anon, authenticated, app_runtime;
revoke all on function update_notification_recipient_state(
  uuid, uuid, uuid, text, uuid
) from public, anon, authenticated, app_runtime;
grant execute on function update_notification_recipient_state(
  uuid, uuid, uuid, text, uuid
) to app_runtime;

-- Existing eligible candidates receive the same idempotent notification as a
-- newly reconciled candidate. Ineligible legacy fixtures are left untouched.
select provision_migration_candidate_notification(candidate.id)
from migration_candidates as candidate
where candidate.status = 'open';

commit;
