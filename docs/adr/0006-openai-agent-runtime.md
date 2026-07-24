# ADR-0006: Use OpenAI Responses behind a controlled model gateway

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Agent platform and product security

## Context

Migration API needs model reasoning for vendor-change extraction, repository
impact analysis, patch planning, and bounded repair. The model must not own
credentials, policy, orchestration, persistence, verification, or publication.

Known as of this ADR:

- OpenAI recommends the Responses API for reasoning and tool-using workflows.
- Responses are stored by default unless `store: false` is sent.
- Strict function calling requires `additionalProperties: false` and every
  property to be required; optional values are represented with a nullable type.
- OpenAI API data is not used for training by default unless the customer opts
  in, but default abuse-monitoring logs can retain customer content for up to 30
  days.
- Zero Data Retention and Modified Abuse Monitoring require approval and have
  feature constraints.
- OpenAI supports exchanging an AWS STS `GetWebIdentityToken` OIDC JWT for a
  short-lived OpenAI access token.

Assumed and not yet proven:

- The selected OpenAI account and AWS account can enable outbound workload
  identity federation before production.
- Design partners accept processing selected source excerpts by OpenAI.
- `gpt-5.6-sol` with medium reasoning is a good quality baseline for this
  workload.

## Decision

Use the official OpenAI SDK and Responses API through one internal model-gateway
interface. Set `gpt-5.6-sol` and medium reasoning as the initial evaluation
configuration, not as a permanent product guarantee.

The gateway:

- sends `store: false` on every request;
- disables background mode;
- uses `truncation: "disabled"` so overflow fails explicitly;
- disables parallel function calls initially;
- exposes only allowlisted custom function tools;
- uses strict tool schemas and strict Structured Outputs;
- does not enable hosted web search, shell, Code Interpreter, file search,
  vector stores, remote MCP, Conversations, or multi-agent beta features;
- disables implicit prompt caching using explicit cache mode and defines no
  customer-source cache breakpoint unless a later data-policy ADR approves it;
- sends a stable privacy-preserving `safety_identifier`;
- records requested and returned model, reasoning configuration, usage, latency,
  and OpenAI request ID;
- redacts provider errors before persistence or user display.

Step Functions owns the business workflow. The Fargate agent kernel owns the
bounded tool loop. Deterministic local code authorizes and executes tools. The
verifier independently executes tests. The trusted publisher is not a model
tool.

## Authentication

Production uses AWS outbound workload identity federation:

1. Enable outbound web identity federation for the AWS account.
2. Use a regional STS endpoint.
3. Permit only `sts:GetWebIdentityToken`.
4. Restrict audience to `https://api.openai.com/v1`.
5. Restrict initial token lifetime to at most 300 seconds.
6. Match the exact task-role ARN in the OpenAI service-account mapping.
7. Restrict the mapping initially to `api.model.request`.

Use separate OpenAI projects and mappings for development, staging, and
production. WIF identifiers are configuration; OIDC subject and OpenAI access
tokens stay in memory and never enter logs, S3, PostgreSQL, or Step Functions.

A temporary project-scoped development API key is allowed only if WIF is not
available yet. It must be stored in Secrets Manager, have an owner and expiry,
and be removed before production. Production must fail closed rather than fall
back to a static key.

## State and continuation

Migration API owns authoritative agent state. It does not persist OpenAI
Conversations or readable hidden chain-of-thought.

Initially, each turn sends bounded policy, evidence, and prior structured
actions. If evaluations show a material quality loss, encrypted reasoning-item
replay may be evaluated separately. A crash resumes from the last structured
checkpoint and may repeat reasoning, but cannot repeat a side-effecting tool
without the tool’s idempotency guard.

## Model and prompt release policy

No model alias is promoted solely because it is newer.

Promotion requires:

- deterministic and human-reviewed migration fixtures;
- valid-schema and tool-authority success;
- affected-file recall and unrelated-file precision;
- patch application and verification results;
- safeguard/refusal behavior;
- latency, quota, and budget behavior;
- canary and rollback configuration.

Pin a snapshot when available and when reproducibility outweighs alias updates.
Record prompt, policy, tool-registry, schema, and model configuration versions.

## Data-processing disclosure

Selected customer source leaves AWS and is processed by OpenAI. `store: false`
does not by itself remove default abuse-monitoring retention. The UI and
customer terms must describe the actual OpenAI project configuration. They must
not claim that source stays in AWS, is never retained, or is covered by Zero
Data Retention unless those claims are verified for the deployed project and
features.

## Consequences

Benefits:

- Strong current code reasoning and native structured tool use.
- No long-lived OpenAI credential in production.
- Provider calls are centralized and testable.

Costs and risks:

- Customer source crosses the AWS trust boundary.
- OpenAI availability, quotas, safeguards, model changes, and terms affect the
  product.
- Controlled internet egress is required; there is no AWS PrivateLink path to
  the OpenAI API.
- Strict schemas and data controls require integration tests against the real
  account configuration.

## Rejected alternatives

- **OpenAI-hosted shell/code tools:** collapse the local policy and workspace
  boundary.
- **Direct OpenAI calls throughout services:** makes controls and migration
  difficult to audit.
- **Premature multi-provider framework:** adds abstraction before a second
  provider requirement exists.

## Reversal triggers

Revisit if OpenAI cannot satisfy required data residency/retention, WIF is
unavailable for production, quality fails the evaluation gate, or outage/quotas
make the product unreliable. The internal gateway limits the change surface,
but a second provider still requires its own security ADR.

## Validation

- Integration request proves `store: false`, explicit cache mode, strict schemas,
  disabled truncation, and disabled hosted tools.
- A denied WIF exchange does not read a fallback production secret.
- Egress tests deny every destination except required AWS endpoints and the
  configured OpenAI API endpoint.
- Prompt-injection fixtures cannot add tools or expand patch policy.
- Captured logs contain no source, prompts, OIDC tokens, access tokens, or keys.

## References

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI function calling strict mode](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data)
- [OpenAI workload identity federation for AWS](https://developers.openai.com/api/docs/guides/workload-identity-federation/aws)
