# Migration API

Migration API is a cloud-first product for reviewing and executing bounded API and SDK
migrations. Stage 1 implements an authenticated synthetic migration path through AWS
Step Functions, an isolated Fargate agent, OpenAI Responses, encrypted S3 artifacts,
Supabase PostgreSQL, and a static React UI. 

The architecture and security baseline are authoritative in [docs](docs/README.md).

# Local verification

Requirements:

- Node.js 22.14.0
- npm 10.9.2
- Terraform 1.15.8 for infrastructure validation

```bash
npm ci
npm run check
```

Local tests use deterministic substitutes. They do not prove that AWS, Supabase, or
OpenAI account configuration is correct. Stage 1 passes only after the cloud acceptance
evidence in
[STAGE_1_ACCEPTANCE_CHECKLIST.md](docs/stages/STAGE_1_ACCEPTANCE_CHECKLIST.md) is
recorded.
