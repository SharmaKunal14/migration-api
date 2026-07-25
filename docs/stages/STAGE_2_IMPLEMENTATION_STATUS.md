# Stage 2 implementation status

- **Status:** Stage 2C live; Stage 2D exit hardening implemented locally
- **Updated:** 2026-07-26

## Implemented

- Reversible PostgreSQL schema for GitHub installations, one-time link state,
  repositories, webhook deliveries, scans, snapshots, and dependency
  observations.
- Owner/admin installation-management authorization and role-scoped repository
  read/scan authorization.
- Strict identifier-only scan workflow and bounded webhook-envelope contracts.
- Raw-body GitHub webhook Lambda with HMAC-SHA256 verification before parsing,
  strict body/event limits, canonical base64 validation, and safe errors.
- Encrypted SQS webhook queue, DLQ, least-privilege enqueue IAM, retention, and
  alarms.
- Isolated GitHub token-broker Lambda. Only this service reads the GitHub App
  private key.
- Short-lived GitHub App JWT creation and fixed-origin, timeout-bounded GitHub
  API calls.
- Repository read-token issuance restricted to one selected, enabled,
  non-archived repository with an active installation and active scan.
- Bounded npm `package.json` and npm lockfile inventory with path, file-count,
  byte, schema, and version limits.
- Tenant-scoped APIs for listing installations, repositories, and dependency
  observations.
- Authenticated, one-time GitHub installation linking with broker verification.
- SQS-driven GitHub reconciler with delivery-ID deduplication, payload-digest
  verification, partial-batch retries, lifecycle handling, and a DLQ.
- Broker-owned, read-only installation-token use for bounded pagination of up
  to 500 selected repositories. Tokens never leave the broker response boundary.
- Transactional repository upsert, deselection, archival policy, installation
  lifecycle updates, and reconciliation timestamps.
- Repository reconciliation status and selected metadata in the onboarding UI.
- Idempotent, role-authorized repository scan API backed by a transactional
  repository-scan outbox.
- Standard Step Functions scan workflow with explicit start, trusted Fargate
  acquisition, evidence ingestion, and terminal failure handling.
- Non-root, read-only-root source-fetcher container with a dedicated writable
  workspace, bounded concurrency, immutable image digest, and vulnerability
  scan gate.
- One-repository, contents-read token issuance directly to the source fetcher;
  tokens remain in memory and never enter workflow state or S3 evidence.
- Exact default-branch commit resolution and fixed-origin GitHub/codeload
  requests with redirect and response-size validation.
- Streaming tar validation and normalization with compressed, expanded,
  per-file, path, file-count, symlink, Git LFS, and submodule controls.
- Strict npm manifest/package-lock inventory and transactional snapshot and
  dependency-observation persistence.
- Dedicated source-fetcher network trust zone allowing only GitHub API and
  codeload TLS egress plus private AWS endpoints.
- Repository scan status, exact commit, safe unsupported outcome, and detected
  dependencies in the onboarding UI.
- Service build, deployment-input, Terraform, secret-scanning, and CI wiring
  for the new webhook and broker services.
- Shared fail-closed scan eligibility policy covering repository selection,
  enablement, archival, and installation lifecycle state.
- A source-acquisition failure metric and alarm for handled failures that do
  not fail the Step Functions execution.
- Stage 2 exit runbook covering live lifecycle, webhook, archive, queue, DLQ,
  alarm, and log-redaction evidence.

## Explicitly incomplete

- Deployment of the Stage 2D acquisition-failure alarm.
- Live deselection and removal/suspension evidence proving that new scans and
  token issuance fail closed.

## Verification

Performed locally on 2026-07-26:

- `npm run check`: passed.
- 143 tests passed.
- Coverage: 94.01% statements, 90.60% branches, 100% functions, and 93.81%
  lines for configured boundary packages, including archive acquisition.
- Secret-pattern scan: passed.
- Production service and frontend builds: passed.
- Terraform formatting: passed.
- Terraform 1.15.8 development and foundation validation: passed using
  checksum-verified HashiCorp binaries and locked providers.

Live installation linking, Stage 2B repository reconciliation, and Stage 2C
exact-commit dependency inventory were confirmed in development.

Read-only operational inspection on 2026-07-26 found the main webhook queue
empty and two visible DLQ messages. Reconciler logs classify both delivery IDs
as `GITHUB_INSTALLATION_NOT_LINKED` events received before the installation was
linked. Existing Stage 2 alarms were `OK` except the DLQ alarm, which correctly
remained `ALARM` while those messages were retained. The operator explicitly
accepted retaining and ignoring these two classified messages; they require no
redrive or deletion.

## Exit assessment

Stage 2 has not passed its complete live exit gate. Exact-commit dependency
evidence is live, but Stage 2D must be deployed and the fail-closed lifecycle
checks and Stage 2B queue/DLQ state must be recorded before Stage 2 is marked
complete. The two retained DLQ events are classified and accepted, so they are
not a remaining Stage 2 blocker.
