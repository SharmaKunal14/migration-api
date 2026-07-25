# Stage 2D acceptance

Stage 2D closes the Stage 2 security and operational exit gates. It does not
add repository mutation or vendor intelligence. Repository contents remain
untrusted input and are never executed.

## 1. Deploy the hardening revision

Commit and push the Stage 2D revision, then run **Deploy development** with the
confirmation value `deploy-development`. Review the saved Terraform plan. The
only expected infrastructure addition is:

- the `migration-api-development-repository-acquisition-failure` CloudWatch
  log metric filter and alarm.

There is no database migration or foundation change.

## 2. Confirm the successful inventory path

Scan a selected repository from the GitHub settings page. Confirm:

- the scan succeeds at an exact 40-character commit;
- declared ranges and supported lockfile versions are displayed;
- the Step Functions execution succeeds;
- source-fetcher logs contain no repository content, GitHub token, or App
  private key.

## 3. Confirm fail-closed lifecycle behavior

Use a disposable GitHub App installation or repository selection for these
checks. Do not disrupt an installation shared with another environment.

1. Deselect a repository in the GitHub App settings.
2. Wait for the `installation_repositories` webhook to reconcile.
3. Confirm a new scan request is rejected with
   `REPOSITORY_SCAN_NOT_ALLOWED`.
4. Suspend or uninstall the disposable installation.
5. Confirm reconciliation marks it `suspended` or `removed`.
6. Confirm a new scan is rejected and no repository token is issued.

Restore the disposable installation only after recording the evidence.

## 4. Confirm webhook and archive controls

The automated test suite must demonstrate:

- forged webhook signatures are rejected before enqueue;
- processed delivery IDs do not repeat reconciliation;
- traversal, duplicate paths, links, special files, Git LFS pointers,
  submodules, invalid archives, and configured size/count limits fail safely;
- unselected, disabled, archived, suspended, and removed repositories are not
  scannable.

Run:

```bash
npm run check
```

## 5. Confirm operational health

Inspect the GitHub webhook queue and DLQ without receiving or deleting
messages. Both visible-message counts must be zero after the reconciliation
window. Confirm these alarms are `OK`:

- `migration-api-development-github-webhook-dlq`;
- `migration-api-development-github-webhook-backlog-age`;
- `migration-api-development-github-reconciliation-failure`;
- `migration-api-development-repository-scan-workflow-failures`;
- `migration-api-development-repository-acquisition-failure`.

The acquisition alarm can initially show `INSUFFICIENT_DATA`; after deployment,
its missing-data policy must settle to `OK`.

## Exit decision

Stage 2 is complete only when the successful inventory path and each
fail-closed lifecycle check have live evidence. Local tests and a successful
Terraform apply are necessary but are not sufficient.
