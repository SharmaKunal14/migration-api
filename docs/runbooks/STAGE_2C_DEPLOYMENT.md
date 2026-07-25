# Stage 2C deployment

Stage 2C adds a third immutable container image, a database migration, a
repository-scan workflow, and a dedicated source-fetcher network trust zone.
Do not run the application deployment until the source-fetcher ECR repository
exists.

## 1. Apply the container foundation

Use Terraform 1.15.8 and the same foundation backend configuration documented
in `STAGE_1_DEPLOYMENT.md`. Create and inspect a saved plan:

```bash
terraform -chdir=infra/terraform/foundation plan \
  -input=false \
  -var="aws_region=ap-southeast-2" \
  -var="owner=KunalSharma" \
  -out=stage-2c-foundation.tfplan
terraform -chdir=infra/terraform/foundation show \
  -no-color \
  stage-2c-foundation.tfplan
```

For an existing Stage 2B environment, the plan must add only:

- `migration-api-development-source-fetcher` ECR repository;
- its immutable-image lifecycle policy.

Apply that exact reviewed plan:

```bash
terraform -chdir=infra/terraform/foundation apply \
  -input=false \
  stage-2c-foundation.tfplan
```

## 2. Run the protected development deployment

Commit and push the Stage 2C revision, then run **Deploy development** with the
confirmation value `deploy-development`. The workflow:

1. builds and vulnerability-scans the source-fetcher image;
2. runs migration `0003_stage_2c.sql`;
3. produces a complete saved Terraform plan;
4. pauses for the protected apply approval;
5. applies the exact saved plan.

Review the plan for the source-fetcher task and roles, scan-control Lambda,
repository-scan state machine, source-fetcher subnets and routes, Lambda VPC
endpoint, log groups, and alarms. Investigate any unrelated replacement or
destruction.

## 3. Verify the product path

Open the GitHub settings page and select **Scan dependencies** for a selected
repository. A successful scan must show:

- status `succeeded`;
- an exact 40-character commit SHA;
- declared dependency ranges;
- resolved versions only when supported by `package-lock.json`.

The source-fetcher log must not contain an installation token or repository
source. Confirm the repository-scan workflow has a successful execution and
the scan-control alarms remain `OK`.
