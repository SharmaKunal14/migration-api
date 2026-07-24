# Stage 1 infrastructure and implementation inventory

- **Status:** Ready for implementation after Stage 0 human/decision gates
- **Version:** 1.0
- **Date:** 2026-07-24
- **Stage outcome:** A deployed authenticated UI launches a real bounded OpenAI
  agent on Fargate through a durable AWS workflow and displays structured
  evidence.

## 1. Scope

Stage 1 proves one production-shaped vertical slice:

```text
Browser
  → CloudFront
  → API Gateway/Lambda
  → Supabase PostgreSQL transaction + outbox
  → Step Functions Standard
  → isolated Fargate agent
  → OpenAI Responses API
  → encrypted S3 result
  → PostgreSQL status
  → browser timeline/result
```

The input is controlled OrbitChat evidence. Stage 1 does not install the
repository GitHub App, fetch a customer repository, patch code, run repository
tests, publish a branch, or send email.

## 2. Decisions that must be recorded before provisioning

| Decision                     | Owner               | Required evidence                                   |
| ---------------------------- | ------------------- | --------------------------------------------------- |
| Development AWS region       | Platform            | Service support, latency, two AZs                   |
| Supabase region              | Platform/data       | Nearby to AWS; pooler/network support               |
| OpenAI project/data region   | Security/product    | WIF, model, retention, customer-disclosure support  |
| Product domain               | Product/platform    | Controlled DNS zone and certificate ownership       |
| Stage 1 model snapshot/alias | Agent platform      | Availability and initial smoke evaluation           |
| Terraform/OpenTofu choice    | Platform            | Pinned supported version and provider compatibility |
| Log retention periods        | Security/operations | Data classification and incident needs              |

Do not silently choose regions in code. Region choice changes latency, provider
support, data processing, and future customer claims.

## 3. Environment boundaries

Development uses:

- one isolated AWS development account or an account boundary approved for this
  project;
- one Supabase development project containing synthetic data only;
- one OpenAI development project and WIF service account;
- one GitHub OAuth application/provider configuration for Supabase login;
- a dedicated DNS subdomain;
- no production customer repository or production secret.

Resource names follow:

```text
migration-api-{environment}-{region}-{component}
```

Required tags:

- `Application=migration-api`
- `Environment=development`
- `Owner`
- `DataClassification`
- `ManagedBy=terraform`
- `Stage=1`

## 4. Terraform bootstrap

Bootstrap is a separately reviewed stack because it creates the authority used
to deploy everything else.

Resources:

- S3 state bucket with public access blocked, versioning, TLS-only bucket
  policy, and KMS encryption;
- state locking supported by the selected pinned Terraform version;
- KMS key with separate administration/use permissions;
- GitHub Actions OIDC provider if not account-managed centrally;
- plan role and deploy role with repository, branch/environment, and audience
  conditions;
- CloudTrail coverage and access logging according to account policy.

Rules:

- no provider credential or application secret in variables/state;
- deploy role cannot administer the OIDC trust that grants itself access;
- production is not added to Stage 1 role trust;
- plan output is reviewed before apply;
- state-bucket recovery from a prior version is tested.

## 5. AWS resource inventory

### 5.1 Edge and web

| Resource                          | Purpose/control                               |
| --------------------------------- | --------------------------------------------- |
| Private S3 web bucket             | Hashed assets; public access blocked          |
| CloudFront distribution           | One HTTPS product origin                      |
| Origin Access Control             | CloudFront-only S3 reads                      |
| ACM certificate                   | Product domain in required certificate region |
| Route 53 record                   | Product hostname                              |
| AWS WAF web ACL                   | Managed baseline and rate rule                |
| CloudFront response-header policy | CSP and browser security headers              |
| CloudFront logs/metrics           | Bounded retention; no application source      |

Cache behavior:

- hashed assets: immutable, long-lived;
- application HTML: short/no cache;
- `/api/*`: no content cache unless explicitly safe;
- API errors are never rewritten to the application shell.

### 5.2 API and control plane

| Resource                      | Purpose/control                                         |
| ----------------------------- | ------------------------------------------------------- |
| API Gateway HTTP API          | `/v1` JSON endpoints                                    |
| Supabase JWT authorizer       | Signature, issuer, audience, expiry                     |
| Control Lambda                | `me`, org, demo-run create/read endpoints               |
| Outbox dispatcher Lambda      | Claims outbox rows and starts named Standard executions |
| EventBridge Scheduler         | Bounded outbox dispatch cadence                         |
| Lambda security group/subnets | Fixed egress to Supabase pooler                         |
| Lambda log groups             | Structured redacted logs with explicit retention        |

If HTTP API cannot enforce a required authorizer or payload behavior, record an
ADR before switching to REST API. Do not mix both casually.

### 5.3 Workflow and execution

