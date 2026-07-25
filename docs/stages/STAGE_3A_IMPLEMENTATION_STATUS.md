# Stage 3A implementation status

- **Status:** Implemented locally; not deployed
- **Updated:** 2026-07-26

## Scope

Stage 3A establishes the trusted vendor-intelligence data and contract
foundation. It does not fetch vendor sources, run the Change Intelligence
Agent, promote a draft specification, match repositories, or create migration
candidates.

## Implemented

- Vendor, API product, trusted source, release, and immutable specification
  revision tables with reversible migration SQL.
- Tenant-bound migration candidate and commit-bound impact report tables,
  including one-open-candidate and immutable report-revision constraints.
- Read-only runtime access to the trusted catalogue; catalogue mutation remains
  a migration/operator concern.
- Seeded synthetic OrbitChat catalogue for `@orbitchat/sdk`.
- Sources pinned to public `v1.0.0` and `v2.0.0` GitHub tags rather than a
  mutable branch.
- Byte- and SHA-256-bound v1/v2 declaration, release, changelog, and migration
  guide evidence.
- Strict schemas for evidence bundles and versioned migration specifications.
- Strict impact-report schema covering exact snapshot commit/digest, affected
  and unaffected files, symbols, retrieval reasons, verification availability,
  risk, and uncertainty without numeric confidence.
- Draft/review timestamp consistency, unique change/evidence references, and
  fail-closed evidence-reference validation.
- Exact-domain, HTTPS-only canonical URL normalization with credentials, ports,
  queries, fragments, and subdomains rejected.
- Repository UI redesign with responsive structured dependency rows preserving
  package, resolved and declared versions, dependency kind, manifest/lockfile
  provenance, exact commit, and scan state.

## Verification

Performed locally on 2026-07-26:

- `npm run check`: passed.
- 152 tests passed.
- Coverage: 93.75% statements, 89.81% branches, 100% functions, and 93.48%
  lines.
- Lint, strict TypeScript, contract validation, secret scan, service build, and
  frontend production build passed.
- Desktop and 390 px visual checks passed without document or element overflow.
- Public GitHub tags `v1.0.0` and `v2.0.0` resolve to the local tagged commits.

## Known limitations

- The SQL migration has not yet been applied to the development database.
- The vendor fetcher and its DNS/redirect SSRF controls are not implemented.
- The draft specification is fixture evidence, not an agent-produced or
  operator-reviewed trusted specification.
- No migration candidate or impact report is visible in the UI yet.

## Next slice

Stage 3B should build the isolated vendor fetcher and immutable evidence
ingestion workflow. It must fetch only registered sources, validate DNS and
every redirect, enforce content types/timeouts/byte limits, compare retrieved
digests, store encrypted artifacts, and leave all generated specifications in
the draft state.
