begin;

create table vendors (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z][a-z0-9-]{1,62}$'),
  name text not null check (length(name) between 1 and 120),
  official_domains text[] not null check (
    cardinality(official_domains) between 1 and 20
  ),
  trust_state text not null
    check (trust_state in ('draft', 'trusted', 'disabled')),
  synthetic boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    array_to_string(official_domains, ',')
      ~ '^[a-z0-9.-]+(?:,[a-z0-9.-]+)*$'
  )
);

create table api_products (
  id uuid primary key default gen_random_uuid(),
  vendor_id uuid not null references vendors(id) on delete restrict,
  ecosystem text not null check (ecosystem = 'npm'),
  canonical_identifier text not null check (
    length(canonical_identifier) between 1 and 214
    and canonical_identifier
      ~ '^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*$'
  ),
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ecosystem, canonical_identifier)
);

create table vendor_sources (
  id uuid primary key default gen_random_uuid(),
  api_product_id uuid not null references api_products(id) on delete cascade,
  source_key text not null check (source_key ~ '^[a-z][a-z0-9_-]{2,63}$'),
  source_kind text not null check (
    source_kind in (
      'package_registry_release',
      'migration_guide',
      'changelog',
      'api_definition',
      'sdk_repository_release'
    )
  ),
  canonical_url text not null check (
    length(canonical_url) between 9 and 2048
    and canonical_url like 'https://%'
  ),
  canonical_domain text not null check (
    canonical_domain ~ '^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$'
  ),
  expected_media_types text[] not null check (
    cardinality(expected_media_types) between 1 and 10
  ),
  trust_state text not null
    check (trust_state in ('draft', 'trusted', 'disabled')),
  poll_interval_seconds integer not null
    check (poll_interval_seconds between 3600 and 2592000),
  last_digest text check (
    last_digest is null or last_digest ~ '^[a-f0-9]{64}$'
  ),
  last_etag text check (last_etag is null or length(last_etag) <= 512),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (api_product_id, source_key),
  unique (api_product_id, canonical_url)
);

create index vendor_sources_due_idx
  on vendor_sources (last_checked_at, id)
  where trust_state = 'trusted';

create table vendor_releases (
  id uuid primary key default gen_random_uuid(),
  api_product_id uuid not null references api_products(id) on delete restrict,
  version text not null check (length(version) between 1 and 100),
  revision integer not null check (revision > 0),
  published_at timestamptz,
  evidence_object_key text check (
    evidence_object_key is null
    or (
      length(evidence_object_key) between 1 and 1024
      and evidence_object_key !~ '(^|/)\.\.?(/|$)'
    )
  ),
  evidence_digest text check (
    evidence_digest is null or evidence_digest ~ '^[a-f0-9]{64}$'
  ),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  processing_state text not null check (
    processing_state in ('registered', 'fetched', 'validated', 'rejected')
  ),
  trust_state text not null check (
    trust_state in ('draft', 'reviewed', 'vendor_verified')
  ),
  created_at timestamptz not null default now(),
  unique (api_product_id, version, revision),
  check (
    (processing_state in ('registered', 'rejected')
      and evidence_object_key is null and evidence_digest is null)
    or
    (processing_state in ('fetched', 'validated')
      and evidence_object_key is not null and evidence_digest is not null)
  )
);

