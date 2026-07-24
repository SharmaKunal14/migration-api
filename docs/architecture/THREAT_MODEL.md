# Migration API threat model

- **Status:** Stage 0 baseline
- **Version:** 1.0
- **Date:** 2026-07-24
- **Review cadence:** Before each authority-expanding stage and every production
  launch
- **Owners:** Product security and the owning service team

## 1. Purpose and scope

This model covers the planned system from browser authentication through GitHub
installation, vendor evidence ingestion, repository acquisition, OpenAI agent
processing, hostile-code verification, and draft pull-request publication.

Stage 1 implements only the synthetic agent path, but controls are mapped to the
stage where the corresponding authority appears.

This is not proof of security. It is a set of falsifiable invariants, threats,
controls, tests, and accepted residual risks.

## 2. Known, assumed, and unresolved

Known:

- Repository source, vendor content, model output, webhook payloads, archives,
  test output, and customer tests are untrusted.
- The GitHub App has technical write capability after installation.
- Selected source excerpts are processed outside AWS by OpenAI.
- Fargate tasks are isolated from other tasks, but containers inside one task
  share network and ephemeral resources.
- Models and prompts cannot enforce security policy.

Assumed:

- Initial customers use GitHub Cloud and npm/TypeScript repositories.
- Initial verification requires no private registry credentials.
- AWS outbound WIF and the required OpenAI data controls are available before
  production.
- Customers retain branch protection and human merge review.

Unresolved product risks:

- Whether customers accept GitHub contents-write permission at installation.
- Whether customers accept source processing by OpenAI under the configured
  retention policy.
- Whether repository tests provide useful assurance.
- Whether one Fargate task per trust zone satisfies pilot customer policy.

## 3. Security objectives

1. A user can access only organisations and repositories for which current
   server-side membership and installation authorization exist.
2. No model or untrusted repository process can access GitHub, database, or
   reusable cloud credentials.
3. A code mutation can be published only for one immutable, unrevoked approval
   bound to the exact repository, base, evidence, policy, and patch.
4. Model, vendor, and repository content cannot expand tool authority.
5. Every external effect is idempotent or reconcilable.
6. Source and derived patches are minimized, encrypted, access-scoped, and
   deleted according to policy.
7. Failures are safe and observable; missing evidence is never represented as
   success.
8. The platform never merges or deploys customer code.

## 4. Assets

| Asset                                | Sensitivity       | Primary owner            |
| ------------------------------------ | ----------------- | ------------------------ |
| GitHub App private key               | Critical secret   | Token broker             |
| Installation and user access tokens  | Critical secret   | In-memory trusted caller |
| Supabase database credentials        | Critical secret   | Control/migration role   |
| OpenAI OIDC subject/access tokens    | Critical secret   | Agent task memory        |
| Repository snapshots                 | Customer source   | S3 artifact plane        |
| Model context and responses          | Customer-derived  | Agent/S3                 |
| Patch and verification artifacts     | Customer-derived  | S3 artifact plane        |
| Membership and approval records      | Authorization     | PostgreSQL               |
| Vendor evidence/specifications       | Untrusted/shared  | Vendor intelligence      |
| Audit trail                          | Security evidence | PostgreSQL/CloudWatch    |
| Terraform state and deployment roles | Infrastructure    | Platform engineering     |

## 5. Actors and attacker capabilities

- Unauthenticated internet attacker.
- Authenticated user with no membership in the target organisation.
- Malicious or removed organisation member.
- Malicious repository owner or contributor.
- Compromised vendor page or package metadata.
- Prompt injection embedded in code, docs, strings, tests, or logs.
- Compromised dependency or container image.
- Compromised model output or provider response.
- Operator with excessive or misused access.
- Automated abuse causing resource exhaustion.
- External provider outage, replay, duplication, or inconsistent response.

## 6. Trust boundaries

See [DATA_FLOW.md](DATA_FLOW.md) for the numbered flow.

| Boundary | Transition                                | Required enforcement                                      |
| -------- | ----------------------------------------- | --------------------------------------------------------- |
| TB-1     | Internet browser → CloudFront/API Gateway | TLS, WAF, JWT validation, request limits                  |
| TB-2     | API → PostgreSQL                          | TLS, least-privilege role, tenant predicate, transactions |
| TB-3     | GitHub → webhook ingress                  | Raw-body HMAC, byte limit, replay deduplication           |
| TB-4     | Control plane → execution plane           | Identifier-only contracts, IAM, schema validation         |
| TB-5     | GitHub → source snapshot                  | Scoped token, selected repo, archive/path validation      |
| TB-6     | S3 source → agent/OpenAI                  | Context minimization, WIF, controlled egress, disclosure  |
| TB-7     | Agent patch → verifier                    | Digest binding, separate task, no reusable credential     |
| TB-8     | Verified patch → trusted publisher/GitHub | Approval revalidation, patch policy, idempotency          |
| TB-9     | Operator/CI → production infrastructure   | OIDC, protected deployment, audit, least privilege        |

