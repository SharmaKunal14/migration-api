# ADR-0002: Use Supabase Auth and PostgreSQL as authoritative state

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Platform engineering

## Context

The domain contains organisations, memberships, installations, repositories,
dependency observations, candidates, immutable approvals, attempts, artifacts,
and pull requests. These records have relational constraints and must often be
updated atomically.

Known:

- Lambda can create connection storms against PostgreSQL without pooling and
  concurrency bounds.
- Supabase transaction pooling is intended for transient/serverless database
  clients and does not support prepared statements.
- Supabase network restrictions cover PostgreSQL and its pooler, not Auth or
  other HTTPS APIs.
- User-editable JWT metadata is not an authorization source.

Assumed:

- AWS and Supabase can be placed in nearby supported regions.
- Fixed AWS egress IPs are acceptable for database network allowlisting.
- Standard PostgreSQL is sufficient for the initial product.

## Decision

Use Supabase Auth for application identity and Supabase PostgreSQL as the
authoritative business database.

Backend services connect using a least-privilege PostgreSQL role. Lambda uses
the Supabase transaction pooler over TLS with certificate verification, a very
small per-runtime client pool, disabled named prepared statements, short
statement/lock/transaction timeouts, and reserved concurrency.

Use separate roles:

- `app_owner`: schema owner; never a runtime credential.
- `app_migrator`: applies reviewed schema migrations.
- `app_runtime`: bounded application CRUD.
- `app_readonly`: approved operational queries.

Core tables are not directly writable from the browser. RLS is enabled on any
table exposed through Supabase APIs as defense in depth. Server handlers still
load current membership from PostgreSQL and scope resource queries by both
organisation and resource ID.

Schema migrations run from a one-off AWS task with the migration credential.
They do not temporarily remove database network restrictions for hosted CI.

## Transaction and delivery rules

- Approval, migration-run creation, and outbox insertion are one PostgreSQL
  transaction.
- Unique constraints enforce externally meaningful idempotency keys.
- Workers use leases and `FOR UPDATE SKIP LOCKED` where appropriate.
- Optimistic versions protect mutable aggregates.
- Source, patches, and logs live in S3; PostgreSQL stores references and
  digests.

## Consequences

Benefits:

- Relational integrity matches the domain.
- Supabase provides managed Auth and PostgreSQL without introducing a second
  application database.
- Repository-owned SQL and standard PostgreSQL keep a credible RDS/Aurora exit.

Costs and limitations:

- AWS-to-Supabase traffic crosses provider boundaries.
- Pool saturation and provider outages must be explicit failure modes.
- Database network restrictions do not make bad credentials harmless.
- Transaction-pooler restrictions influence driver configuration.

## Rejected alternatives

- **DynamoDB as primary state:** forces relational workflow and audit queries
  into denormalized access patterns without a measured need.
- **Supabase service role throughout the backend:** grants broader authority than
  runtime operations require.
- **Direct browser access to core tables:** makes authorization and audit
  behavior harder to centralize and test.

## Reversal triggers

Revisit the provider, not the relational model, if cross-provider reliability,
regional requirements, or measured connection behavior fails production needs.
The portability target is managed PostgreSQL, not a database rewrite.

## Validation

- Transaction-pooler integration tests run with prepared statements disabled.
- Lambda concurrency cannot exceed the database connection budget.
- Cross-tenant resource-ID substitution returns no data.
- Runtime role cannot alter schema or bypass tenant predicates.
- Backup/restore and migration rollback are exercised before production.

## References

- [Supabase database connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase network restrictions](https://supabase.com/docs/guides/platform/network-restrictions)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase JWTs](https://supabase.com/docs/guides/auth/jwts)
