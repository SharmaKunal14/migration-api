# Architecture decision record index

ADRs capture decisions that materially constrain implementation. They state
what is known, what is assumed, the rejected alternatives, and the evidence
that would justify reversal.

| ADR                                     | Status   | Decision                                                      |
| --------------------------------------- | -------- | ------------------------------------------------------------- |
| [0001](0001-static-react-frontend.md)   | Accepted | React/Vite static UI behind CloudFront                        |
| [0002](0002-supabase-auth-postgres.md)  | Accepted | Supabase Auth plus authoritative Supabase PostgreSQL          |
| [0003](0003-github-app-permissions.md)  | Accepted | One selected-repository GitHub App for the initial product    |
| [0004](0004-step-functions-standard.md) | Accepted | Step Functions Standard for durable business orchestration    |
| [0005](0005-fargate-trust-zones.md)     | Accepted | Separate Fargate tasks for distinct execution trust zones     |
| [0006](0006-openai-agent-runtime.md)    | Accepted | OpenAI Responses API behind a policy-controlled model gateway |
| [0007](0007-draft-pr-no-auto-merge.md)  | Accepted | Publish draft PRs only; never merge automatically             |

## ADR lifecycle

- `Proposed`: under review and not an implementation default.
- `Accepted`: current implementation default.
- `Superseded`: replaced by a newer ADR that links back to it.
- `Rejected`: evaluated but not adopted.

Changing an accepted decision requires:

1. Evidence that the current decision fails a product, security, reliability, or
   compliance requirement.
2. A replacement ADR with migration and rollback consequences.
3. Updates to affected contracts, threat controls, and stage acceptance gates.