## 7. Security invariants

These are release-blocking:

- `INV-01`: Every tenant-owned query includes the authorised organisation ID.
- `INV-02`: User-editable JWT metadata never grants an organisation role.
- `INV-03`: Step Functions input contains no source or credential.
- `INV-04`: Agent task role cannot call GitHub or PostgreSQL.
- `INV-05`: Verifier child process receives no reusable credential and no
  general network route.
- `INV-06`: Only the token broker can read the GitHub App private key.
- `INV-07`: Only the trusted publisher can obtain write-scoped installation
  tokens.
- `INV-08`: Tool arguments and terminal output validate against versioned strict
  schemas before use.
- `INV-09`: The model cannot add tools, change policy, change budgets, or request
  arbitrary shell/network access.
- `INV-10`: A published patch matches an approved artifact digest and exact base
  commit.
- `INV-11`: Forbidden paths and change budgets are rechecked outside the agent.
- `INV-12`: The publisher has no merge implementation.
- `INV-13`: Logs and metrics contain no source, raw prompt, token, key, JWT,
  database URL, or presigned URL.
- `INV-14`: Duplicate events and retries cannot create a second logical run,
  branch, or pull request.
- `INV-15`: `partial`, `unavailable`, and `timed_out` verification never become
  `passed`.

## 8. Threat register

Likelihood and impact are pre-control qualitative estimates. Residual risk must
be reassessed with deployed evidence.

| ID   | Threat                                                               | L   | I   | Required controls                                                                                       | Verification                                     | Stage |
| ---- | -------------------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----- |
| T-01 | Cross-tenant resource-ID substitution                                | H   | C   | Current membership lookup; org-scoped query; deny-by-default action matrix                              | Unit/integration tests for every sensitive route | 1+    |
| T-02 | Stale or forged Supabase JWT grants access                           | M   | H   | Verify signature/issuer/audience/time; load current membership; ignore user metadata                    | Revoked-member and malformed-token tests         | 1     |
| T-03 | GitHub installation callback CSRF/open redirect                      | M   | H   | 256-bit state; store digest; bind user/org/expiry; atomic consume; allowlisted return                   | Replay, wrong-user, expired-state tests          | 2     |
| T-04 | Forged, replayed, or reordered webhook                               | H   | H   | Raw-body HMAC; timing-safe compare; body limit; delivery-ID uniqueness; reconciliation                  | Forged/duplicate/out-of-order fixtures           | 2     |
| T-05 | GitHub private key or token theft                                    | M   | C   | Broker-only key access; scoped one-operation token; memory only; redaction; rotation                    | Secret scan; IAM tests; log capture              | 2/7   |
| T-06 | Access to unselected/revoked repository                              | M   | C   | GitHub numeric IDs; installation reconciliation; repository binding in broker; fail closed              | Selection/removal/suspension integration tests   | 2     |
| T-07 | Repository/vendor prompt injection expands authority                 | H   | C   | Treat content as data; fixed tool allowlist; schema/policy authorization; no secrets                    | Adversarial comments/docs/log fixtures           | 1/3/5 |
| T-08 | Malformed or adversarial model tool arguments                        | H   | H   | Strict schema; unknown fields denied; canonical path validation; byte/time budgets                      | Property/fuzz tests; real-model invalid output   | 1/5   |
| T-09 | Source leaks through OpenAI, logs, or analytics                      | M   | C   | Context minimization; disclosure; `store:false`; explicit cache mode; no prompt logs; data-control gate | Egress/log inspection; account setting review    | 1+    |
| T-10 | Vendor fetcher SSRF reaches internal service                         | H   | C   | HTTPS; allowlisted domains; DNS/IP rejection; redirect revalidation; no metadata route                  | Redirect, rebinding, private-IP fixtures         | 3     |
| T-11 | Archive/path/symlink escape on acquisition                           | H   | C   | Compressed/expanded limits; normalized relative paths; reject links/duplicates/special files            | Archive bomb and traversal corpus                | 2     |
| T-12 | Hostile tests escape or exhaust verifier                             | H   | C   | Separate task; non-root; read-only root; no network/credentials; PID/CPU/memory/disk/time/output limits | Fork/disk/memory/network/credential fixtures     | 6     |
| T-13 | Base branch changes between analysis and push                        | H   | H   | Bind snapshot SHA; approval revision; reacquire/recheck; stale state; no silent rebase                  | Concurrent push test                             | 4/7   |
| T-14 | Patch edits workflow, secret, governance, binary, or excessive scope | H   | C   | Default-deny paths; diff parser; size/delete limits; publisher revalidation                             | Forbidden-path and oversized patch fixtures      | 5/7   |
| T-15 | Retry creates duplicate run/branch/PR                                | H   | H   | API/outbox idempotency; deterministic execution/branch; unique constraints; reconcile                   | Failure-injection at each external boundary      | 1/4/7 |
| T-16 | Lambda connection storm exhausts PostgreSQL                          | M   | H   | Transaction pooler; tiny client pool; reserved concurrency; timeouts; alarms                            | Load and outage tests                            | 1     |
| T-17 | Artifact URL/key exposes another tenant                              | M   | C   | Trusted keys; org/run prefix IAM; digest binding; exact-method short presign; auth per request          | Cross-tenant and modified-key tests              | 1+    |
| T-18 | Compromised dependency/container/CI artifact                         | M   | C   | Lockfiles; pinned actions/providers; image digests; SBOM; scan; protected OIDC deploy                   | Provenance and vulnerability gates               | 1+    |
| T-19 | Operator reads source or mutates production                          | M   | C   | No routine source access; split roles; break-glass approval; audit; protected deployment                | Access review and break-glass exercise           | 9     |
| T-20 | Deletion or retention is incomplete                                  | M   | H   | Artifact classes; lifecycle plus explicit deletion workflow; deletion audit                             | Seeded organisation deletion test                | 9     |
| T-21 | WIF maps wrong AWS role/project/permission                           | M   | C   | Exact `sub`; fixed audience; 300-second max; separate env projects; `api.model.request`                 | Positive/negative token-exchange tests           | 1     |
| T-22 | Model/provider outage or safeguards stall run                        | H   | M   | Bounded timeout/retry; explicit terminal code; quota alarms; no unsafe fallback                         | Rate-limit, timeout, refusal injection           | 1     |
| T-23 | Notification content causes injection/leak                           | M   | H   | Templates; escaped fields; no source; allowlisted links; recipient authorization                        | Template/XSS/header-injection tests              | 7     |
| T-24 | Publisher or App merges code unexpectedly                            | L   | C   | No merge code; draft only; branch protection; audit webhook; unexpected merge alert                     | Static API allowlist and integration tests       | 7     |