create table migration_specifications (
  id uuid primary key default gen_random_uuid(),
  vendor_release_id uuid not null references vendor_releases(id) on delete restrict,
  source_compatibility text not null
    check (length(source_compatibility) between 1 and 100),
  target_version text not null check (length(target_version) between 1 and 100),
  schema_version text not null check (schema_version = '1.0'),
  specification jsonb not null check (
    jsonb_typeof(specification) = 'object'
    and pg_column_size(specification) <= 1048576
  ),
  evidence_object_key text not null check (
    length(evidence_object_key) between 1 and 1024
    and evidence_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  evidence_digest text not null check (evidence_digest ~ '^[a-f0-9]{64}$'),
  trust_state text not null check (
    trust_state in ('draft', 'reviewed', 'vendor_verified')
  ),
  revision integer not null check (revision > 0),
  generated_by text not null check (
    generated_by in ('change_intelligence_agent', 'operator')
  ),
  reviewed_by_user_id uuid references app_users(id) on delete restrict,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (
    vendor_release_id,
    source_compatibility,
    target_version,
    revision
  ),
  check (
    (trust_state = 'draft' and reviewed_by_user_id is null and reviewed_at is null)
    or
    (trust_state in ('reviewed', 'vendor_verified')
      and reviewed_by_user_id is not null and reviewed_at is not null)
  )
);

create index migration_specifications_release_idx
  on migration_specifications (vendor_release_id, trust_state, revision desc);

alter table repositories
  add constraint repositories_id_organisation_unique unique (id, organisation_id);

alter table repository_snapshots
  add constraint repository_snapshots_id_repository_unique unique (id, repository_id);

alter table dependency_observations
  add constraint dependency_observations_id_organisation_unique
  unique (id, organisation_id);

create table migration_candidates (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  repository_id uuid not null,
  migration_specification_id uuid not null
    references migration_specifications(id) on delete restrict,
  dependency_observation_id uuid not null,
  status text not null
    check (status in ('open', 'dismissed', 'superseded', 'resolved')),
  first_detected_at timestamptz not null default now(),
  last_detected_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (repository_id, organisation_id)
    references repositories(id, organisation_id) on delete cascade,
  foreign key (dependency_observation_id, organisation_id)
    references dependency_observations(id, organisation_id) on delete cascade,
  unique (id, repository_id),
  check (last_detected_at >= first_detected_at)
);

create unique index migration_candidates_one_open_idx
  on migration_candidates (repository_id, migration_specification_id)
  where status = 'open';

create index migration_candidates_inbox_idx
  on migration_candidates (organisation_id, status, last_detected_at desc);

create table impact_reports (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null,
  repository_id uuid not null,
  repository_snapshot_id uuid not null,
  impact_agent_run_id uuid not null references agent_runs(id) on delete restrict,
  schema_version text not null check (schema_version = '1.0'),
  outcome text not null
    check (outcome in ('affected', 'not_affected', 'inconclusive')),
  affected_summary jsonb not null check (
    jsonb_typeof(affected_summary) = 'object'
    and pg_column_size(affected_summary) <= 1048576
  ),
  risk_category text not null
    check (risk_category in ('low', 'medium', 'high', 'unknown')),
  verification_availability jsonb not null check (
    jsonb_typeof(verification_availability) = 'object'
    and pg_column_size(verification_availability) <= 262144
  ),
  uncertainty jsonb not null check (
    jsonb_typeof(uncertainty) = 'array'
    and pg_column_size(uncertainty) <= 262144
  ),
  artifact_object_key text not null check (
    length(artifact_object_key) between 1 and 1024
    and artifact_object_key !~ '(^|/)\.\.?(/|$)'
  ),
  artifact_digest text not null check (artifact_digest ~ '^[a-f0-9]{64}$'),
  revision integer not null check (revision > 0),
  created_at timestamptz not null default now(),
  foreign key (candidate_id, repository_id)
    references migration_candidates(id, repository_id) on delete cascade,
  foreign key (repository_snapshot_id, repository_id)
    references repository_snapshots(id, repository_id) on delete restrict,
  unique (candidate_id, revision)
);

create index impact_reports_candidate_idx
  on impact_reports (candidate_id, revision desc);

insert into vendors (
  id,
  slug,
  name,
  official_domains,
  trust_state,
  synthetic
) values (
  'a92186f3-3a0d-4fc0-8284-8f91da2abf50',
  'orbitchat',
  'OrbitChat',
  array['github.com', 'raw.githubusercontent.com'],
  'trusted',
  true
);

insert into api_products (
  id,
  vendor_id,
  ecosystem,
  canonical_identifier,
  status
) values (
  '16dca0bb-dd7d-4251-8e51-3c34816d5014',
  'a92186f3-3a0d-4fc0-8284-8f91da2abf50',
  'npm',
  '@orbitchat/sdk',
  'active'
);

insert into vendor_sources (
  api_product_id,
  source_key,
  source_kind,
  canonical_url,
  canonical_domain,
  expected_media_types,
  trust_state,
  poll_interval_seconds
) values
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'release_metadata',
    'package_registry_release',
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/release.json',
    'raw.githubusercontent.com',
    array['application/json', 'text/plain'],
    'trusted',
    86400
  ),
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'migration_guide',
    'migration_guide',
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/MIGRATION.md',
    'raw.githubusercontent.com',
    array['text/markdown', 'text/plain'],
    'trusted',
    86400
  ),
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'changelog',
    'changelog',
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/CHANGELOG.md',
    'raw.githubusercontent.com',
    array['text/markdown', 'text/plain'],
    'trusted',
    86400
  ),
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'v1_api',
    'api_definition',
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v1.0.0/index.d.ts',
    'raw.githubusercontent.com',
    array['text/plain', 'text/typescript'],
    'trusted',
    2592000
  ),
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'v2_api',
    'api_definition',
    'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/index.d.ts',
    'raw.githubusercontent.com',
    array['text/plain', 'text/typescript'],
    'trusted',
    2592000
  ),
  (
    '16dca0bb-dd7d-4251-8e51-3c34816d5014',
    'sdk_release',
    'sdk_repository_release',
    'https://github.com/SharmaKunal14/orbitchat-sdk/releases/tag/v2.0.0',
    'github.com',
    array['text/html'],
    'trusted',
    86400
  );

revoke all on
  vendors,
  api_products,
  vendor_sources,
  vendor_releases,
  migration_specifications,
  migration_candidates,
  impact_reports
from anon, authenticated;

grant select on
  vendors,
  api_products,
  vendor_sources,
  vendor_releases,
  migration_specifications,
  migration_candidates,
  impact_reports
to app_runtime, app_readonly;

commit;
