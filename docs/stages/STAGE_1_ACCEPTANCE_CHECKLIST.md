# Stage 1 acceptance checklist

- **Status:** Not started
- **Version:** 1.0
- **Date:** 2026-07-24
- **Rule:** An unchecked item is incomplete. Screenshots alone are not evidence
  for security or reliability controls.

## 1. Decision prerequisites

- [ ] Development AWS region is recorded with service-support evidence.
- [ ] Supabase region is recorded with latency/network rationale.
- [ ] OpenAI project/data region and actual retention controls are recorded.
- [ ] Product domain and certificate ownership are recorded.
- [ ] Terraform and Node.js versions are pinned.
- [ ] Stage 1 model alias/snapshot and reasoning baseline are recorded.
- [ ] Stage 0 human interview gate is complete or the user explicitly accepts
      proceeding at product risk.

## 2. Reproducible infrastructure

- [ ] Terraform bootstrap is separate from the application stack.
- [ ] Remote state has encryption, versioning, locking, public-access block, and
      restricted policies.
- [ ] GitHub Actions assumes AWS roles through constrained OIDC trust.
- [ ] A clean development environment can be planned and applied without
      console-only drift, except documented provider bootstrap actions.
- [ ] Every resource has required tags.
- [ ] Terraform format, validate, and security checks pass.
- [ ] No secret value appears in source, variables, plan output, or state.

Evidence:

```text
Plan/apply run:
Commit:
Terraform version:
Provider lock digest:
Exceptions:
```

## 3. Edge and UI

- [ ] CloudFront serves the private S3 application.
- [ ] HTTP redirects to HTTPS.
- [ ] Deep application links return the shell.
- [ ] API failures are not rewritten to the shell.
- [ ] CSP blocks inline script and unapproved destinations.
- [ ] WAF managed/rate rules are attached and observable.
- [ ] Login, organisation creation/selection, demo-run start, timeline, and
      evidence result are usable by keyboard.
- [ ] No secret or source appears in web bundles or analytics.
- [ ] UI wording says the demo uses synthetic evidence.

## 4. Authentication and authorization

- [ ] Supabase GitHub login uses exact allowlisted callbacks/redirects and PKCE.
- [ ] API validates JWT signature, issuer, audience, expiration, and subject.
- [ ] Current PostgreSQL membership, not JWT user metadata, grants role.
- [ ] Non-member, removed member, Viewer mutation, and cross-tenant UUID tests
      fail closed.
- [ ] Every mutation produces a redacted audit event.
- [ ] API error responses contain stable safe code and request ID only.

## 5. PostgreSQL and outbox

- [ ] Runtime and migration roles are separate and least privilege.
- [ ] Lambda uses transaction pooling with prepared statements disabled.
- [ ] TLS certificate verification is enabled.
- [ ] Supabase database restrictions allow only fixed AWS egress CIDRs.
- [ ] Lambda concurrency and pool sizes stay within the recorded connection
      budget.
- [ ] Demo-run creation and outbox insertion are atomic.
- [ ] Same idempotency key/body returns the original run.
- [ ] Same idempotency key/different body returns conflict.
- [ ] Duplicate outbox delivery starts one logical workflow.
- [ ] Database unavailability fails mutations closed without reconnect storm.

## 6. Workflow and Fargate

- [ ] Standard Workflow uses a deterministic execution name.
- [ ] Workflow input contains identifiers only.
- [ ] Fargate `.sync` success, ECS failure response, timeout, and task crash map
      to explicit terminal states.
- [ ] Agent container is non-root with read-only root filesystem.
- [ ] CPU, memory, ephemeral disk, output, token, iteration, and wall-clock
      budgets are externally enforced.
- [ ] Agent task role has no PostgreSQL, GitHub, or Secrets Manager access.
- [ ] ECS execution role and task role are distinct.
- [ ] Artifact input/output is exact-prefix and digest validated.
- [ ] No source or raw prompt appears in Step Functions history or CloudWatch.

## 7. OpenAI gateway

- [ ] AWS outbound identity federation is enabled.
- [ ] Regional STS is used.
- [ ] IAM restricts `GetWebIdentityToken` to OpenAI audience and at most 300
      seconds.
- [ ] OpenAI mapping matches the exact agent role and `api.model.request`.
- [ ] Positive WIF exchange and wrong-role/audience/expired negative tests pass.
- [ ] No long-lived production OpenAI key exists.
- [ ] Request uses Responses, `store:false`, background off, truncation disabled,
      parallel tool calls off, and explicit cache mode.
