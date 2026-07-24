# ADR-0001: Serve a static React application through CloudFront

- **Status:** Accepted
- **Date:** 2026-07-24
- **Owners:** Product engineering

## Context

Migration API needs an authenticated dashboard from the first deployed
milestone. The initial UI is a workflow client: authentication, onboarding,
migration evidence, approval, and run status. It does not require public
content pages, search indexing, or server-rendered application data.

Known:

- All sensitive mutations are server-authorized through API Gateway.
- Repository source and secrets must never be embedded in frontend assets.
- Stage 1 needs a repeatable cloud deployment with minimal runtime surface.

Assumed:

- Initial product routes do not need search-engine indexing.
- Authenticated polling is adequate before workflow event semantics stabilize.
- A single product origin is operationally preferable.

## Decision

Build the frontend with React, strict TypeScript, Vite, and React Router.

Deploy content-addressed static assets to a private S3 bucket and serve them
through CloudFront with Origin Access Control. Route `/api/*` to API Gateway and
all application routes to the static application fallback. The browser uses one
public product origin.

Supabase Auth handles login with PKCE. The browser presents the Supabase access
token to the API. It does not read or mutate core business tables directly.

Required controls:

- CloudFront HTTPS redirect and modern TLS policy.
- AWS WAF managed baseline rules with rate-based protection.
- Strict Content Security Policy without unsafe inline script.
- `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, and an
  explicit `connect-src`.
- `Referrer-Policy`, `X-Content-Type-Options`, and an appropriate permissions
  policy.
- No secrets or sensitive source in bundles, browser logs, analytics, or error
  reporting.
- Model- and vendor-generated text rendered as untrusted text; rich content is
  disabled until a reviewed sanitizer is required.
- Allowlisted post-authentication return paths; no arbitrary redirects.

## Consequences

Benefits:

- No long-running frontend server.
- Independent cache policy for immutable assets and APIs.
- One origin simplifies CORS, cookies, and browser security policy.
- Rollback is an atomic CloudFront manifest/origin-version change.

Costs and limitations:

- No server-side rendering.
- Authentication loading and initial data loading occur in the browser.
- CloudFront fallback behavior needs explicit tests so API errors are never
  rewritten to `index.html`.
- Cached HTML must have a short or no-cache policy while hashed assets can be
  immutable.

## Rejected alternatives

- **Next.js/SSR:** adds a runtime and caching boundary without an initial product
  requirement.
- **Direct Supabase CRUD from the browser:** weakens the server authorization and
  audit boundary even if RLS is enabled.
- **Separate frontend and API origins:** creates avoidable CORS and redirect
  complexity.

## Reversal triggers

Revisit if measured requirements demand server rendering, public vendor pages,
edge personalization, or a browser realtime channel that authenticated polling
cannot satisfy.

## Validation

- Deep links return the application shell.
- `/api/*` failures remain API failures.
- CSP tests reject inline script and unapproved network destinations.
- Built assets contain no secret-like configuration.
- Cross-tenant authorization tests pass regardless of hidden UI controls.

## References

- [AWS CloudFront security best practices](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/SecurityAndPrivateContent.html)
- [Supabase Auth PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
