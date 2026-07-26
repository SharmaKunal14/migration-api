# Stage 3B deployment

Stage 3B adds an immutable vendor-fetcher image, database migration, Fargate
task, and operator-started Step Functions workflow. It does not add a public API
or UI control for ingestion.

## 1. Apply the container foundation

Use Terraform 1.15.8 and the existing foundation backend. Create and inspect a
saved plan:

```bash
terraform -chdir=infra/terraform/foundation plan \
  -input=false \
  -var="aws_region=ap-southeast-2" \
  -var="owner=KunalSharma" \
  -out=stage-3b-foundation.tfplan
terraform -chdir=infra/terraform/foundation show \
  -no-color \
  stage-3b-foundation.tfplan
```

For the current development environment, the plan should add only:

- `migration-api-development-vendor-fetcher` ECR repository;
- its immutable-image lifecycle policy.

Investigate unrelated replacements or destruction before applying:

```bash
terraform -chdir=infra/terraform/foundation apply \
  -input=false \
  stage-3b-foundation.tfplan
```

## 2. Run the protected development deployment

Commit and push the Stage 3B revision, then run **Deploy development** with the
confirmation value `deploy-development`. The workflow:

1. builds and vulnerability-scans the vendor-fetcher image;
2. runs migration `0005_stage_3b.sql`;
3. plans the dedicated task, IAM roles, workflow, logs, and alarms;
4. pauses for protected-environment approval;
5. applies the exact reviewed plan.

Review the Terraform plan for the vendor fetcher only. In particular, confirm
that its task role has no GitHub, OpenAI, Lambda invocation, or general S3
permissions.

## 3. Start the OrbitChat ingestion

Get the deployed workflow ARN:

```bash
vendor_ingestion_arn="$(
  terraform -chdir=infra/terraform/environments/development \
    output -raw vendor_ingestion_state_machine_arn
)"
correlation_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"
aws stepfunctions start-execution \
  --state-machine-arn "${vendor_ingestion_arn}" \
  --name "orbitchat-v2-${correlation_id}" \
  --input "$(
    jq -cn \
      --arg release_id "914e7575-7dc8-40e4-9445-aa61bfdb4ade" \
      --arg correlation_id "${correlation_id}" \
      '{
        schemaVersion: "1.0",
        vendorReleaseId: $release_id,
        correlationId: $correlation_id
      }'
  )"
```

The task retrieves only the six trusted, version-pinned OrbitChat sources
registered by Stage 3A. Re-running the workflow for the same validated release
is a successful no-op.

## 4. Verify the outcome

In Step Functions, the execution should be `SUCCEEDED`. In the Supabase SQL
editor, run:

```sql
select status, attempt, safe_error_code, completed_at
from vendor_ingestion_runs
where vendor_release_id = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';

select count(*) as evidence_items
from vendor_evidence_items
where vendor_release_id = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';

select processing_state, trust_state, evidence_object_key, evidence_digest
from vendor_releases
where id = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';
```

Expected values are:

- ingestion status `succeeded`;
- six evidence items;
- release processing state `validated`;
- release trust state still `draft`;
- non-null evidence object key and SHA-256 digest.

The vendor-fetcher log should contain identifiers and safe status codes only,
not evidence bodies or credentials. The two vendor-ingestion alarms should
remain `OK`.

## Failure handling

A rejected address, redirect, media type, oversized response, digest mismatch,
or timeout fails closed with a safe code. Fix the registered source or
infrastructure cause and start a new execution. Attempts are bounded at ten;
concurrent executions for the same release are rejected, and a running attempt
is recoverable after twenty minutes.

Stage 3B has no new visible UI state. Candidate creation and user-facing
migration intelligence begin in later Stage 3 slices.
