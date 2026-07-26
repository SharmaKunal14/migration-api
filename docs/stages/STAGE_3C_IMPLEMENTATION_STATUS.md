# Stage 3C implementation status

- **Status:** Implemented locally; not deployed
- **Updated:** 2026-07-26

## Scope

Stage 3C turns the validated OrbitChat v2 evidence from Stage 3B into a strict,
evidence-backed draft migration specification. It does not review or promote
the draft, match repositories, create migration candidates, inspect repository
source, modify code, or add product UI.

## Implemented

- Dedicated, non-root Change Intelligence Agent Fargate task with a read-only
  root filesystem.
- Dedicated OpenAI workload identity and AWS roles.
- Identifier-only, operator-started Standard Workflow.
- Database-owning control Lambda separated from the model task.
- Read-only evidence tools that can list registered sources and read only
  digest-bound objects within the selected release prefix.
- Required reads of release metadata, migration guide, changelog, and v1/v2 API
  definitions before successful completion.
- Three model calls, twelve tool calls, four iterations, 60,000 input tokens,
  12,000 output tokens, and a five-minute agent wall-clock budget.
- Strict JSON schema and server-injected draft trust metadata.
- Independent controller validation of every cited source URL and digest before
  persistence.
- Transactional, idempotent run state with stale-run recovery and ten-attempt
  maximum.
- KMS-encrypted result artifacts, immutable image deployment, vulnerability
  scan gate, structured logs, retention, and alarms.

## Security boundary

The model task has no database secret, GitHub token path, Lambda invocation,
shell tool, arbitrary URL tool, or repository snapshot. Its S3 role reads only
the vendor-evidence prefix and writes only the change-intelligence result
prefix. The only unavoidable wildcard is `sts:GetWebIdentityToken`, which AWS
does not resource-scope; audience and five-minute lifetime conditions constrain
it.

The agent cannot set trust metadata. The application injects `draft`,
`change_intelligence_agent`, and a null review timestamp, and the controller
checks them again. The database role can insert a draft specification but has
no Stage 3C grant to update or promote one.

## Expected deployed outcome

An operator can start the workflow for the validated OrbitChat v2 release. A
successful run creates exactly one draft migration specification for
`@orbitchat/sdk` 1.x to 2.0.0 with seven evidence-backed changes and the
unresolved notification-default behavior. Re-running the same evidence is a
successful no-op.

Nothing new appears in the product UI in this slice. Operator review and
candidate matching arrive in Stage 3D.

## Next slice

Stage 3D should add operator-only draft review/promotion, semver-aware matching
against Stage 2 dependency observations, and idempotent migration-candidate
creation.
