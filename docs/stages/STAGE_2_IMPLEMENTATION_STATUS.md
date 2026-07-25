# Stage 2 implementation status

- **Status:** Secure foundation implemented; end-to-end GitHub inventory incomplete
- **Updated:** 2026-07-25

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
- Service build, deployment-input, Terraform, secret-scanning, and CI wiring
  for the new webhook and broker services.

## Explicitly incomplete

- Authenticated GitHub installation-link creation and callback consumption.
- API-to-token-broker invocation wiring. The pinned AWS Lambda client dependency
  was not approved for installation in the implementation environment.
- Webhook reconciliation consumer and current-state reconciliation.
- Trusted source-fetcher image and safe archive acquisition.
- Repository scan Step Functions workflow and dependency persistence.
- Repository onboarding and inventory UI.
- Live GitHub App registration, secrets, callbacks, webhook delivery, and
  selected-repository evidence.

## Verification

Performed locally on 2026-07-25:

- `npm run check`: passed.
- 88 tests passed.
- Coverage: 96.1% statements, 93.4% branches, 100% functions, and 95.91%
  lines for configured boundary packages.
- Secret-pattern scan: passed.
- Production service and frontend builds: passed.
- Terraform 1.15.8 formatting: passed.
- Terraform 1.15.8 development configuration validation: passed.

No live AWS, Supabase, or GitHub deployment was performed.

## Exit assessment

Stage 2 has not passed. The current work is a security and data-model foundation,
not a working repository onboarding flow. Do not mark Stage 2 complete until the
installation callback, reconciliation, source acquisition, scan workflow, UI,
negative security tests, and live selected-repository evidence all pass.
