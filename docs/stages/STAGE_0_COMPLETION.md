# Stage 0 completion status

- **Status:** Engineering artifacts complete; human product-validation gate open
- **Version:** 1.0
- **Updated:** 2026-07-24

## 1. Written deliverables

- [x] Greenfield implementation plan adopted as the working baseline.
- [x] ADR index and seven accepted ADRs.
- [x] Threat model.
- [x] Security data-flow and credential-boundary diagram.
- [x] Synthetic OrbitChat vendor/customer evaluation scenario.
- [x] Migration approval semantics and customer-facing copy.
- [x] Design-partner interview guide and evidence scorecard.
- [x] Version 1 agent-run contract.
- [x] Version 1 agent-action contract.
- [x] Version 1 tool-definition contract.
- [x] Version 1 workflow-event contract.
- [x] Version 1 artifact-reference contract.
- [x] Valid example prepared for each contract.
- [x] Stage 1 infrastructure inventory.
- [x] Stage 1 acceptance checklist.

## 2. Verification of written artifacts

- [x] All JSON files parse.
- [x] All schemas pass Draft 2020-12 meta-schema validation.
- [x] Every example validates against its schema.
- [x] OpenAI strict-tool semantic lint passes.
- [x] Markdown formatting passes.
- [x] Markdown lint passes under the repository configuration.
- [x] Internal relative links resolve.
- [x] No alternative model-provider decision remains active.
- [x] No secret-like value is present.

Evidence recorded on 2026-07-24:

- `jq 1.7.1` parsed all ten JSON files.
- `ajv-cli 5.0.0` compiled all five Draft 2020-12 schemas and validated all
  five examples. Format annotations were checked separately because the
  ephemeral CLI did not load optional format plugins.
- A Node.js semantic check confirmed strict tool required/property set equality
  and example UUID/date-time shape.
- `prettier 3.9.5` reported all documentation formatted.
- `markdownlint-cli2 0.18.1` reported zero errors.
- A local-link check resolved links across all documentation Markdown files.
- Targeted provider and secret-pattern scans returned no stale provider or
  secret-like matches.

## 3. Human gates

- [ ] Interview 1 completed and recorded.
- [ ] Interview 2 completed and recorded.
- [ ] Interview 3 completed and recorded.
- [ ] Interview 4 completed and recorded.
- [ ] Interview 5 completed and recorded.
- [ ] At least one qualified participant agrees to test onboarding on a
      non-production repository.
- [ ] GitHub contents-write objection is tested with the actual permission copy.
- [ ] OpenAI processing/retention objection is tested with accurate disclosure.
- [ ] Approval/no-auto-merge copy is understood when participants explain it
      back.
- [ ] Threat model and data flow receive an owner review.
- [ ] Stage 1 regions and OpenAI data-control mode are decided.

## 4. Current evidence

| Gate                         | Evidence              | Conclusion                    |
| ---------------------------- | --------------------- | ----------------------------- |
| API migration pain           | None yet              | Unknown                       |
| GitHub permission acceptance | None yet              | Unknown                       |
| OpenAI processing acceptance | None yet              | Unknown                       |
| Draft-PR evidence value      | Synthetic design only | Unproven                      |
| Design-partner commitment    | None yet              | Stage 0 exit is not satisfied |

## 5. Exit rule

Stage 0 is fully complete only when:

1. written artifacts pass verification;
2. at least five qualified interviews are recorded;
3. at least one prospective design partner makes a concrete pilot commitment;
4. the main permission and model-processing objections have evidence-backed
   dispositions; and
5. Stage 1 provider-region/data-control decisions are recorded.

Engineering may begin Stage 1 before every interview only through an explicit
product-risk decision. It must not report the untested assumptions as validated
customer demand.

## 6. Next actions

1. Run artifact validation and update section 2 with evidence.
2. Conduct the five interviews using the prepared guide.
3. Record the region and OpenAI data-control decisions.
4. Review the threat model with the implementation owner.
5. Start Stage 1 only after the exit rule or an explicit risk acceptance.