| Resource                              | Purpose/control                                      |
| ------------------------------------- | ---------------------------------------------------- |
| Step Functions Standard state machine | Validate, run Fargate `.sync`, ingest, terminate     |
| ECS cluster                           | Stage 1 agent execution                              |
| ECR agent repository                  | Immutable image tags/digests and scanning            |
| Agent task definition                 | Non-root, read-only root, bounded resources          |
| Agent task role                       | Exact S3 prefix pattern, logs, regional STS WIF only |
| ECS execution role                    | ECR pull and log delivery only                       |
| Agent security group/subnets          | No public IP; controlled OpenAI egress               |
| Artifact S3 bucket                    | KMS-encrypted immutable run inputs/results           |
| Artifact KMS key                      | Separate use/admin policy                            |

Conceptual state machine:

```text
ValidateDemoRequest
  → MarkAgentRunStarted
  → RunAgentTask.sync
  → ValidateResultEnvelope
  → PersistTerminalState
  → Success

Any caught error
  → ClassifySafeFailure
  → PersistTerminalState
  → Failed
```

Lambda must not run the model loop. Fargate must not connect to PostgreSQL.
Result ingestion uses an identifier plus exact S3 key/digest.

### 5.4 Network

At least two AZs:

- private control subnets for database-using Lambdas;
- private agent subnets;
- egress/firewall subnets as required by the selected design;
- no inbound route to agent tasks.

VPC endpoints:

- S3 gateway;
- ECR API/interface;
- ECR Docker/interface;
- CloudWatch Logs/interface;
- KMS/interface;
- Secrets Manager/interface where used;
- regional STS/interface.

OpenAI path:

```text
agent ENI
  → explicit inspected route
  → domain/SNI allow rule for configured OpenAI API endpoint
  → NAT with fixed EIP
  → OpenAI TLS endpoint
```

The implementation may use AWS Network Firewall or a reviewed explicit proxy.
It must demonstrate deny behavior, not merely document an intended hostname.
TLS certificate verification remains enabled. DNS and redirect behavior are
tested. The final hostname list is derived from the selected OpenAI endpoint and
official SDK behavior, not guessed.

Control Lambda reaches the Supabase transaction pooler through fixed NAT EIPs.
Only those CIDRs are allowed in Supabase database network restrictions.

## 6. IAM inventory

| Role              | Required authority                                          | Explicit denials/absence                    |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------- |
| CI plan           | Read state and plan-target resources                        | No deploy mutation                          |
| CI deploy         | Stage 1 named resources and `iam:PassRole` for named roles  | No broad account administration             |
| Control Lambda    | Read required config/secrets; limited artifacts/status      | No OpenAI/GitHub key                        |
| Outbox dispatcher | Outbox DB role; start named state machine                   | No arbitrary state machine                  |
| Step Functions    | Run named task definition; event integration; named Lambdas | No database/GitHub/OpenAI credential        |
| ECS execution     | Pull named ECR image; write named log group                 | No application S3/OpenAI                    |
| Agent task        | Run-specific S3; regional `GetWebIdentityToken`; logs       | No DB, GitHub, Secrets Manager, general AWS |
| Migration task    | Migration DB secret and one-off network path                | No application runtime use                  |

Any AWS-required wildcard resource is documented next to the exact action and
condition. Wildcard actions are prohibited.

## 7. OpenAI project and WIF setup

Provider-side work:

1. Create a development OpenAI project.
2. Create a service account dedicated to the Stage 1 agent.
3. Enable AWS outbound identity federation in the AWS account.
4. Record the account-specific AWS issuer URL.
5. Configure an OpenAI workload identity provider with that issuer and audience
   `https://api.openai.com/v1`.
6. Decode a non-production token locally and verify `iss`, `aud`, and exact
   `sub`.
7. Map the exact agent task-role ARN to the service account.
8. Limit the mapping to `api.model.request`.
9. Configure/record the actual OpenAI data controls.
10. Confirm the selected model is enabled.

Agent request baseline:

- Responses API;
- model `gpt-5.6-sol`, subject to availability/evaluation;
- reasoning effort `medium`;
- `store: false`;
- background `false`;
- parallel tool calls `false`;
- truncation `disabled`;
- prompt cache mode `explicit`, no source cache breakpoint;
- custom function tools only;
- strict schema;
- privacy-preserving `safety_identifier`.

No production fallback key exists. A temporary development key is allowed only
under ADR-0006 and cannot be promoted.

## 8. Supabase setup

Provider-side work:

- create development project in selected region;
- configure GitHub social login and exact callback URLs;
- configure allowed redirect URLs;
- create database roles from ADR-0002;
- store runtime and migration credentials in separate Secrets Manager entries;
- configure transaction-pooler connection for Lambda;
- disable prepared statements in the selected driver;
- require TLS certificate verification;
- allowlist only fixed AWS egress IPs for PostgreSQL/pooler;
- configure backup behavior appropriate to development;
- enable RLS on any API-exposed tables.

