# Disable new Stage 1 demo runs

Use this procedure for suspected credential exposure, cross-tenant access,
unexpected egress, repeated workflow failure, or provider instability.

1. Disable the API Gateway routes that create demo runs, or set their integration
   reserved concurrency to zero through a reviewed emergency change.
2. Disable the EventBridge outbox schedule.
3. Do not delete queued outbox records; preserve them for reconciliation.
4. Stop active Fargate tasks only after recording task and workflow identifiers.
5. If OpenAI authentication is implicated, remove the exact WIF mapping. Do not
   add a static-key fallback.
6. Inspect redacted metadata and CloudTrail. Do not copy source or tokens into an
   incident chat or ticket.
7. Resume only after the fault is understood, affected state is reconciled, and
   negative tests pass.