- [ ] Hosted OpenAI tools and Conversations are absent.
- [ ] Tool and terminal schemas run in strict mode.
- [ ] Unknown tool, malformed arguments, extra fields, and invalid terminal
      output are rejected.
- [ ] Rate limit, timeout, safeguard/refusal, and WIF failure become explicit
      safe terminal codes with bounded retry.
- [ ] Requested/returned model, usage, latency, and request ID are recorded
      without source.

## 8. Controlled egress

- [ ] Agent has no public IP.
- [ ] AWS service traffic uses intended VPC endpoints.
- [ ] OpenAI succeeds through the approved egress path.
- [ ] An HTTPS request to an unapproved public hostname is denied.
- [ ] Requests to loopback, RFC1918, link-local, and metadata addresses are
      denied.
- [ ] DNS/redirect behavior cannot bypass the hostname rule.
- [ ] TLS verification failure is not disabled or ignored.
- [ ] Egress denial and firewall health are observable.

## 9. Agent behavior and contracts

- [ ] All five Stage 0 schemas validate with a pinned Draft 2020-12 validator.
- [ ] Semantic contract lint passes.
- [ ] Agent reads only the bounded OrbitChat evidence artifact.
- [ ] Model can invoke only the registered read-only evidence tool.
- [ ] Prompt-injection text does not change tool authority.
- [ ] Agent returns a schema-valid structured migration plan.
- [ ] Confirmed and ambiguous vendor facts are distinguished.
- [ ] Model-call, tool-call, iteration, token, output, and time budget exhaustion
      each have an explicit terminal result.
- [ ] Deterministic test double covers success and each failure class.

## 10. End-to-end product path

- [ ] A new user signs in to the deployed UI.
- [ ] The user creates/selects an organisation.
- [ ] The user launches one synthetic OrbitChat run.
- [ ] API returns one run for repeated identical requests.
- [ ] UI shows real queued, running, and terminal states from persisted data.
- [ ] One Step Functions execution and one Fargate task perform the run.
- [ ] One real OpenAI Responses call occurs.
- [ ] Result artifact is encrypted in S3 and bound by digest.
- [ ] UI displays structured changes, evidence, and uncertainty.
- [ ] UI never claims customer repository access or traction.

Evidence:

```text
Run ID:
Workflow execution:
Fargate task:
Requested/returned model:
Input/output artifact digests:
Started/completed:
Terminal code:
```

## 11. Reliability and failure injection

- [ ] Duplicate API request.
- [ ] Duplicate outbox dispatch.
- [ ] Fargate fails before writing result.
- [ ] Fargate writes result but callback/ingestion fails.
- [ ] Result digest or schema is invalid.
- [ ] OpenAI rate limits the request.
- [ ] OpenAI request times out.
- [ ] WIF mapping is removed.
- [ ] Supabase is temporarily unavailable.
- [ ] Agent exceeds each configured budget.
- [ ] Retry produces no duplicate agent action or terminal artifact.

## 12. Observability and operations

- [ ] Correlation IDs join API, outbox, workflow, task, and model-call metadata.
- [ ] Log groups have explicit retention.
- [ ] Metrics exist for API, database, outbox, workflow, Fargate, OpenAI, and
      budget terminal codes.
- [ ] Alarms are tested for outbox age, workflow failure, WIF failure, database
      failure, and missing canary.
- [ ] Logs are sampled and verified free of source, prompts, tokens, keys, JWTs,
      database URLs, and presigned URLs.
- [ ] Operator-facing errors are useful but redacted.
- [ ] A short incident note explains how to disable new demo runs.

## 13. Deployment and rollback

- [ ] CI checks format, lint, type, unit, contract, build, secret, dependency,
      Terraform, container, and agent smoke evaluation.
- [ ] Agent image is scanned, has an SBOM, and deploys by digest.
- [ ] Database migration runs from the approved AWS path.
- [ ] Live smoke test runs after deploy.
- [ ] Web, Lambda, ECS task, workflow, policy, and schema versions are recorded.
- [ ] Rollback to previous web assets, Lambda version, task definition, and agent
      policy is exercised.
- [ ] In-flight workflow remains interpretable across a deployment.

## 14. Exit decision

Stage 1 passes only when:

- [ ] Every mandatory item above is checked with recorded evidence.
- [ ] The full cloud path is repeatable from a clean deployment.
- [ ] Security-negative tests pass.
- [ ] The UI presents real state and honest synthetic evidence.
- [ ] Known exceptions have an owner, deadline, and explicit risk acceptance.

If the path works only locally, uses a static OpenAI key in production design,
logs source, or bypasses egress/authorization controls, Stage 1 has not passed.
