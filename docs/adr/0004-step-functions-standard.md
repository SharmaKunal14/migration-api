# ADR-0004: Use Step Functions Standard for durable orchestration

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Platform engineering

## Context

Migration workflows span durable state changes, Fargate jobs, bounded retries,
human-visible progress, cancellation, and external side effects. Runs may exceed
the duration and operational model of a single Lambda invocation.

Known:

- Standard Workflows support long-running, auditable executions and
  `ecs:runTask.sync`.
- Workflow type cannot be changed after state-machine creation.
- Standard’s exactly-once state-transition model does not eliminate duplicate
  external effects caused by configured retries, timeouts, worker behavior, or
  partial failure.

Assumed:

- Execution volume is initially modest.
- A durable execution history is more important than very high event
  throughput.

## Decision

Use Step Functions Standard Workflows for business orchestration.

Step Functions owns stage progression, timeouts, retry policy, cancellation
checks, and terminal routing. PostgreSQL owns business truth. Fargate owns the
bounded agent loop and repository work. S3 owns large evidence.

Workflow input contains identifiers and expected versions only:

- organisation ID;
- run, candidate, and approval IDs;
- repository ID;
- expected attempt/version;
- correlation ID.

It never contains source, patches, model prompts, GitHub tokens, database
credentials, model credentials, or raw logs.

## Start and idempotency

An API transaction writes the approval, run, and outbox event atomically. The
outbox dispatcher starts a Standard execution using a deterministic name based
on the run ID.

Every task remains idempotent despite Standard execution semantics:

- immutable attempt-scoped artifact keys;
- expected-state and version checks;
- deterministic branch name;
- GitHub reconciliation before creation;
- unique database constraints;
- no blind retry of side-effecting operations.

Retries apply only to explicitly classified transient failures. Code repair is
an agent iteration, not an infrastructure retry.

## Failure and cancellation

- Task timeouts are explicit.
- Caught failures become safe terminal domain states.
- Cancellation is requested in PostgreSQL and checked between safe stages.
- A timed-out external call is treated as possibly completed.
- Existing branches and pull requests are never silently deleted during
  cancellation.
- Execution history is operational evidence, not the authoritative approval
  record.

## Consequences

Benefits:

- Durable visual orchestration and native Fargate job waiting.
- Explicit failure paths and observable progression.
- Suitable for future human wait states if required.

Costs and limitations:

- State-machine evolution requires backward-compatible execution contracts.
- Execution history has retention limits and must not be the only audit source.
- `.sync` integration requires supporting EventBridge/IAM permissions.
- State transition cost and quota still require monitoring.

## Rejected alternatives

- **Express Workflows:** shorter retention, at-least-once asynchronous execution,
  and no `.sync` job-run integration do not fit the core migration workflow.
- **Lambda-only orchestration:** couples business durability to invocation
  lifetime and custom retry code.
- **Database polling as the workflow engine:** recreates orchestration,
  visibility, and timeout machinery.

## Reversal triggers

Use another mechanism only if measured throughput, regional availability, or
workflow-version constraints make Standard unsuitable. High-volume webhook
ingestion may use SQS or Express separately without changing migration
orchestration.

## Validation

- Duplicate outbox dispatch starts one logical execution.
- Fargate success, task failure, timeout, and non-empty ECS failure responses
  reach explicit states.
- Workflow state inspection reveals no source or credentials.
- A simulated “external success/database failure” reconciles without duplicate
  effects.
- Old in-flight workflow versions complete during deployment.

## References

- [Choosing a Step Functions workflow type](https://docs.aws.amazon.com/step-functions/latest/dg/choosing-workflow-type.html)
- [Running ECS/Fargate tasks from Step Functions](https://docs.aws.amazon.com/step-functions/latest/dg/connect-ecs.html)
