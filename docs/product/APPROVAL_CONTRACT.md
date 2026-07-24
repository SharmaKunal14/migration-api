# Migration approval and customer-facing copy contract

- **Status:** Stage 0 baseline
- **Contract version:** 1.0
- **Date:** 2026-07-24
- **Owners:** Product, security, and legal review

## 1. Purpose

This contract separates:

1. GitHub App installation consent;
2. read-only repository analysis;
3. approval to prepare one migration and publish one draft pull request; and
4. the customer’s independent decision to merge.

It defines product semantics and implementation requirements. It is not a
replacement for customer terms, privacy notice, or legal review.

## 2. Non-negotiable semantics

- Installation is not migration approval.
- Analysis is read-only.
- Approval is bound to one repository, exact evidence revision, and base state.
- Approval may authorize branch and draft-PR creation, but never merge or
  deployment.
- If the approved state becomes stale, the run stops or requires a new
  approval.
- The server derives sensitive scope; the browser cannot nominate another
  repository or installation.
- An approval record is append-only. Revocation is a separate timestamp/event.
- Revocation prevents work that has not begun; it does not pretend that an
  already-created branch or PR never existed.

## 3. Installation disclosure

### Heading

> Connect selected GitHub repositories

### Body

> Migration API reads only the repositories you select to detect supported API
> and SDK migrations. The GitHub App requests Contents: write and Pull requests:
> write because a later migration approval can ask it to create a branch and a
> draft pull request.
>
> Installing the App does not authorize Migration API to prepare or publish a
> migration. Each migration requires a separate approval inside Migration API.
> The platform does not merge or deploy code.

### Permission list

- Metadata: read repository identity and default branch.
- Contents: read source and, only after migration approval, create a migration
  branch.
- Pull requests: inspect and, only after migration approval, create or update a
  draft pull request.

### Required selection

> Choose specific repositories. Migration API does not recommend granting
> access to all repositories for the initial pilot.

The UI must not describe the installation as read-only because the GitHub
permission grant is not read-only.

## 4. Read-only analysis disclosure

### Action label

> Analyze repository

### Body

> Migration API will take a bounded snapshot of the selected repository at the
> displayed commit, detect supported dependencies, and send only selected
> relevant excerpts to the configured OpenAI project for impact analysis.
> Analysis does not create a branch, modify a file, run repository code, or open
> a pull request.

The exact OpenAI retention wording is selected from the deployed project
configuration. `store: false` alone must not be presented as zero retention.

## 5. Migration approval view

Before the approval control, display:

| Field                   | Required value                                       |
| ----------------------- | ---------------------------------------------------- |
| Organisation            | Current authorised organisation                      |
| Repository              | Owner/name and immutable GitHub repository ID        |
| Base                    | Branch plus exact analyzed commit                    |
| API/SDK                 | Canonical product/package                            |
| Transition              | Current and target compatibility                     |
| Migration specification | Immutable revision and evidence trust state          |
| Impact report           | Immutable revision, affected areas, and uncertainty  |
| Proposed scope          | Allowed paths/categories and change budgets          |
| Verification            | Named profile and known unavailable checks           |
| Data processing         | Actual OpenAI project mode and retention disclosure  |
| Publication             | Deterministic branch and draft pull-request behavior |
| Staleness               | Conditions that invalidate this approval             |

### Heading

> Approve preparation of this migration

### Body

> Migration API will reacquire or confirm the exact approved source, send the
> minimum relevant source context to OpenAI, prepare a bounded patch in an
> isolated workspace, and run the displayed verification profile.
>
> If the patch passes the configured publication policy, Migration API may
> create a branch and a draft pull request in **{repository}**. Creating a pull
> request can trigger repository automation and notifications.
>
> Migration API will not approve, merge, or deploy the pull request. The impact
> analysis and verification may be incomplete, and a human must review the
> result.

### Required acknowledgements

Unchecked by default:

1. > I authorize processing the displayed source scope for this migration.
2. > I authorize the displayed verification commands to run against a disposable
   > copy of the repository.
3. > I authorize creation of one migration branch and one draft pull request if
   > publication checks pass.
4. > I understand that Migration API will not merge or deploy the result and
   > that human review remains required.

### Primary action

> Approve and prepare migration

Avoid labels such as “Fix automatically,” “Apply safely,” or “Upgrade now.”
They imply certainty or deployment authority the product does not have.

## 6. Data-processing disclosure variants

The application must render the variant matching the actual OpenAI project.

### Default provider controls

