begin;

alter table migration_run_events
  drop constraint migration_run_events_event_type_check;

alter table migration_run_events
  add constraint migration_run_events_event_type_check check (
    event_type in (
      'run_requested',
      'approval_validated',
      'stage_entered',
      'source_acquired',
      'plan_created',
      'patch_proposed',
      'patch_validated',
      'verification_prepared',
      'verification_started',
      'verification_completed',
      'repair_requested',
      'publication_prepared',
      'publication_started',
      'publication_reconciled',
      'notification_queued',
      'cancellation_requested',
      'run_cancelled',
      'run_failed',
      'run_stale',
      'run_completed'
    )
  );

alter table migration_approvals
  add constraint migration_approvals_publication_binding_unique unique (
    id,
    organisation_id,
    repository_id,
    installation_id,
    github_repository_id,
    base_branch,
    base_commit_sha,
    publication_policy_version
  );

alter table verification_attempts
  add constraint verification_attempts_publication_binding_unique unique (
    id,
    organisation_id,
    migration_run_id,
    patch_attempt_id,
    patch_artifact_id,
    patch_digest,
    patch_validation_artifact_id,
    patch_validation_digest,
    base_commit_sha
  );

alter table verification_attempt_results
  add constraint verification_results_publication_binding_unique unique (
    id,
    organisation_id,
    migration_run_id,
    verification_attempt_id,
    outcome
  );

create table publication_attempts (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  approval_id uuid not null,
  repository_id uuid not null,
  installation_id uuid not null,
  github_repository_id bigint not null check (github_repository_id > 0),
  verification_attempt_id uuid not null,
  verification_result_id uuid not null,
  verification_outcome text not null check (verification_outcome = 'passed'),
  patch_attempt_id uuid not null,
  patch_artifact_id uuid not null,
  patch_digest text not null check (patch_digest ~ '^[a-f0-9]{64}$'),
  patch_validation_artifact_id uuid not null,
  patch_validation_digest text not null check (
    patch_validation_digest ~ '^[a-f0-9]{64}$'
  ),
  base_branch text not null check (
    length(base_branch) between 1 and 255
    and position('..' in base_branch) = 0
    and position('@{' in base_branch) = 0
    and base_branch !~ '(^|/)[^/]*\.lock(/|$)'
    and base_branch !~ '[[:cntrl:]]'
    and base_branch !~ '^/'
    and base_branch !~ '/$'
    and base_branch !~ '//'
    and right(base_branch, 1) <> '.'
    and right(base_branch, 5) <> '.lock'
    and position(' ' in base_branch) = 0
    and position('~' in base_branch) = 0
    and position('^' in base_branch) = 0
    and position(':' in base_branch) = 0
    and position('?' in base_branch) = 0
    and position('*' in base_branch) = 0
    and position('[' in base_branch) = 0
    and position(chr(92) in base_branch) = 0
    and base_branch <> '@'
  ),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  head_branch text not null check (
    head_branch = 'migration-api/run-' || migration_run_id::text
  ),
  publication_policy_version text not null check (
    publication_policy_version ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
  ),
  status text not null check (
    status in (
      'queued',
      'validating',
      'publishing',
      'reconciling',
      'succeeded',
      'failed',
      'stale',
      'cancelled'
    )
  ),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  idempotency_key text not null check (
    idempotency_key = 'publication:' || migration_run_id::text
  ),
  correlation_id uuid not null,
  created_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null,
  foreign key (
    migration_run_id,
    organisation_id,
    approval_id,
    base_commit_sha
  ) references migration_runs (
    id,
    organisation_id,
    approval_id,
    base_commit_sha
  ) on delete restrict,
  foreign key (
    approval_id,
    organisation_id,
    repository_id,
    installation_id,
    github_repository_id,
    base_branch,
    base_commit_sha,
    publication_policy_version
  ) references migration_approvals (
    id,
    organisation_id,
    repository_id,
    installation_id,
    github_repository_id,
    base_branch,
    base_commit_sha,
    publication_policy_version
  ) on delete restrict,
  foreign key (
    verification_attempt_id,
    organisation_id,
    migration_run_id,
    patch_attempt_id,
    patch_artifact_id,
    patch_digest,
    patch_validation_artifact_id,
    patch_validation_digest,
    base_commit_sha
  ) references verification_attempts (
    id,
    organisation_id,
    migration_run_id,
    patch_attempt_id,
    patch_artifact_id,
    patch_digest,
    patch_validation_artifact_id,
    patch_validation_digest,
    base_commit_sha
  ) on delete restrict,
  foreign key (
    verification_result_id,
    organisation_id,
    migration_run_id,
    verification_attempt_id,
    verification_outcome
  ) references verification_attempt_results (
    id,
    organisation_id,
    migration_run_id,
    verification_attempt_id,
    outcome
  ) on delete restrict,
  unique (migration_run_id),
  unique (id, organisation_id, migration_run_id),
  unique (
    id,
    organisation_id,
    migration_run_id,
    repository_id,
    github_repository_id,
    head_branch,
    base_branch,
    base_commit_sha
  ),
  check (updated_at >= created_at),
  check (started_at is null or started_at >= created_at),
  check (completed_at is null or completed_at >= created_at),
  check (
    (
      status = 'queued'
      and attempt_count = 0
      and safe_error_code is null
      and started_at is null
      and completed_at is null
    )
    or (
      status in ('validating', 'publishing', 'reconciling')
      and attempt_count > 0
      and safe_error_code is null
      and started_at is not null
      and completed_at is null
    )
    or (
      status = 'succeeded'
      and attempt_count > 0
      and safe_error_code is null
      and started_at is not null
      and completed_at is not null
      and completed_at >= started_at
    )
    or (
      status in ('failed', 'stale')
      and attempt_count > 0
      and safe_error_code is not null
      and started_at is not null
      and completed_at is not null
      and completed_at >= started_at
    )
    or (
      status = 'cancelled'
      and safe_error_code is null
      and completed_at is not null
      and (started_at is null or completed_at >= started_at)
    )
  )
);

