# Stage 1 development deployment

- **Status:** Requires recorded provider decisions and credentials
- **Scope:** Synthetic data only

## Preconditions

The deployment must not begin until these values are recorded:

- AWS and Supabase regions, with latency and data-processing rationale;
- OpenAI project/data region and actual retention controls;
- development product domain, GoDaddy DNS access, and `us-east-1` certificate;
- exact OpenAI WIF provider and service-account mapping;
- separate runtime and migration database roles and secrets;
- GitHub deployment repository/environment.

Do not place database passwords or OAuth client secrets in `tfvars`, Terraform
state, GitHub variables, Lambda environment variables, or command output.

## Build and evidence

```text
npm ci --ignore-scripts
npm run check
docker build --platform linux/arm64 -f workers/agent/Dockerfile -t <ecr>:<commit> .
docker build --platform linux/arm64 -f workers/database-migrator/Dockerfile -t <migrator-ecr>:<commit> .
```

Scan the image and generate an SBOM before pushing. Resolve the pushed ECR image
to its immutable `sha256:` digest and supply only that digest to Terraform. Do
the same independently for the migration image.

## Provider-side configuration

1. Create the development Supabase project and exact GitHub OAuth callbacks.
2. Create `app_runtime`, `app_readonly`, and `app_migrator` database roles.
3. Store the runtime and migration credentials in separate Secrets Manager
   secrets encrypted by customer-managed KMS keys.
4. Enable AWS outbound identity federation.
5. Decode a development AWS OIDC subject token locally and verify `iss`, `aud`,
   `sub`, and expiry without sending it to another service.
6. Configure the OpenAI workload-identity provider and map the exact agent task
   role ARN with only `api.model.request`.
7. Record the OpenAI project retention/data-residency configuration.
8. Request the product certificate in `us-east-1`, add its DNS-validation CNAME
   in GoDaddy, and wait for ACM status `ISSUED`.

## Terraform

Use Terraform 1.15.8. Bootstrap state first.

### One-time ECR foundation

The two ECR repositories must exist before the deployment workflow can build
and push images. They are owned by the isolated `infra/terraform/foundation`
root so its plan requires only the recorded AWS region and owner tag, not image
digests or application-provider configuration.

First confirm neither repository already exists:

```bash
aws ecr describe-repositories \
  --region ap-southeast-2 \
  --repository-names migration-api-development-agent
aws ecr describe-repositories \
  --region ap-southeast-2 \
  --repository-names migration-api-development-database-migrator
```

`RepositoryNotFoundException` is expected on the first deployment. If either
repository exists, stop: determine its Terraform ownership and encryption
configuration before importing or replacing it.

Initialize the foundation in a dedicated Terraform data directory:

```bash
export AWS_REGION="<recorded-development-region>"
export OWNER="<recorded-owner-tag>"
export TF_STATE_BUCKET="<bootstrap-state_bucket-output>"
export TF_STATE_KMS_KEY_ARN="<bootstrap-state_kms_key_arn-output>"
export TF_DATA_DIR="/tmp/migration-api-foundation-terraform-data"
mkdir -p "${TF_DATA_DIR}"
terraform -chdir=infra/terraform/foundation init \
  -reconfigure \
  -input=false \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=development/foundation.tfstate" \
  -backend-config="region=${AWS_REGION}" \
  -backend-config="encrypt=true" \
  -backend-config="kms_key_id=${TF_STATE_KMS_KEY_ARN}" \
  -backend-config="use_lockfile=true"
```

Create, inspect, and apply a saved foundation plan:

```bash
terraform -chdir=infra/terraform/foundation validate
terraform -chdir=infra/terraform/foundation plan \
  -input=false \
  -var="aws_region=${AWS_REGION}" \
  -var="owner=${OWNER}" \
  -out=foundation.tfplan
terraform -chdir=infra/terraform/foundation show \
  -no-color \
  foundation.tfplan
terraform -chdir=infra/terraform/foundation apply \
  -input=false \
  foundation.tfplan
terraform -chdir=infra/terraform/foundation output
```

The reviewed plan must contain only the dedicated container-image KMS key and
alias, the two immutable ECR repositories, and their lifecycle policies.
Do not use `-auto-approve`.

After applying the foundation, build and push both images as documented above,
wait for their vulnerability scans, and record their immutable `sha256:`
digests.

### Application stack

Initialize the application stack in its separate Terraform data directory.
Store non-secret environment values in an approved deployment variable store,
not in a committed `terraform.tfvars`.

```bash
export TF_DATA_DIR="/tmp/migration-api-development-terraform-data"
mkdir -p "${TF_DATA_DIR}"
terraform -chdir=infra/terraform/environments/development init \
  -reconfigure \
  -input=false \
  -backend-config="bucket=${TF_STATE_BUCKET}" \
  -backend-config="key=development/application.tfstate" \
  -backend-config="region=${AWS_REGION}" \
  -backend-config="encrypt=true" \
  -backend-config="kms_key_id=${TF_STATE_KMS_KEY_ARN}" \
  -backend-config="use_lockfile=true"
```

Review the saved plan before apply. A successful apply is not Stage 1
acceptance; complete the security-negative and end-to-end evidence in the
acceptance checklist.

Terraform creates the CloudFront distribution but does not manage GoDaddy DNS.
On the first full apply, read the `cloudfront_cname_target` output and create
this record in GoDaddy:

```text
Type:  CNAME
Name:  migration-api
Value: <cloudfront_cname_target>
```

Do not proxy, forward, or add a second A/AAAA record for the same hostname. The
deployment smoke check waits up to 20 minutes for the exact CNAME before failing.
Keep the ACM validation CNAME permanently so certificate renewal remains
automatic.

After the task definition exists, run the database migrator as a one-off Fargate
task in the control subnets with the control security group. Wait for a zero exit
code before deploying Lambdas that require the new schema. A failed task blocks
deployment; do not run migrations from a hosted runner or relax Supabase network
restrictions.

## Repeat deployments through CI/CD

After the one-time state, ECR, network, database, and WIF foundation is complete,
use the protected `Deploy development` GitHub Actions workflow. Configure the
exact environment variables and repository controls in [CI_CD.md](CI_CD.md).

The workflow is manual by design and accepts only `main`. It repeats verification,
uses short-lived GitHub OIDC credentials, builds immutable commit-tagged images,
blocks on ECR high or critical findings, runs the migration task, applies a saved
Terraform plan, and performs public smoke checks. An environment approval is not
a substitute for reviewing changes before they reach `main`.

## Post-deployment checks

- HTTP redirects to HTTPS.
- GoDaddy resolves the product hostname as the exact CloudFront CNAME.
- A deep UI link returns the app shell.
- `/api/*` failures remain JSON failures.
- Inline script and unapproved connections are blocked by CSP.
- An unapproved public hostname is denied from the agent subnet.
- Wrong WIF role/audience and removed mapping fail closed.
- Repeated identical demo requests return one run.
- The full UI → outbox → Standard Workflow → Fargate → OpenAI → S3/PostgreSQL
  path succeeds once with recorded IDs and digests.
- CloudWatch samples contain no JWT, source, prompt, token, key, database URL,
  or presigned URL.
