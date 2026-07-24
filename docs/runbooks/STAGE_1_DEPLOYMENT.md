# Stage 1 development deployment

- **Status:** Requires recorded provider decisions and credentials
- **Scope:** Synthetic data only

## Preconditions

The deployment must not begin until these values are recorded:

- AWS and Supabase regions, with latency and data-processing rationale;
- OpenAI project/data region and actual retention controls;
- development product domain, Route 53 zone, and `us-east-1` certificate;
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

## Terraform

Use Terraform 1.15.8. Bootstrap state first. Initialize the application stack
with an uncommitted `backend.hcl` containing the state bucket and KMS key
identifiers. Store non-secret environment values in an approved deployment
variable store, not in a committed `terraform.tfvars`.

Review the saved plan before apply. A successful apply is not Stage 1
acceptance; complete the security-negative and end-to-end evidence in the
acceptance checklist.

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