Legend: likelihood `L/M/H`; impact `M/H/C` where `C` is critical.

## 9. Abuse cases

### AC-01: Malicious repository instructs the model to steal secrets

The repository contains a comment telling the agent to call a URL or read
environment variables. The model may repeat the request, but no such tool is
registered. The agent has no general HTTP, GitHub, database, secret, or shell
tool. The attempt is recorded as a policy rejection without persisting the
source text.

### AC-02: Reviewer approves candidate A but client submits repository B

The approval endpoint accepts the candidate ID from the scoped route and only
the impact revision/acknowledgements in the body. The server derives repository,
installation, specification, and current actor. Any extra repository identifier
is rejected as an unknown field.

### AC-03: Test process reads task credentials

The verifier process has no reusable task-role credential. It receives
one-object input/output capabilities only long enough for trusted bootstrap and
upload; capability values are removed before test spawn. Network is denied
during test execution.

### AC-04: Publisher succeeds at GitHub but database write fails

The branch name contains the run ID. Retry searches GitHub by deterministic head
branch and reconciles the existing PR instead of creating another.

### AC-05: OpenAI request times out after processing

The model call can be retried under a new attempt, but local tool actions use
persisted sequence/idempotency keys. A timeout never causes a side-effecting
tool to run twice without reconciliation.

## 10. Data classification and handling

| Class             | Examples                               | Minimum handling                                    |
| ----------------- | -------------------------------------- | --------------------------------------------------- |
| Public            | Public vendor release notes            | Integrity/provenance; untrusted content             |
| Internal          | Policy and tool versions               | Authenticated access; change audit                  |
| Customer metadata | Repo name, dependency, run status      | Tenant authorization; avoid metric dimensions       |
| Customer source   | Snapshot and selected excerpts         | KMS, narrow IAM, shortest retention, never logs     |
| Customer-derived  | Patch, impact report, verification log | KMS, tenant scope, bounded display and retention    |
| Secret            | Keys, tokens, connection strings       | Secret manager or memory only; never artifact/state |

## 11. Residual risks accepted for the pilot

- The installed GitHub App has broader technical capability than one approved
  migration. This is accepted only for selected repositories with broker and
  publisher separation and must be tested with design partners.
- Selected source is processed by OpenAI under the project’s actual data
  controls. `store:false` is required but is not described as zero retention.
- Fargate contains hostile tests but is not a formally verified sandbox.
- Verification may be incomplete; the product reports coverage and requires
  human review.
- Vendor documentation can be incomplete or wrong; human promotion is required
  initially.

## 12. Review gates

The threat model must be updated before:

- Stage 2 adds GitHub repository access;
- Stage 3 adds external vendor fetching;
- Stage 5 adds patch creation;
- Stage 6 executes repository code;
- Stage 7 adds GitHub write effects;
- Stage 8 processes a real design-partner repository;
- any new model-hosted tool, private registry credential, language, or source
  provider is added.

Stage 0 security design is complete when this document and the data flow are
reviewed. Product validation is not complete until interviews test the accepted
residual risks.
