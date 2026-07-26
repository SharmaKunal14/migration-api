begin;

create table vendor_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  vendor_release_id uuid not null unique
    references vendor_releases(id) on delete cascade,
  status text not null check (status in ('running', 'succeeded', 'failed')),
  attempt integer not null default 1 check (attempt between 1 and 10),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  correlation_id uuid not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'running' and safe_error_code is null and completed_at is null)
    or
    (status = 'succeeded' and safe_error_code is null and completed_at is not null)
    or
    (status = 'failed' and safe_error_code is not null and completed_at is not null)
  )
);

create table vendor_evidence_items (
  id uuid primary key default gen_random_uuid(),
  vendor_release_id uuid not null references vendor_releases(id) on delete cascade,
  vendor_source_id uuid not null references vendor_sources(id) on delete restrict,
  canonical_url text not null check (
    length(canonical_url) between 9 and 2048
    and canonical_url like 'https://%'
  ),
  object_key text not null unique check (
    length(object_key) between 1 and 1024
    and object_key !~ '(^|/)\.\.?(/|$)'
  ),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 1048576),
  media_type text not null check (length(media_type) between 1 and 255),
  etag text check (etag is null or length(etag) <= 512),
  retrieved_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (vendor_release_id, vendor_source_id)
);

create index vendor_evidence_items_release_idx
  on vendor_evidence_items (vendor_release_id, vendor_source_id);

update vendor_sources
set
  canonical_url = 'https://github.com/SharmaKunal14/orbitchat-sdk/tree/v2.0.0',
  updated_at = now()
where api_product_id = '16dca0bb-dd7d-4251-8e51-3c34816d5014'
  and source_key = 'sdk_release';

insert into vendor_releases (
  id,
  api_product_id,
  version,
  revision,
  published_at,
  source_digest,
  processing_state,
  trust_state
) values (
  '914e7575-7dc8-40e4-9445-aa61bfdb4ade',
  '16dca0bb-dd7d-4251-8e51-3c34816d5014',
  '2.0.0',
  1,
  '2026-07-26T00:00:00.000Z',
  'd1fc588a622adf5f6d7ef73aa8774612da35c952872bb7af9fe229bd23c28983',
  'registered',
  'draft'
);

revoke all on vendor_ingestion_runs, vendor_evidence_items
from anon, authenticated;

grant select, insert on vendor_ingestion_runs, vendor_evidence_items
to app_runtime;

grant update (
  status,
  attempt,
  safe_error_code,
  correlation_id,
  started_at,
  completed_at,
  updated_at
) on vendor_ingestion_runs to app_runtime;

grant update (
  last_digest,
  last_etag,
  last_checked_at,
  updated_at
) on vendor_sources to app_runtime;

grant update (
  evidence_object_key,
  evidence_digest,
  processing_state
) on vendor_releases to app_runtime;

grant select on vendor_ingestion_runs, vendor_evidence_items
to app_readonly;

commit;
