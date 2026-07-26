# Stage 3B implementation status

- **Status:** Implemented locally; not deployed
- **Updated:** 2026-07-26

## Scope

Stage 3B safely retrieves the trusted vendor sources registered in Stage 3A
and records immutable, digest-bound evidence. It does not run the Change
Intelligence Agent, review a specification, create a migration candidate,
analyse repository impact, or add a migration inbox.

## Implemented

- Dedicated non-root, read-only-root-filesystem vendor-fetcher container.
- Identifier-only, operator-started Standard Workflow.
- HTTPS-only exact-domain source validation.
- DNS resolution checks rejecting private, loopback, link-local, reserved,
  documentation, multicast, and metadata addresses.
- DNS-pinned TLS requests and revalidation of every bounded redirect.
- Fifteen-second request timeout, three-redirect limit, one-MiB source limit,
  and per-source media-type allowlists.
- Release metadata digest verification against the registered release digest.
- Content-addressed, KMS-encrypted S3 evidence and bundle manifests.
- Transactional ingestion state, immutable evidence metadata, stale-run
  recovery, concurrency rejection, and bounded retry attempts.
- Least-privilege task and execution roles without GitHub or model access.
- Immutable ECR image, vulnerability-scan deployment gate, structured logs,
  retention, and failure alarms.
- Reversible schema migration and operator deployment/acceptance runbook.

## Security boundary

Vendor source URLs are database-registered operator data, never workflow input.
Application SSRF controls enforce exact hosts and pin the validated public DNS
answer into the TLS connection. AWS credentials permit writes only under the
development vendor-evidence prefix.

The development database remains externally hosted. Consequently, the
vendor-fetcher security group permits PostgreSQL egress to the database
service, as existing control workloads do. Stable database destination CIDRs
are not available in current configuration, so destination-level narrowing is
a deployment follow-up rather than a claim made by this stage.

## Verification

Performed locally on 2026-07-26:

- `npm run check`: passed.
- 206 tests passed.
- Coverage: 93.40% statements, 89.58% branches, 96.59% functions, and 93.07%
  lines.
- Formatting, documentation lint, ESLint, strict TypeScript, contract
  validation, secret scan, service bundle verification, and production web
  build passed.
- `terraform fmt -check -recursive infra/terraform`: passed.
- Terraform semantic validation requires the repository-pinned Terraform
  1.15.8. The local executable is 1.4.1, so `terraform validate` was blocked by
  the intentional `required_version` constraint and must run in the deployment
  workflow.

## Expected deployed outcome

An operator can ingest the six version-pinned OrbitChat v2 evidence sources.
The release becomes `validated`, its trust state remains `draft`, and the same
release can be invoked again without duplicating evidence. Nothing new appears
in the product UI yet.

## Next slice

Stage 3C should give the isolated Change Intelligence Agent read-only,
bounded access to this evidence and produce a strict draft migration
specification. Agent output must not promote its own trust state.
