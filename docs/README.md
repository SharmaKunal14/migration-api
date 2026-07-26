# Migration API documentation

This directory contains the greenfield product and engineering baseline for
Migration API. The implementation plan is the system overview. Stage documents
turn that overview into versioned decisions, security boundaries, contracts,
and measurable exit gates.

## Authoritative documents

- [Implementation plan](IMPLEMENTATION_PLAN.md)
- [Stage 0 completion status](stages/STAGE_0_COMPLETION.md)
- [Stage 1 infrastructure inventory](stages/STAGE_1_INFRASTRUCTURE_INVENTORY.md)
- [Stage 1 acceptance checklist](stages/STAGE_1_ACCEPTANCE_CHECKLIST.md)
- [Stage 1 implementation status](stages/STAGE_1_IMPLEMENTATION_STATUS.md)
- [Stage 1 deployment runbook](runbooks/STAGE_1_DEPLOYMENT.md)
- [Disable demo runs](runbooks/DISABLE_DEMO_RUNS.md)
- [Stage 1 CI/CD](runbooks/CI_CD.md)
- [Stage 3D implementation status](stages/STAGE_3D_IMPLEMENTATION_STATUS.md)
- [Stage 3D deployment runbook](runbooks/STAGE_3D_DEPLOYMENT.md)
- [Stage 3E implementation status](stages/STAGE_3E_IMPLEMENTATION_STATUS.md)
- [Stage 3E deployment runbook](runbooks/STAGE_3E_DEPLOYMENT.md)

## Architecture decisions

- [ADR index](adr/README.md)
- [ADR-0001: Static React frontend](adr/0001-static-react-frontend.md)
- [ADR-0002: Supabase Auth and PostgreSQL](adr/0002-supabase-auth-postgres.md)
- [ADR-0003: GitHub App permissions](adr/0003-github-app-permissions.md)
- [ADR-0004: Step Functions Standard](adr/0004-step-functions-standard.md)
- [ADR-0005: Fargate trust zones](adr/0005-fargate-trust-zones.md)
- [ADR-0006: OpenAI agent runtime](adr/0006-openai-agent-runtime.md)
- [ADR-0007: Draft pull requests without automatic merge](adr/0007-draft-pr-no-auto-merge.md)

## Security and product contracts

- [Threat model](architecture/THREAT_MODEL.md)
- [Security data flow](architecture/DATA_FLOW.md)
- [Synthetic OrbitChat scenario](product/SYNTHETIC_SCENARIO.md)
- [Migration approval contract](product/APPROVAL_CONTRACT.md)
- [Design-partner interview guide](product/DESIGN_PARTNER_INTERVIEW_GUIDE.md)
- [Versioned contract schemas](contracts/README.md)

## Document status

An ADR marked `Accepted` is the implementation default. It can be changed only
by a superseding ADR. An acceptance checklist is evidence, not a promise:
unchecked items remain incomplete even when the relevant design exists.

External service behavior and terms can change. Re-verify cited provider
documentation before production deployment.