> Selected source excerpts and vendor evidence are processed by OpenAI. Migration
> API sets API response storage off. OpenAI states that API data is not used to
> train its models unless the customer opts in; default abuse-monitoring logs
> may retain content for up to 30 days. See the linked data notice for the
> current configuration.

### Verified ZDR project

> Selected source excerpts and vendor evidence are processed by OpenAI using the
> project identified in our data notice. That project is configured for OpenAI
> Zero Data Retention for the enabled features, and Migration API sets API
> response storage off.

The ZDR variant may be shown only after an automated or release-checked
configuration assertion and documented account approval. Feature exceptions or
provider changes require the text to fall back to the accurate default variant.

## 7. Server-side approval record

The append-only record contains:

- approval ID;
- contract version;
- organisation ID;
- candidate ID;
- repository ID and GitHub numeric ID;
- installation ID;
- base branch and exact commit SHA;
- repository snapshot artifact ID and digest;
- migration-specification ID and immutable revision/digest;
- impact-report ID and immutable revision/digest;
- agent policy version;
- tool-registry version;
- patch policy version and concrete limits;
- verification policy/profile version;
- publication policy version;
- OpenAI processing-policy version;
- acknowledgement booleans;
- approving user ID and current role;
- approval timestamp;
- request and correlation IDs;
- idempotency key and request digest;
- expiry when policy requires it;
- later revocation timestamp and actor, if any.

Do not store a mutable copy of the UI summary as authority. Store immutable IDs,
versions, digests, and a rendered-copy digest for audit.

## 8. API request boundary

Conceptual request:

```json
{
  "impactReportRevision": 3,
  "approvalContractVersion": "1.0",
  "acknowledgements": {
    "sourceProcessing": true,
    "verificationExecution": true,
    "draftPullRequest": true,
    "humanReviewRequired": true
  }
}
```

The request also requires an `Idempotency-Key` header.

The client cannot submit:

- organisation ID;
- repository ID;
- installation ID;
- base commit;
- migration specification;
- policy versions;
- GitHub permissions;
- branch name.

Unknown request fields are rejected.

## 9. Transaction and authorization

Within one database transaction:

1. Authenticate the user.
2. Lock and load the candidate by candidate plus organisation.
3. Load current membership and require Owner, Admin, or Reviewer.
4. Confirm repository selection and active installation.
5. Confirm candidate is open and specification is reviewed.
6. Confirm impact revision, snapshot, and base are current.
7. Resolve current policy versions and limits.
8. Validate every acknowledgement.
9. Insert immutable approval.
10. Insert one migration run.
11. Insert one outbox event.
12. Commit.

Same idempotency key and request digest returns the existing result. Same key
with another digest returns a conflict.

## 10. Staleness and revocation

Approval becomes unusable before work starts if:

- repository or installation is removed/suspended;
- base policy requires an exact commit and it moved;
- impact or migration specification is superseded;
- security/policy version is revoked;
- approval expires;
- approving user lacked authority at approval time;
- approval is revoked.

After work starts:

- safe stages check cancellation/revocation;
- already-created GitHub effects are retained and reported;
- a changed base causes `stale`, not silent rebase;
- a new attempt references the original but requires policy-defined
  re-approval.

## 11. Result wording

### Draft PR created

> Draft pull request created. Verification result: **{result}**. Migration API
> did not merge or deploy this change. Review the evidence and repository checks
> before deciding whether to merge.

### Verification incomplete

> Migration prepared, but verification was incomplete: **{reason}**. No check
> has been presented as passed. Publication followed policy **{policyVersion}** /
> publication was withheld.

### Stale

> The repository or reviewed evidence changed after approval. Migration API did
> not apply the approved plan to the new state. Review the updated impact report
> and approve a new attempt.

## 12. Accessibility and audit requirements

- Acknowledgements use real labels and keyboard-operable controls.
- Scope and warnings are visible text, not tooltip-only.
- Colour is not the only status signal.
- The approval action has a confirmation result with request ID.
- The rendered contract version and copy digest are recorded.
- Product analytics records the funnel step, not source or acknowledgement text.

## 13. Validation checklist

- Viewer and non-member cannot approve.
- Stale impact revision fails with conflict.
- Unknown field fails validation.
- Missing acknowledgement fails validation.
- Duplicate same request returns the original run.
- Duplicate key with different body fails conflict.
- Installation removal and approval revocation fail closed.
- UI tests confirm no merge/deploy implication.
- Data-processing copy matches the deployed OpenAI control mode.
