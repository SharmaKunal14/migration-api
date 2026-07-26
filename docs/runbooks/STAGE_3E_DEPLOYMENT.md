# Stage 3E deployment

Stage 3E adds a dedicated impact-analysis image, control Lambda, Standard Step
Functions workflow, migration `0008_stage_3e.sql`, IAM, and monitoring. It has
no public UI trigger; Stage 3F will expose the report.

## 1. Create the dedicated OpenAI identity

Reuse the existing AWS workload identity provider, but create a new mapping and
service account for:

```text
arn:aws:iam::393209814365:role/migration-api-development-impact-analysis-task
```

Recommended mapping name:

```text
migration-api-impact-analysis-development
```

Add the non-secret IDs to the protected GitHub `development` environment:

```text
IMPACT_ANALYSIS_OPENAI_IDENTITY_PROVIDER_ID
IMPACT_ANALYSIS_OPENAI_SERVICE_ACCOUNT_ID
```

Do not create or store an OpenAI API key.

## 2. Apply the container foundation

Use Terraform 1.15.8. The plan must add only the impact-analysis ECR repository
and lifecycle policy:

```bash
terraform -chdir=infra/terraform/foundation plan \
  -input=false \
  -var="aws_region=ap-southeast-2" \
  -var="owner=KunalSharma" \
  -out=stage-3e-foundation.tfplan

terraform -chdir=infra/terraform/foundation show \
  -no-color \
  stage-3e-foundation.tfplan

terraform -chdir=infra/terraform/foundation apply \
  -input=false \
  stage-3e-foundation.tfplan
```

## 3. Run the protected deployment

Commit and push Stage 3E, then run **Deploy development** with confirmation
`deploy-development`. It builds and scans the image, runs migration `0008`,
creates a saved Terraform plan, pauses for approval, and applies that exact plan.

The task role may read exact repository snapshots, read/write its analysis
prefix, use the artifact KMS key, and request a conditioned WIF token. It must
not have Secrets Manager, database, GitHub, Lambda invocation, or general S3
permissions.

## 4. Start analysis

```bash
impact_analysis_arn="$(
  terraform -chdir=infra/terraform/environments/development \
    output -raw impact_analysis_state_machine_arn
)"
candidate_id="0c844cc2-d350-4487-ae17-1229e0095b7a"
correlation_id="$(uuidgen | tr '[:upper:]' '[:lower:]')"

execution_arn="$(
  aws stepfunctions start-execution \
    --region ap-southeast-2 \
    --state-machine-arn "${impact_analysis_arn}" \
    --name "orbitchat-impact-${correlation_id}" \
    --input "$(
      jq -cn \
        --arg candidate_id "${candidate_id}" \
        --arg correlation_id "${correlation_id}" \
        '{
          schemaVersion: "1.0",
          candidateId: $candidate_id,
          correlationId: $correlation_id
        }'
    )" \
    --query executionArn \
    --output text
)"
echo "${execution_arn}"
```

Verify the execution:

```bash
aws stepfunctions describe-execution \
  --region ap-southeast-2 \
  --execution-arn "${execution_arn}" \
  --query '{status:status,error:error,cause:cause}' \
  --output json
```

## 5. Verify persistence

```sql
select
  id,
  repository_snapshot_id,
  snapshot_digest,
  status,
  attempt,
  safe_error_code,
  model_calls,
  tool_calls,
  iterations,
  impact_report_id,
  completed_at
from impact_analysis_runs
where candidate_id = '0c844cc2-d350-4487-ae17-1229e0095b7a';

select
  id,
  repository_snapshot_id,
  outcome,
  risk_category,
  affected_summary,
  verification_availability,
  uncertainty,
  artifact_digest,
  revision
from impact_reports
where candidate_id = '0c844cc2-d350-4487-ae17-1229e0095b7a';
```

Expected: one succeeded run and one revision-1 affected, medium-risk report.
Repeating the workflow for the same candidate, snapshot, and specification must
not create another report.
