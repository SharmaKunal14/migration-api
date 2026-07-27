# Stage 1 CI/CD

- **Deployment environment:** `development`
- **Deployment trigger:** Manual `workflow_dispatch` from `main`
- **Cloud authentication:** GitHub OIDC to the exact AWS deployment role
- **Data scope:** Synthetic Stage 1 evidence only

## Pipeline boundaries

`ci.yml` runs on pull requests and pushes to `main`. It validates the application,
contracts, secret patterns, dependency audit, production builds, Terraform
formatting, and both Terraform roots. On a successful `main` build it assumes a
separate artifact-publisher AWS role, publishes immutable images, gates their
vulnerability scans, and signs one manifest containing the exact image digests
and deployment-payload digest with a dedicated asymmetric AWS KMS key. This
works for private repositories without GitHub Enterprise Cloud.
An explicit deny prevents the broader application-infrastructure role from
mutating that key or granting itself signing access.

`deploy-development.yml` is deliberately manual. The protected GitHub
`development` environment is the deployment approval boundary. The workflow:

1. rejects revisions other than `main` and requires the confirmation text;
2. selects one successful `CI` run for the exact commit SHA;
3. verifies the manifest's ECDSA signature with the exact bootstrap-managed KMS
   key, then checks its repository, `refs/heads/main`, exact source digest, CI
   run, payload digest, and public configuration;
4. assumes the AWS deployment role through GitHub OIDC;
5. verifies that the signed digests exist in the expected ECR repositories and
   still pass the high/critical vulnerability gate;
6. compares the desired migrator content digest with the KMS-encrypted
   last-successful marker;
7. updates and runs the database migrator from Fargate only when those digests
   differ, recording the new marker only after a successful task;
8. creates and uploads one complete saved Terraform plan;
9. pauses for a second protected-environment approval after the plan can be
    inspected;
10. applies that exact saved plan in a fresh job with fresh OIDC credentials;
11. runs bounded public edge, deep-link, security-header, and unauthenticated API
    smoke checks; and
12. retains redacted deployment evidence for 30 days.

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
| `PROMOTION_SIGNING_KEY_ARN` | Bootstrap output `promotion_signing_key_arn` |
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

## Required repository variables for CI publication

The automatic `main` publisher does not enter the protected deployment
environment. Configure these as repository or organisation variables:

| Variable | Meaning |
| --- | --- |
| `AWS_ACCOUNT_ID` | Same exact account ID used by the development environment |
| `AWS_REGION` | Same recorded development region |
| `AWS_CI_ARTIFACT_ROLE_ARN` | Bootstrap output `github_ci_artifacts_role_arn` |
| `PROMOTION_SIGNING_KEY_ARN` | Bootstrap output `promotion_signing_key_arn` |
| `SUPABASE_URL` | Same public URL used by the protected environment |
| `SUPABASE_PUBLISHABLE_KEY` | Same browser-safe publishable key used by the protected environment |

Add `PROMOTION_SIGNING_KEY_ARN` to the protected `development` environment as
well as the repository variables. The deployment compares a digest of the CI web
configuration with the protected environment values and fails closed on drift.
These values are identifiers or deliberately public configuration, not service
credentials. Do not expose database passwords, GitHub App secrets, or OpenAI
credentials as repository variables.

## Required repository controls

Protect `main` and require:

- a pull request;
- at least one review;
- the `application` and `terraform` pull-request CI jobs;
- resolved review conversations;
- no force pushes; and
- no branch deletion.

`Publish KMS-signed deployment artifacts` runs only after a commit reaches
`main`.
The deployment workflow independently requires that exact commit's complete `CI`
run, including the publish job, to have succeeded before it accepts any
artifact.

Restrict workflow changes under `.github/workflows/`, `infra/terraform/`,
`workers/`, and `supabase/migrations/` to designated reviewers using repository
rules and CODEOWNERS when ownership is known.

## One-time foundation

The pipeline cannot create the role it needs to authenticate as. Before the
first run:

1. create the GitHub OIDC provider in the AWS development account;
2. apply `infra/terraform/bootstrap`, including the main-branch
   `github_ci_artifacts` role;
3. apply the isolated ECR foundation in `infra/terraform/foundation`;
4. configure the required repository variables and let the successful `main` CI
   run build, scan, and sign the promotion manifest;
5. initialize the application state backend;
6. add the resulting NAT CIDRs to the Supabase database allowlist;
7. configure the exact OpenAI WIF role mapping; and
8. populate the GitHub `development` environment variables.

After the foundation exists, normal deployments use only the workflow.

AWS KMS does not automatically rotate asymmetric signing keys. Rotate this key
manually by adding a new versioned Terraform key, granting the same bounded
sign/verify permissions, updating both GitHub variable scopes to its exact ARN,
and allowing a new `main` CI run to produce a promotion before retiring the old
key. Never repoint only the alias: deployment deliberately trusts the immutable
key ARN.

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
5. approve the first protected `development` job to verify the CI promotion,
   conditionally migrate, and prepare the plan;
6. inspect `terraform-plan.txt` in the preparation evidence artifact;
7. approve the second protected `development` job to apply that exact plan; and
8. on the first deployment, add the emitted CloudFront CNAME target in GoDaddy
   before the 20-minute DNS wait expires; and
9. retain the deployment evidence artifact and complete the manual authenticated
   and security-negative checks.

Failure before the complete Terraform apply leaves the currently deployed
application unchanged, although CI may already have published immutable images.
A migration failure blocks the application apply and does not advance the
last-successful content marker. An application-only revision whose migrator
content digest is unchanged skips the targeted migrator update and Fargate task.
The deployment role has account-level `ssm:DescribeParameters` because AWS does
not support resource scoping for that metadata API; reading or writing parameter
values remains restricted to the exact migrator-success parameter ARN.

## Rollback

Re-run the workflow from a reviewed revert commit. ECR images are selected by
immutable source revision and Terraform updates the web assets, Lambda bundles,
and ECS task definition accordingly.

Do not automatically execute `0001_stage_1.down.sql`. Schema rollback is
destructive and requires an explicit data-impact review.
