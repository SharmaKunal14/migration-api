# Stage 1 CI/CD

- **Deployment environment:** `development`
- **Deployment trigger:** Manual `workflow_dispatch` from `main`
- **Cloud authentication:** GitHub OIDC to the exact AWS deployment role
- **Data scope:** Synthetic Stage 1 evidence only

## Pipeline boundaries

`ci.yml` runs on pull requests and pushes to `main`. It validates the application,
contracts, secret patterns, dependency audit, production builds, Terraform
formatting, and both Terraform roots.

`deploy-development.yml` is deliberately manual. The protected GitHub
`development` environment is the deployment approval boundary. The workflow:

1. rejects revisions other than `main` and requires the confirmation text;
2. repeats the complete application verification;
3. assumes the AWS deployment role through GitHub OIDC;
4. verifies that the one-time state and ECR foundation exists;
5. builds ARM64 images with provenance and SBOM attestations;
6. reuses an existing immutable commit tag on a safe retry;
7. resolves each ARM64 child manifest separately from its deployable OCI index
   and blocks on high or critical ECR scan findings;
8. updates and runs the database migrator from Fargate;
9. creates and uploads one complete saved Terraform plan;
10. pauses for a second protected-environment approval after the plan can be
    inspected;
11. applies that exact saved plan in a fresh job with fresh OIDC credentials;
12. runs bounded public edge, deep-link, security-header, and unauthenticated API
    smoke checks; and
13. retains redacted deployment evidence for 30 days.

The pipeline never receives a database password, GitHub OAuth secret, OpenAI API
key, or long-lived AWS access key.

## Required GitHub environment

Create a GitHub environment named exactly `development`.

Configure:

- required reviewers;
- deployment branches restricted to `main`;
- no self-approval where the repository plan supports it; and
- protection against administrator bypass where the repository plan supports it.

Add these environment variables. They are identifiers or public browser
configuration, not secret credential values:

| Variable | Meaning |
| --- | --- |
| `AWS_ACCOUNT_ID` | Exact 12-digit development AWS account |
| `AWS_REGION` | Recorded development region |
| `AWS_DEPLOY_ROLE_ARN` | Bootstrap output `github_deploy_role_arn` |
| `TF_STATE_BUCKET` | Bootstrap output `state_bucket` |
| `TF_STATE_KMS_KEY_ARN` | Bootstrap output `state_kms_key_arn` |
| `OWNER` | Resource owner tag |
| `PRODUCT_DOMAIN` | GoDaddy hostname without scheme or path |
| `ACM_CERTIFICATE_ARN` | Validated `us-east-1` CloudFront certificate |
| `SUPABASE_URL` | Public project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Browser-safe publishable key, never service role |
| `SUPABASE_JWT_ISSUER` | Exact JWT issuer |
| `SUPABASE_JWT_AUDIENCE` | Exact JWT audience |
| `SUPABASE_JWKS_URL` | Exact HTTPS JWKS URL |
| `DATABASE_SECRET_ARN` | Runtime database secret ARN only |
| `DATABASE_SECRET_KMS_KEY_ARN` | Runtime secret KMS-key ARN |
| `DATABASE_MIGRATION_SECRET_ARN` | Migration database secret ARN only |
| `DATABASE_MIGRATION_SECRET_KMS_KEY_ARN` | Migration secret KMS-key ARN |
| `MIGRATION_GITHUB_WEBHOOK_SECRET_ARN` | GitHub webhook secret ARN only |
| `MIGRATION_GITHUB_WEBHOOK_SECRET_KMS_KEY_ARN` | GitHub webhook secret KMS-key ARN |
| `MIGRATION_GITHUB_APP_SECRET_ARN` | GitHub App ID/private-key secret ARN only |
| `MIGRATION_GITHUB_APP_SECRET_KMS_KEY_ARN` | GitHub App secret KMS-key ARN |
| `MIGRATION_GITHUB_APP_SLUG` | Public GitHub App URL slug, not its display name |
| `OPENAI_IDENTITY_PROVIDER_ID` | OpenAI AWS WIF provider ID |
| `OPENAI_SERVICE_ACCOUNT_ID` | Mapped OpenAI service-account ID |
| `OPENAI_MODEL` | Reviewed model alias or snapshot |
| `OPENAI_PROJECT_ALIAS` | Non-secret audit alias |

Do not add secret values merely because GitHub supports encrypted secrets. The
application retrieves database credentials directly from Secrets Manager. OpenAI
uses AWS workload identity federation.

## Required repository controls

Protect `main` and require:

- a pull request;
- at least one review;
- the `application` and `terraform` CI jobs;
- resolved review conversations;
- no force pushes; and
- no branch deletion.

Restrict workflow changes under `.github/workflows/`, `infra/terraform/`,
`workers/`, and `supabase/migrations/` to designated reviewers using repository
rules and CODEOWNERS when ownership is known.

## One-time foundation

The pipeline cannot create the role it needs to authenticate as. Before the
first run:

1. create the GitHub OIDC provider in the AWS development account;
2. apply `infra/terraform/bootstrap`;
3. apply the isolated ECR foundation in `infra/terraform/foundation`;
4. build, scan, and push both container images;
5. initialize the application state backend;
6. add the resulting NAT CIDRs to the Supabase database allowlist;
7. configure the exact OpenAI WIF role mapping; and
8. populate the GitHub `development` environment variables.

After the foundation exists, normal deployments use only the workflow.

The first full deployment is the exception for DNS: after Terraform creates
CloudFront, the workflow emits the exact `cloudfront_cname_target` as a notice.
Create the product-hostname CNAME in GoDaddy while the bounded smoke check waits.
Subsequent deployments retain the same distribution and require no manual DNS
change unless the reviewed plan replaces it.

## Deployment

From GitHub Actions:

1. select **Deploy development**;
2. choose the `main` branch;
3. select **Run workflow**;
4. enter `deploy-development`;
5. approve the first protected `development` job to build, scan, migrate, and
   prepare the plan;
6. inspect `terraform-plan.txt` in the preparation evidence artifact;
7. approve the second protected `development` job to apply that exact plan; and
8. on the first deployment, add the emitted CloudFront CNAME target in GoDaddy
   before the 20-minute DNS wait expires; and
9. retain the deployment evidence artifact and complete the manual authenticated
   and security-negative checks.

Failure before the complete Terraform apply leaves the currently deployed
application unchanged, although a new immutable image or migrator task revision
may exist. A migration failure blocks the application apply.

## Rollback

Re-run the workflow from a reviewed revert commit. ECR images are selected by
immutable source revision and Terraform updates the web assets, Lambda bundles,
and ECS task definition accordingly.

Do not automatically execute `0001_stage_1.down.sql`. Schema rollback is
destructive and requires an explicit data-impact review.
