# Stage 2 implementation status

- **Status:** Stage 2A live; Stage 2B reconciliation implemented but not yet deployed
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
- Service build, deployment-input, Terraform, secret-scanning, and CI wiring
  for the new webhook and broker services.

## Explicitly incomplete

- Trusted source-fetcher image and safe archive acquisition.
- Repository scan Step Functions workflow and dependency persistence.
- Live Stage 2B webhook reconciliation and selected-repository evidence.

## Verification

Performed locally on 2026-07-26:

- `npm run check`: passed.
- 121 tests passed.
- Coverage: 96.47% statements, 93.81% branches, 100% functions, and 96.31%
  lines for configured boundary packages.
- Secret-pattern scan: passed.
- Production service and frontend builds: passed.
- Terraform 1.15.8 formatting: passed.
- Terraform 1.15.8 development configuration validation: passed.

Live Stage 2A installation linking was confirmed in development. Stage 2B has
not yet been deployed.

## Exit assessment

Stage 2 has not passed. The current work is a security and data-model foundation,
not a working repository onboarding flow. Do not mark Stage 2 complete until the
installation callback, reconciliation, source acquisition, scan workflow, UI,
negative security tests, and live selected-repository evidence all pass.