create index publication_attempts_run_idx
  on publication_attempts (organisation_id, migration_run_id, created_at);

create table github_publications (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  publication_attempt_id uuid not null,
  repository_id uuid not null,
  github_repository_id bigint not null check (github_repository_id > 0),
  head_branch text not null,
  base_branch text not null check (length(base_branch) between 1 and 255),
  base_commit_sha text not null check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  commit_sha text not null check (commit_sha ~ '^[a-f0-9]{40}$'),
  pull_request_number integer not null check (pull_request_number > 0),
  pull_request_node_id text not null check (
    length(pull_request_node_id) between 1 and 255
    and pull_request_node_id !~ '[[:cntrl:]]'
  ),
  pull_request_url text not null check (
    pull_request_url ~ (
      '^https://github\.com/'
      || '[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]*$'
    )
  ),
  state text not null check (state in ('open', 'closed', 'merged')),
  is_draft boolean not null,
  created_at timestamptz not null,
  last_reconciled_at timestamptz not null,
  foreign key (
    publication_attempt_id,
    organisation_id,
    migration_run_id,
    repository_id,
    github_repository_id,
    head_branch,
    base_branch,
    base_commit_sha
  ) references publication_attempts (
    id,
    organisation_id,
    migration_run_id,
    repository_id,
    github_repository_id,
    head_branch,
    base_branch,
    base_commit_sha
  ) on delete restrict,
  unique (id, organisation_id, migration_run_id),
  unique (publication_attempt_id),
  unique (github_repository_id, head_branch),
  unique (github_repository_id, pull_request_number),
  check (last_reconciled_at >= created_at),
  check (state <> 'merged' or not is_draft)
);

create index github_publications_run_idx
  on github_publications (organisation_id, migration_run_id);

create table publication_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null,
  migration_run_id uuid not null,
  publication_id uuid not null,
  recipient_user_id uuid not null references app_users(id) on delete restrict,
  event_type text not null check (event_type = 'draft_pr_created'),
  channel text not null check (channel in ('in_app', 'email')),
  idempotency_key text not null check (
    idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$'
  ),
  available_at timestamptz not null,
  lease_owner uuid,
  lease_expires_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 10),
  delivered_at timestamptz,
  safe_error_code text check (
    safe_error_code is null or safe_error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'
  ),
  created_at timestamptz not null,
  foreign key (publication_id, organisation_id, migration_run_id)
    references github_publications(id, organisation_id, migration_run_id)
    on delete restrict,
  unique (idempotency_key),
  unique (publication_id, recipient_user_id, event_type, channel),
  check (
    (lease_owner is null and lease_expires_at is null)
    or (lease_owner is not null and lease_expires_at is not null)
  ),
  check (available_at >= created_at),
  check (lease_expires_at is null or lease_expires_at > created_at),
  check (delivered_at is null or delivered_at >= created_at),
  check (
    not (delivered_at is not null and safe_error_code is not null)
  )
);

create index publication_notification_outbox_pending_idx
  on publication_notification_outbox (available_at, created_at)
  where delivered_at is null;