Minimal tables:

- `app_users`;
- `organisations`;
- `organisation_memberships`;
- `agent_runs`;
- `agent_actions`;
- `artifacts`;
- `workflow_outbox`;
- `audit_events`;
- `api_idempotency_keys`.

Minimum constraints:

- organisation/user uniqueness;
- run/status checks;
- agent run/sequence uniqueness;
- artifact key/digest uniqueness where applicable;
- outbox idempotency uniqueness;
- API actor/action/idempotency uniqueness;
- foreign keys and deletion policy.

## 9. Stage 1 application units

Planned greenfield layout:

```text
apps/
  web/
services/
  api/
  outbox-dispatcher/
workers/
  agent/
packages/
  contracts/
  config/
  domain/
  database/
  authorization/
  agent-kernel/
  agent-tools/
  model-gateway/
  observability/
  test-fixtures/
infra/
  terraform/
    bootstrap/
    modules/
    environments/development/
supabase/
  migrations/
  seed/
```

Stage 1 implements only packages with a real consumer. It does not pre-create
the full future directory tree.

## 10. Configuration and secrets

Non-secret configuration:

- environment and region;
- public product origin;
- Supabase issuer/audience/JWKS URL;
- S3 bucket aliases and KMS aliases;
- state-machine/task-definition identifiers;
- OpenAI model/reasoning/policy configuration;
- WIF provider/service-account identifiers and audience;
- budget and artifact limits;
- log levels and retention classes.

Secrets:

- Supabase runtime credential;
- Supabase migration credential;
- Supabase GitHub OAuth provider secret if required by setup.

Not secrets:

- Supabase publishable key;
- OpenAI WIF provider/service-account IDs;
- AWS ARNs.

Even non-secrets are environment-scoped and startup-validated.

## 11. Initial bounded limits

Stage 1 synthetic demo defaults:

| Limit                       | Initial value |
| --------------------------- | ------------: |
| API JSON body               |        64 KiB |
| Synthetic evidence artifact |       256 KiB |
| Tool read result            |        64 KiB |
| Model calls                 |             4 |
| Tool calls                  |            12 |
| Agent iterations            |             6 |
| Total input-token budget    |        50,000 |
| Total output-token budget   |        12,000 |
| Agent wall clock            |     5 minutes |
| Fargate task timeout        |    10 minutes |
| Result artifact             |         1 MiB |
| Structured log event        |        16 KiB |

These are reliability/security budgets, not only cost limits. Changes require
configuration review and evaluation evidence.

Before Stage 2, explicitly decide:

- compressed and expanded repository byte limits;
- file count and individual-file limits;
- path depth and name length;
- workspace count;
- archive ratio;
- snapshot retention;
- concurrent scans per organisation.

## 12. Observability

Structured correlation:

- request ID;
- organisation ID where safe;
- agent run ID;
- workflow execution ID;
- Fargate task ARN;
- internal model-call ID;
- OpenAI request ID.

Metrics:

- API latency/errors/throttles;
- authorizer failures;
- database connection/query failures;
- outbox age and attempts;
- workflow success/failure/timeout;
- Fargate startup and task failure;
- OpenAI latency, input/output tokens, returned model, rate limit, WIF and
  safeguard failures;
- agent iteration/budget terminal codes;
- artifact validation failures.

Alarms:

- oldest outbox age over threshold;
- any terminal outbox delivery failure;
- repeated workflow/Fargate failure;
- WIF exchange failure;
- database unavailability;
- unexpected budget-exhaustion spike;
- no successful canary within the defined window.

No source, raw prompt, response body, JWT, database URL, WIF token, or secret is
logged.

## 13. Deployment order

1. Pin toolchain and providers.
2. Deploy bootstrap/state/OIDC.
3. Select and record regions.
4. Create provider projects/configuration.
5. Deploy network, endpoints, controlled egress, KMS, S3, ECR, and logs.
6. Build, scan, and push agent image by digest.
7. Apply Supabase schema through one-off migration task.
8. Deploy Step Functions and Lambda control plane.
9. Build and deploy hashed web assets.
10. Run security-negative smoke checks.
11. Run end-to-end synthetic canary.
12. Record versions, digests, and acceptance evidence.

## 14. Rollback

- CloudFront points to the previous immutable asset manifest.
- Lambda aliases point to the previous version.
- ECS task definition rolls back to the previous image digest.
- State machine versions/aliases preserve in-flight execution compatibility.
- Database uses expand/migrate/contract; destructive contraction is deferred.
- Agent/model/prompt policies are feature-flagged and versioned.
- Rollback does not delete audit or evidence required to explain a failed run.

## 15. Explicitly deferred

- Repository GitHub App and token broker operations.
- Webhook SQS/DLQ.
- Source/vendor fetchers.
- Impact and migration agents.
- Verifier.
- Publisher and notification.
- Vector retrieval.
- Production account and customer data.
