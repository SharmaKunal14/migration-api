# Stage 3D deployment

Stage 3D adds database migration `0007_stage_3d.sql`, API review and candidate
routes, and automatic candidate reconciliation after repository scans. It adds
no Terraform resources and requires no foundation deployment.

## 1. Deploy the reviewed revision

Commit and push the Stage 3D revision, then run **Deploy development** with
confirmation `deploy-development`. The existing workflow:

1. runs the complete application and security checks;
2. builds the API and repository-scan controller;
3. runs database migration `0007_stage_3d.sql`;
4. creates and reviews the exact Terraform plan;
5. deploys the immutable Lambda bundles.

The Terraform plan may contain in-place Lambda bundle and immutable task-image
digest updates produced by the normal deployment workflow. It should not add,
replace, or destroy infrastructure resources. Investigate any such action.

## 2. Provision the initial platform operator

Customer organisation roles do not grant vendor-intelligence review authority.
In the Supabase SQL editor, identify the intended application user:

```sql
select id, auth_subject, display_name, created_at
from app_users
order by created_at;
```

Resolve the exact user before continuing. Then insert only that user:

```sql
insert into platform_operators (user_id, status, reason)
values (
  '<EXACT_APP_USER_ID>',
  'active',
  'Initial development vendor-intelligence reviewer'
)
on conflict (user_id) do nothing;
```

Do not grant every organisation owner operator access. Operator access is a
platform role and should remain exceptional.

## 3. Discover the draft

Read the access token without echoing it:

```bash
read -rs "access_token?Supabase access token: "
echo
api_base="https://migration-api.kunal-sharma.in/api"
```

List the drafts:

```bash
curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${access_token}" \
  -H "Accept: application/json" \
  "${api_base}/v1/operator/migration-specifications?trustState=draft" |
jq
```

Record the exact OrbitChat specification ID and revision. Do not copy an ID
from another environment.

Inspect the complete structured draft, evidence URLs, and digests before
promotion:

```bash
specification_id="<EXACT_DRAFT_SPECIFICATION_ID>"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${access_token}" \
  -H "Accept: application/json" \
  "${api_base}/v1/operator/migration-specifications/${specification_id}" |
jq
```

## 4. Review and match

```bash
review_key="review:$(uuidgen | tr '[:upper:]' '[:lower:]')"

curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${access_token}" \
  -H "Accept: application/json" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${review_key}" \
  --data '{"expectedRevision":1}' \
  "${api_base}/v1/operator/migration-specifications/${specification_id}/review" |
jq
```

Expected response:

- specification trust state `reviewed`;
- one matched repository for the OrbitChat fixture;
- no review-time error.

Repeating the request with the same idempotency key returns the original
reviewed resource without creating another candidate.

## 5. Verify the candidate

```bash
organisation_id="fb88f567-56f6-4151-8a42-c84981f49ec6"

curl --fail-with-body --silent --show-error \
  -H "Authorization: Bearer ${access_token}" \
  -H "Accept: application/json" \
  "${api_base}/v1/organisations/${organisation_id}/migration-candidates" |
jq
```

Expected candidate:

- repository `SharmaKunal14/orbitchat-migration-fixture`;
- package `@orbitchat/sdk`;
- resolved version `1.0.0`;
- source compatibility `1.x`;
- target version `2.0.0`;
- specification trust `reviewed`;
- candidate status `open`.

Database verification:

```sql
select
  specification.id,
  specification.trust_state,
  specification.revision,
  specification.reviewed_by_user_id,
  specification.reviewed_at,
  release.trust_state as release_trust_state
from migration_specifications as specification
inner join vendor_releases as release
  on release.id = specification.vendor_release_id
where specification.id = '<EXACT_DRAFT_SPECIFICATION_ID>';

select
  candidate.id,
  repository.full_name,
  observation.package_name,
  observation.declared_range,
  observation.resolved_version,
  candidate.status,
  candidate.version
from migration_candidates as candidate
inner join repositories as repository on repository.id = candidate.repository_id
inner join dependency_observations as observation
  on observation.id = candidate.dependency_observation_id
where candidate.status = 'open';
```

## Failure handling

- `PLATFORM_OPERATOR_REQUIRED`: provision the exact user; do not weaken the
  route to organisation-owner authorization.
- `MIGRATION_SPECIFICATION_REVISION_CONFLICT`: reload the draft and review the
  current revision.
- `SOURCE_COMPATIBILITY_INVALID`: reject or correct the draft through a new
  immutable specification revision.
- `CANDIDATE_RECONCILIATION_LIMIT_EXCEEDED`: do not increase Lambda timeout
  blindly; move reconciliation to a bounded background workflow.
- No candidate: confirm the latest available snapshot resolves
  `@orbitchat/sdk` to a version inside `1.x`.

Clear the shell token when finished:

```bash
unset access_token
```