create function enforce_publication_attempt_transition()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'publication attempt cannot be deleted';
  end if;
  if old.id is distinct from new.id
    or old.organisation_id is distinct from new.organisation_id
    or old.migration_run_id is distinct from new.migration_run_id
    or old.approval_id is distinct from new.approval_id
    or old.repository_id is distinct from new.repository_id
    or old.installation_id is distinct from new.installation_id
    or old.github_repository_id is distinct from new.github_repository_id
    or old.verification_attempt_id is distinct from new.verification_attempt_id
    or old.verification_result_id is distinct from new.verification_result_id
    or old.verification_outcome is distinct from new.verification_outcome
    or old.patch_attempt_id is distinct from new.patch_attempt_id
    or old.patch_artifact_id is distinct from new.patch_artifact_id
    or old.patch_digest is distinct from new.patch_digest
    or old.patch_validation_artifact_id
      is distinct from new.patch_validation_artifact_id
    or old.patch_validation_digest is distinct from new.patch_validation_digest
    or old.base_branch is distinct from new.base_branch
    or old.base_commit_sha is distinct from new.base_commit_sha
    or old.head_branch is distinct from new.head_branch
    or old.publication_policy_version
      is distinct from new.publication_policy_version
    or old.idempotency_key is distinct from new.idempotency_key
    or old.correlation_id is distinct from new.correlation_id
    or old.created_at is distinct from new.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'publication attempt evidence binding is immutable';
  end if;

  if old.status in ('succeeded', 'failed', 'stale', 'cancelled') then
    raise exception using
      errcode = '55000',
      message = 'terminal publication attempt cannot be changed';
  end if;

  if new.attempt_count < old.attempt_count
    or new.updated_at < old.updated_at
  then
    raise exception using
      errcode = '55000',
      message = 'publication attempt progress must be monotonic';
  end if;

  if not (
    (
      old.status = new.status
      and old.status in ('validating', 'publishing', 'reconciling')
      and new.attempt_count > old.attempt_count
    )
    or (old.status = 'queued' and new.status in (
      'validating', 'failed', 'stale', 'cancelled'
    ))
    or (old.status = 'validating' and new.status in (
      'publishing', 'failed', 'stale', 'cancelled'
    ))
    or (old.status = 'publishing' and new.status in (
      'reconciling', 'succeeded', 'failed', 'stale'
    ))
    or (old.status = 'reconciling' and new.status in (
      'succeeded', 'failed', 'stale'
    ))
  ) then
    raise exception using
      errcode = '55000',
      message = 'invalid publication attempt state transition';
  end if;
  return new;
end;
$$;

create trigger publication_attempts_transition_guard
before update or delete on publication_attempts
for each row execute function enforce_publication_attempt_transition();

create function enforce_github_publication_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'GitHub publication identity cannot be deleted';
  end if;
  if old.id is distinct from new.id
    or old.organisation_id is distinct from new.organisation_id
    or old.migration_run_id is distinct from new.migration_run_id
    or old.publication_attempt_id is distinct from new.publication_attempt_id
    or old.repository_id is distinct from new.repository_id
    or old.github_repository_id is distinct from new.github_repository_id
    or old.head_branch is distinct from new.head_branch
    or old.base_branch is distinct from new.base_branch
    or old.base_commit_sha is distinct from new.base_commit_sha
    or old.commit_sha is distinct from new.commit_sha
    or old.pull_request_number is distinct from new.pull_request_number
    or old.pull_request_node_id is distinct from new.pull_request_node_id
    or old.pull_request_url is distinct from new.pull_request_url
    or old.created_at is distinct from new.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'GitHub publication identity is immutable';
  end if;
  if old.state = 'merged' and (
    new.state is distinct from old.state
    or new.is_draft is distinct from old.is_draft
  ) then
    raise exception using
      errcode = '55000',
      message = 'merged GitHub publication state is terminal';
  end if;
  return new;
end;
$$;

create trigger github_publications_identity_guard
before update or delete on github_publications
for each row execute function enforce_github_publication_identity();

create function enforce_publication_notification_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'publication notification cannot be deleted';
  end if;
  if old.id is distinct from new.id
    or old.organisation_id is distinct from new.organisation_id
    or old.migration_run_id is distinct from new.migration_run_id
    or old.publication_id is distinct from new.publication_id
    or old.recipient_user_id is distinct from new.recipient_user_id
    or old.event_type is distinct from new.event_type
    or old.channel is distinct from new.channel
    or old.idempotency_key is distinct from new.idempotency_key
    or old.created_at is distinct from new.created_at
  then
    raise exception using
      errcode = '55000',
      message = 'publication notification identity is immutable';
  end if;
  if old.delivered_at is not null then
    raise exception using
      errcode = '55000',
      message = 'delivered publication notification is terminal';
  end if;
  if new.attempts < old.attempts then
    raise exception using
      errcode = '55000',
      message = 'publication notification attempts must be monotonic';
  end if;
  return new;
end;
$$;

create trigger publication_notification_identity_guard
before update or delete on publication_notification_outbox
for each row execute function enforce_publication_notification_identity();

revoke all on
  publication_attempts,
  github_publications,
  publication_notification_outbox
from anon, authenticated;

revoke all on function enforce_publication_attempt_transition() from public;
revoke all on function enforce_github_publication_identity() from public;
revoke all on function enforce_publication_notification_identity() from public;

grant select, insert, update on
  publication_attempts,
  github_publications,
  publication_notification_outbox
to app_runtime;

grant select on
  publication_attempts,
  github_publications,
  publication_notification_outbox
to app_readonly;

commit;
