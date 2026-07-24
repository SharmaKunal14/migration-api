# Stage 1 implementation status

- **Status:** Local implementation baseline complete; cloud acceptance blocked
- **Updated:** 2026-07-24

## Implemented

- Strict TypeScript application and pinned npm lockfile.
- Authenticated React/Vite UI for login, organisation creation, synthetic run,
  persisted timeline, structured evidence, and uncertainty.
- Tenant-scoped API, immutable audit writes, strict request validation, and safe
  error envelope.
- Atomic demo-run, idempotency, and outbox transaction.
- Leased outbox dispatcher with deterministic Standard Workflow execution name.
- Identifier-only workflow and isolated, non-root, read-only Fargate agent.
- OpenAI Responses gateway with AWS WIF, strict schemas, disabled hosted tools,
  explicit budgets, and classified terminal failures.
- KMS-encrypted, SHA-256-validated S3 result ingestion.
- Reversible Stage 1 PostgreSQL migration.
- Dedicated one-off migration image and least-privilege Fargate task definition.
- Terraform for state bootstrap, edge, WAF, VPC, inspected agent egress, private
  endpoints, API, Lambda, ECS, Step Functions, storage, IAM, logs, metrics, and
  alarms.
- CI application, secret-pattern, workflow, dependency, and Terraform validation
  gates.
- Protected manual development deployment workflow with AWS OIDC, immutable
  image digests, SBOM/provenance, ECR scan gates, Fargate migration, saved-plan
  review approval and apply, public smoke checks, and retained evidence.

## Known, not assumed

- Stage 0 written artifacts exist and remain authoritative.
- The local machine has Node.js 22.14.0 and Terraform 1.4.1.
- Application typecheck, lint, contract validation, unit tests, coverage, and
  build can run locally.
- No AWS, Supabase, domain, or OpenAI project configuration was available in the
  implementation environment.

## Explicitly unresolved

- AWS and Supabase region decisions.
- OpenAI project region, retention/data controls, provider ID, service account,
  and live WIF mapping.
- Product domain, certificate, and Route 53 ownership.
- Supabase project, GitHub OAuth configuration, database roles, network
  allowlist, and migration execution.
- ECR image digest, Terraform plan/apply, and live smoke evidence.
- Stage 0 interview/design-partner evidence claimed by the user but not present
  in the repository.

## Exit assessment

Stage 1 has not passed. Local implementation is not equivalent to the required
deployed cloud path. Do not check the Stage 1 acceptance items until the actual
provider configuration, negative tests, deployment evidence, and end-to-end run
are recorded.

## Local verification evidence

Performed on 2026-07-24:

- `npm run check`: passed, including formatting, Markdown linting, ESLint,
  TypeScript, five JSON contracts, 32 tests, coverage, and production builds.
- Coverage: 98.36% statements, 93.54% branches, 100% functions, and 98.24%
  lines for the configured boundary packages.
- `npm audit --audit-level=high`: zero known vulnerabilities.
- `npm audit --omit=dev --audit-level=high`: zero known vulnerabilities.
- Terraform 1.10.5 format check: passed.
- Terraform 1.10.5 bootstrap and development validation: valid with zero
  errors and zero warnings.
- Targeted repository secret-pattern scan: no matches.
- GitHub Actions validation with actionlint 1.7.12: passed.
- CycloneDX application SBOM generation and schema smoke check: passed.

Docker image builds, container scans, SBOM generation, Terraform security
scanners, cloud plans, migration execution, and live WIF/end-to-end checks were
not performed. Docker was unavailable, the optional scanners were not installed,
and provider configuration and credentials were not supplied.
