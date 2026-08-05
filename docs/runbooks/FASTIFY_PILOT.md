# Fastify dependency pilot

## Purpose

Use a real, selected GitHub repository to validate the complete package monitoring
path. The pilot repository intentionally installs Fastify `4.29.1`. The trusted npm
source provides the current Fastify 5 target, which exercises the official major-version
migration path without waiting for a future release.

The pilot backfill is not a general manual release editor. An active platform operator
authorizes it, while the server derives:

- the source version from the latest available scan of selected repositories;
- the target version from the resolved npm package mapping;
- immutable release evidence from a successful fixed-origin npm poll;
- the trusted API product and source from the reviewed source catalogue.

The operation rejects missing, current, or ambiguous installed versions. The request
cannot include a version or source URL.

## Repository

The local pilot is at:

`/Users/kunalsharma/Fun/project/dependency-pilot-fastify`

It was generated with the official Fastify scaffold and includes a committed npm
lockfile. Before registering it, publish it to a GitHub account covered by the existing
GitHub App installation.

## Deployment

1. Commit and push the `migration-api` changes through the normal CI/CD pipeline.
2. Confirm migration `0032_pilot_current_release_backfill.sql` completed.
3. Publish the Fastify pilot repository to GitHub.
4. In Upversion, select that repository and run a repository scan.
5. Confirm the dependency view reports Fastify `4.29.1` from `package-lock.json`.
6. In **Platform operator → Update sources**, confirm the exact npm registry source for
   Fastify if it is not already trusted.
7. Wait for at least one successful release poll for the trusted Fastify source. Use a
   manual invocation of the existing poller only when you do not want to wait for its
   schedule.
8. Open the **Confirmed** source filter and select **Ingest current release** on the
   Fastify card.

## Verification

The UI should report `4.29.1 → <current Fastify 5 version>` queued for
migration-guidance analysis. Verify the database state with read-only queries:

```sql
select
  mapping.package_name,
  detection.source_version,
  detection.version as target_version,
  detection.status,
  detection.vendor_release_id,
  detection.evidence_digest
from package_release_detections as detection
join package_source_mappings as mapping
  on mapping.api_product_id = detection.api_product_id
where mapping.package_name = 'fastify'
order by detection.first_detected_at desc;
```

```sql
select
  event.action,
  event.resource_id,
  event.metadata,
  event.created_at
from platform_audit_events as event
where event.action = 'package_release.pilot_backfill_requested'
order by event.created_at desc;
```

Then verify, in order:

1. one `release_intelligence_outbox` row exists for the vendor release;
2. the vendor ingestion and change-intelligence workflows succeed;
3. one draft migration specification appears in the operator review queue;
4. reviewing that specification creates one migration candidate for the pilot repo;
5. the eligible organisation reviewer receives one in-app notification;
6. read-only impact analysis completes before any mutation is approved.

Do not approve patch generation until the generated migration guidance and exact
repository snapshot have been reviewed.
