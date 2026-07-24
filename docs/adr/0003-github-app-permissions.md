# ADR-0003: Use one selected-repository GitHub App initially

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** GitHub integration and product security

## Context

Migration API must read private repositories and, after approval, create a
branch and draft pull request. GitHub App installation permissions are granted
at installation time, not when a user later clicks “Approve migration.”

Known:

- HTTP Git access requires the GitHub App `Contents` permission.
- Creating a draft pull request requires `Pull requests: write`.
- Installation tokens expire after one hour and can be narrowed to selected
  repositories and permissions when minted.
- An installation token acts as the App bot, not as the approving user.

Assumed:

- Initial design partners accept one installation on explicitly selected
  repositories.
- Bot attribution is acceptable for the pilot.
- Asking for two separate App installations would create more onboarding
  friction than it removes.

The important limitation is explicit: product approval is an application-level
authorization boundary. It does not remove the GitHub write capability already
granted to the installed App.

## Decision

Use one GitHub App for the initial product with:

| Repository permission | Level |
| --------------------- | ----- |
| Metadata              | Read  |
| Contents              | Write |
| Pull requests         | Write |

Subscribe only to:

- `installation`
- `installation_repositories`
- `repository`
- `push`
- `pull_request`

Do not request Administration, Actions, Workflows, Secrets, Deployments,
Environments, or organisation-member permissions.

Install on selected repositories, never “all repositories” by product default.
Use Supabase GitHub login separately for dashboard identity.

## Capability separation

- The source fetcher requests a token limited to one repository and read-only
  contents.
- The agent receives no GitHub token or GitHub client.
- The verifier receives no GitHub token.
- Only the trusted publisher can request contents-write and pull-request-write
  permissions.
- The broker validates run, repository, installation, caller role, intended
  operation, and approval before minting a token.
- Tokens remain in memory and are discarded after the operation; their
  one-hour provider lifetime is not a caching policy.
- The publisher rejects `.github/workflows/**`, governance paths, and
  out-of-scope files even though the App can write ordinary contents.

The GitHub App private key is readable only by the token-broker workload.

## Consequences

Benefits:

- One installation supports the complete customer journey.
- Selected-repository installation limits blast radius.
- GitHub emits installation lifecycle events for reconciliation.

Costs and residual risk:

- Customers see write permission before they have approved a migration.
- A compromised token broker or publisher could exercise granted write access.
- Pull-request write permission is broader than “create this one draft PR.”
- Application approval is not independently enforced by GitHub.

These are material adoption and security risks, not wording problems.

## Rejected alternatives

- **Separate analyzer and publisher Apps now:** provides a stronger installation
  boundary but requires a second installation at the moment of migration.
- **User access tokens now:** improve human attribution but introduce consent,
  refresh-token, SSO, and lifecycle complexity before demand is proven.
- **Customer-side patch application:** reduces server-side write authority but
  weakens the initial automated product loop.

## Reversal triggers

Adopt separate read-only/write Apps, customer-hosted publication, or user access
tokens if:

- two or more qualified design partners reject installation primarily because
  of upfront contents-write permission;
- enterprise policy requires GitHub-side human attribution; or
- a security review rejects the shared App capability boundary.

## Validation

- Interview at least five target users using the actual permission screen.
- Unselected repositories cannot be fetched or token-scoped.
- Installation removal or suspension blocks new work immediately.
- Broker authorization tests cover caller, operation, repository, approval,
  expiration, and cross-tenant substitution.
- Tokens and private keys never appear in state, artifacts, logs, or browser
  responses.

## References

- [GitHub App permission selection](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app)
- [Create a pull request](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)
