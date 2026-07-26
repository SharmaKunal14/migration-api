# Stage 3D implementation status

- **Status:** Implemented locally; not deployed
- **Updated:** 2026-07-26

## Scope

Stage 3D adds the human trust transition between a Stage 3C draft and customer
migration candidates. It does not inspect repository source, produce an impact
report, modify code, approve a migration, or add the migration inbox UI.

## Implemented

- Explicit platform-operator allowlist, separate from customer organisation
  roles.
- Operator-only draft discovery and idempotent review API.
- Database-enforced promotion that permits only trust metadata to change.
- Atomic promotion of validated vendor evidence and the migration
  specification to reviewed state.
- Platform audit events for every successful promotion.
- Semver-aware matching that prefers exact lockfile versions.
- Conservative declared-range matching when no resolved version exists.
- Idempotent open-candidate creation and superseding of stale specifications.
- Candidate reconciliation when a specification is reviewed and when a later
  repository scan completes.
- Tenant-scoped read API for open migration candidates.
- Bounded reconciliation and safe failure when the synchronous limit is
  exceeded.

## Security boundary

Customer owners and administrators are not platform operators. Operator access
must be provisioned explicitly in PostgreSQL. The runtime database role cannot
directly promote specifications or mutate candidates; it can execute only
security-definer functions that revalidate operator status, evidence trust,
repository ownership, current-snapshot provenance, GitHub installation state,
and specification trust.

The review function rejects any change to draft content other than server-built
trust metadata. Candidate matching never accepts a package name from the API,
and candidate foreign keys remain tenant-bound.

## Expected deployed outcome

Reviewing the successful OrbitChat draft changes its trust state to `reviewed`.
The existing repository snapshot for
`SharmaKunal14/orbitchat-migration-fixture`, which resolves
`@orbitchat/sdk` to `1.0.0`, matches the reviewed `1.x` to `2.0.0`
specification and receives one open migration candidate.

The candidate is available through the authenticated API and PostgreSQL. The
customer-facing migration inbox arrives in Stage 3F.

## Next slice

Stage 3E should add the bounded, read-only Impact Analysis Agent and produce an
immutable report tied to the candidate's exact repository snapshot.
