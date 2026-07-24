# ADR-0007: Publish draft pull requests and never merge automatically

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Product engineering and product security

## Context

The system can generate and verify a migration patch, but automated tests and
model reasoning cannot prove production safety. The customer’s normal code
review and branch-protection process is the final authority.

Known:

- The GitHub App permissions needed to create branches and pull requests may
  also technically allow broader mutations.
- Branch protection, required checks, and CODEOWNERS vary by repository.
- Some repositories have absent, partial, or flaky verification.

Assumed:

- A draft pull request fits the initial customer review process.
- Customers retain their existing merge controls.

## Decision

Migration API may create or update one deterministic draft pull request only
after a valid, current migration approval. It never:

- marks its pull request ready for review automatically;
- approves its own pull request;
- enables auto-merge;
- calls a merge endpoint;
- bypasses branch protection;
- force-pushes unrelated branches;
- deploys the result.

The model and verifier have no GitHub credentials. A deterministic trusted
publisher:

1. reloads the immutable approval and current run;
2. revalidates installation and repository selection;
3. verifies patch key, digest, base commit, allowed paths, and budgets;
4. obtains a one-operation installation token from the broker;
5. creates or finds the deterministic branch and draft pull request;
6. records provider IDs and reconciles partial failures;
7. discards the token.

The publisher code exposes no merge operation. An unexpected App-authored merge
event is a security alert.

## Pull-request truthfulness contract

The pull-request body includes:

- API/SDK and version transition;
- exact base commit;
- human approver recorded by Migration API;
- vendor and repository evidence;
- changed files and transformation summary;
- verification profile and every result;
- skipped, partial, unavailable, or timed-out checks;
- model/tool/policy versions where useful;
- uncertainty and manual-review requirements;
- explicit statement that the platform did not merge or deploy.

`partial`, `unavailable`, and `timed_out` are never presented as passed.

## Consequences

Benefits:

- Human review and existing repository governance remain decisive.
- The product delivers into a familiar engineering workflow.
- A failed or uncertain migration remains inspectable without reaching
  production.

Costs and residual risk:

- Draft creation is still a repository mutation.
- A bad patch can consume reviewer time or trigger repository automation.
- GitHub permissions cannot express “may create a draft but may never merge.”
  The prohibition is enforced by architecture, code, tests, monitoring, and
  customer branch protection.
- Creating a PR can trigger external CI and notifications; approval copy must
  disclose this.

## Rejected alternatives

- **Automatic merge after green tests:** tests do not establish complete safety
  and the product lacks production context.
- **Model publishes directly:** exposes repository credentials to untrusted
  reasoning and prompt injection.
- **Return a downloadable patch only:** is safer but fails the intended
  workflow; retain as a possible customer policy option later.

## Reversal triggers

Automatic merge is not a planned progression. Any future proposal requires a
new explicit product mandate, customer-specific opt-in, independent security
review, and a superseding ADR. Passing more tests is not sufficient evidence by
itself.

## Validation

- Static and integration tests prove no merge endpoint or auto-merge operation
  exists in publisher code.
- Duplicate publication produces one branch and one draft pull request.
- Stale base, revoked installation, invalid approval, or patch-policy failure
  prevents publication.
- A test repository’s branch protection remains effective.
- The UI and PR body display verification limitations without optimistic
  wording.

## References

- [GitHub REST pull-request API](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
