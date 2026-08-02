begin;

alter table package_release_detections
  drop constraint package_release_detections_status_check;

alter table package_release_detections
  add column source_version text check (
    source_version is null or length(source_version) between 1 and 100
  ),
  add column vendor_release_id uuid unique
    references vendor_releases(id) on delete restrict,
  add constraint package_release_detections_status_check check (
    status in ('detected', 'suppressed', 'superseded')
  );

create table release_intelligence_outbox (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (event_type = 'release_intelligence.requested'),
  aggregate_id uuid not null unique references vendor_releases(id) on delete cascade,
  aggregate_version integer not null check (aggregate_version > 0),
  idempotency_key text not null unique check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'
  ),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536
  ),
  available_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 20),
  delivered_at timestamptz,
  workflow_execution_arn text check (
    workflow_execution_arn is null or length(workflow_execution_arn) between 20 and 2048
  ),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  created_at timestamptz not null default now(),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check (
    (delivered_at is null and workflow_execution_arn is null)
    or (delivered_at is not null and workflow_execution_arn is not null)
  )
);

create index release_intelligence_outbox_pending_idx
  on release_intelligence_outbox (available_at, created_at)
  where delivered_at is null;

revoke all on release_intelligence_outbox
  from public, anon, authenticated, app_runtime;
grant select on release_intelligence_outbox to app_runtime;
grant update (
  available_at, lease_owner, lease_expires_at, attempts, delivered_at,
  workflow_execution_arn, safe_error_code
) on release_intelligence_outbox to app_runtime;

create function register_detected_package_release()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  release_id_value uuid;
  existing_release vendor_releases%rowtype;
  workflow_correlation_id uuid := gen_random_uuid();
begin
  if tg_op = 'UPDATE' and old.vendor_release_id is not null then
    -- A later poll may observe metadata changes without a new version. Preserve
    -- the evidence that was bound to the immutable vendor release.
    new.api_product_id := old.api_product_id;
    new.source_id := old.source_id;
    new.version := old.version;
    new.source_version := old.source_version;
    new.vendor_release_id := old.vendor_release_id;
    new.published_at := old.published_at;
    new.evidence_object_key := old.evidence_object_key;
    new.evidence_digest := old.evidence_digest;
    new.metadata_digest := old.metadata_digest;
    return new;
  end if;
  if new.source_version is null then
    select state.last_observed_version into new.source_version
    from package_source_poll_states as state
    where state.source_id = new.source_id;
  end if;
  if new.latest_deprecated then
    new.status := 'suppressed';
    return new;
  end if;
  if new.status <> 'detected'
    or new.source_version is null
    or new.vendor_release_id is not null
  then
    return new;
  end if;
  if new.source_version = new.version
    or new.evidence_object_key !~ (
      '^env/(development|staging|production)/package-release/npm/source/'
      || new.source_id::text
      || '/poll/[0-9a-f-]{36}/metadata\.json$'
    )
    or not exists (
      select 1
      from vendor_sources as source
      join api_products as product on product.id = source.api_product_id
      join vendors as vendor on vendor.id = product.vendor_id
      where source.id = new.source_id
        and source.api_product_id = new.api_product_id
        and source.source_kind = 'package_registry_release'
        and source.canonical_domain = 'registry.npmjs.org'
        and source.trust_state = 'trusted'
        and product.ecosystem = 'npm'
        and product.status = 'active'
        and vendor.trust_state = 'trusted'
    )
  then
    raise exception using
      errcode = '23514',
      message = 'detected package release is outside the trusted ingestion boundary';
  end if;

  release_id_value := gen_random_uuid();
  insert into vendor_releases (
    id, api_product_id, version, source_compatibility, revision, published_at,
    source_digest, processing_state, trust_state, created_at
  ) values (
    release_id_value, new.api_product_id, new.version, new.source_version, 1,
    new.published_at, new.evidence_digest, 'registered', 'draft', now()
  )
  on conflict (api_product_id, version, revision) do nothing;

  select release.* into existing_release
  from vendor_releases as release
  where release.api_product_id = new.api_product_id
    and release.version = new.version
    and release.revision = 1
  for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'vendor release registration failed';
  end if;
  if existing_release.source_digest <> new.evidence_digest
    or existing_release.source_compatibility is distinct from new.source_version
    or existing_release.processing_state = 'rejected'
  then
    -- A release may already have been registered manually or by an earlier
    -- pilot. Do not overwrite its authority or let one collision abort polling.
    new.status := 'suppressed';
    return new;
  end if;

  new.vendor_release_id := existing_release.id;
  insert into release_intelligence_outbox (
    event_type, aggregate_id, aggregate_version, idempotency_key, payload
  ) values (
    'release_intelligence.requested',
    existing_release.id,
    existing_release.revision,
    'release-intelligence:' || existing_release.id::text,
    jsonb_build_object(
      'schemaVersion', '1.0',
      'vendorReleaseId', existing_release.id,
      'correlationId', workflow_correlation_id
    )
  )
  on conflict (aggregate_id) do nothing;
  return new;
end;
$$;

revoke all on function register_detected_package_release()
  from public, anon, authenticated, app_runtime;

create trigger package_release_detection_registration
before insert or update on package_release_detections
for each row execute function register_detected_package_release();

-- Backfill detections produced by 8D before this migration. A detection without
-- a recorded previous version remains visible but is intentionally not queued.
update package_release_detections as detection
set source_version = (
  select run.previous_version
  from package_source_poll_runs as run
  where run.source_id = detection.source_id
    and run.status = 'succeeded'
    and run.outcome = 'release_detected'
    and run.observed_version = detection.version
    and run.previous_version is not null
  order by run.completed_at desc, run.id
  limit 1
)
where detection.source_version is null
  and exists (
    select 1
    from package_source_poll_runs as run
    where run.source_id = detection.source_id
      and run.status = 'succeeded'
      and run.outcome = 'release_detected'
      and run.observed_version = detection.version
      and run.previous_version is not null
  );

alter table migration_specifications
  add constraint migration_specifications_reviewed_certainty_check check (
    trust_state = 'draft'
    or not jsonb_path_exists(
      specification,
      '$.changes[*] ? (@.certainty == "ambiguous")'
    )
  );

commit;
