begin;

create table github_installations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  github_installation_id bigint not null unique check (github_installation_id > 0),
  github_account_id bigint not null check (github_account_id > 0),
  account_login text not null check (length(account_login) between 1 and 255),
  account_type text not null check (account_type in ('Organisation', 'User')),
  status text not null check (status in ('active', 'suspended', 'removed')),
  suspended_at timestamptz,
  removed_at timestamptz,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'suspended') = (suspended_at is not null)),
  check ((status = 'removed') = (removed_at is not null))
);

create index github_installations_organisation_idx
  on github_installations (organisation_id, status);

create table installation_link_states (
  state_digest text primary key check (state_digest ~ '^[a-f0-9]{64}$'),
  organisation_id uuid not null references organisations(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  return_path text not null check (
    return_path in ('/onboarding', '/settings/github')
  ),
  created_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (consumed_at is null or consumed_at >= created_at)
);

create index installation_link_states_expiry_idx
  on installation_link_states (expires_at)
  where consumed_at is null;

create table repositories (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  installation_id uuid not null references github_installations(id) on delete cascade,
  github_repository_id bigint not null unique check (github_repository_id > 0),
  owner text not null check (length(owner) between 1 and 255),
  name text not null check (length(name) between 1 and 255),
  full_name text not null check (
    length(full_name) between 3 and 512
    and full_name = owner || '/' || name
  ),
  default_branch text not null check (length(default_branch) between 1 and 255),
  visibility text not null check (visibility in ('public', 'private', 'internal')),
  selected boolean not null,
  archived boolean not null,
  enabled boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installation_id, github_repository_id)
);

create index repositories_organisation_idx
  on repositories (organisation_id, selected, enabled);

create table github_webhook_deliveries (
  delivery_id uuid primary key,
  event_name text not null check (
    event_name in (
      'installation',
      'installation_repositories',
      'repository',
      'push',
      'pull_request'
    )
  ),
  action text check (action is null or length(action) <= 100),
  payload_digest text not null check (payload_digest ~ '^[a-f0-9]{64}$'),
  processing_state text not null
    check (processing_state in ('received', 'processing', 'processed', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 20),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  received_at timestamptz not null,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((processing_state = 'processed') = (processed_at is not null))
);

create index github_webhook_deliveries_processing_idx
  on github_webhook_deliveries (processing_state, received_at);

create table repository_scans (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  requested_commit text check (
    requested_commit is null or requested_commit ~ '^[a-f0-9]{40}$'
  ),
  status text not null
    check (status in ('queued', 'running', 'succeeded', 'failed', 'unsupported')),
  trigger_source text not null
    check (trigger_source in ('installation', 'webhook', 'manual')),
  attempt integer not null default 0 check (attempt between 0 and 10),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'queued' and started_at is null and completed_at is null)
    or
    (status = 'running' and started_at is not null and completed_at is null)
    or
    (status in ('succeeded', 'failed', 'unsupported')
      and started_at is not null and completed_at is not null)
  )
);

create unique index repository_scans_one_active_idx
  on repository_scans (repository_id)
  where status in ('queued', 'running');

create index repository_scans_repository_history_idx
  on repository_scans (repository_id, created_at desc);

create table repository_snapshots (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  repository_id uuid not null references repositories(id) on delete cascade,
  repository_scan_id uuid not null unique references repository_scans(id)
    on delete cascade,
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  acquisition_purpose text not null check (acquisition_purpose = 'inventory'),
  status text not null check (status in ('available', 'expired', 'deleted')),
  object_key text not null unique check (
    length(object_key) between 1 and 1024
    and object_key !~ '(^|/)\.\.?(/|$)'
  ),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  bytes bigint not null check (bytes between 1 and 1073741824),
  file_count integer not null check (file_count between 1 and 200000),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repository_id, commit_sha, acquisition_purpose),
  check (expires_at > created_at)
);

create index repository_snapshots_expiry_idx
  on repository_snapshots (expires_at)
  where status = 'available';

create table dependency_observations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references organisations(id) on delete cascade,
  repository_snapshot_id uuid not null references repository_snapshots(id)
    on delete cascade,
  package_name text not null check (
    length(package_name) between 1 and 214
    and package_name ~ '^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*/)?[A-Za-z0-9][A-Za-z0-9._~-]*$'
  ),
  dependency_kind text not null
    check (dependency_kind in ('dependency', 'development', 'optional', 'peer')),
  manifest_path text not null check (
    length(manifest_path) between 1 and 1024
    and manifest_path !~ '(^|/)\.\.?(/|$)'
  ),
  lockfile_path text check (
    lockfile_path is null
    or (
      length(lockfile_path) between 1 and 1024
      and lockfile_path !~ '(^|/)\.\.?(/|$)'
    )
  ),
  declared_range text not null check (length(declared_range) between 1 and 1024),
  resolved_version text check (
    resolved_version is null or length(resolved_version) between 1 and 1024
  ),
  discovery_method text not null
    check (discovery_method in ('manifest', 'npm_lockfile')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (
    repository_snapshot_id,
    manifest_path,
    package_name,
    dependency_kind
  )
);

create index dependency_observations_snapshot_idx
  on dependency_observations (repository_snapshot_id, package_name);

revoke all on
  github_installations,
  installation_link_states,
  repositories,
  github_webhook_deliveries,
  repository_scans,
  repository_snapshots,
  dependency_observations
from anon, authenticated;

grant select, insert, update on
  github_installations,
  installation_link_states,
  repositories,
  github_webhook_deliveries,
  repository_scans,
  repository_snapshots,
  dependency_observations
to app_runtime;

grant select on
  github_installations,
  repositories,
  github_webhook_deliveries,
  repository_scans,
  repository_snapshots,
  dependency_observations
to app_readonly;

commit;
