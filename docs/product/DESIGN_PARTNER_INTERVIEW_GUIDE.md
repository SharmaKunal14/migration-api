# Design-partner interview guide

- **Status:** Ready for interviews
- **Version:** 1.0
- **Date:** 2026-07-24
- **Required Stage 0 sample:** At least five qualified interviews
- **Required outcome:** At least one prospective design partner willing to test
  onboarding on a non-production repository

## 1. Research questions

We need evidence for:

1. Are API/SDK migrations frequent and painful enough to matter?
2. Who feels the pain and who can authorize repository access?
3. Will a qualified team install a GitHub App with contents-write permission?
4. Will they permit selected source processing by OpenAI?
5. What evidence is required before they review or merge an agent-created PR?
6. Is the initial buyer the API customer, the API vendor, or neither?

The interview is not complete merely because the participant likes the idea.

## 2. Qualified participant

Target:

- senior engineer, engineering manager, developer productivity engineer, or
  platform engineer;
- maintains a production TypeScript/JavaScript service;
- integrates at least one external API or SDK;
- has experienced a breaking SDK/API migration in the last 12 months or owns
  dependency upgrades;
- understands or influences GitHub App installation policy.

Record whether the participant can personally install an App. Do not treat
someone without repository responsibility as proof of permission acceptance.

## 3. Recruitment message

> I’m researching how teams handle breaking API and SDK upgrades. I’m not asking
> you to buy anything. I’d like to understand the last migration your team did
> and show a permission/review workflow for a product that prepares draft
> migration pull requests. The call is 30 minutes. I won’t ask for production
> repository access.

## 4. Interview structure

### 0–3 minutes: context and consent

- Explain that notes are for product research.
- Ask permission before recording.
- State that no credentials or source code are required.
- Collect role, team size, primary languages, and GitHub hosting.

### 3–15 minutes: last real migration

Ask about behavior, not opinion:

1. Tell me about the last breaking API or SDK upgrade you handled.
2. What triggered the work?
3. How did you find every affected call site?
4. Who read the vendor documentation?
5. What was ambiguous or wrong in the documentation?
6. How long did analysis, implementation, and review take?
7. Which part required the most senior judgment?
8. What tests or evidence made you comfortable?
9. What broke or nearly broke?
10. What happened when the upgrade was postponed?

Capture concrete dates, people, time, and outcomes. “It is annoying” without an
example is weak evidence.

### 15–20 minutes: current process and alternatives

1. Which tools already open dependency-update PRs?
2. Why are those PRs accepted, ignored, or closed?
3. When does a migration require more than a version bump?
4. Would you pay for the problem to disappear, assign it internally, or accept
   the delay?
5. Who owns the budget and who owns security approval?

Do not describe Migration API before understanding the current workaround.

### 20–27 minutes: artifact and trust test

Show, in order:

1. the GitHub permission screen;
2. the read-only impact report for the OrbitChat scenario;
3. the approval copy;
4. the verification evidence and draft PR.

Ask:

- What do you believe the App can do immediately after installation?
- Which permission, if any, stops you?
- Would selected repositories change the answer?
- Would you prefer a second write-only App at publication time?
- What does “selected source is processed by OpenAI” mean to your policy team?
- Is default abuse-monitoring retention acceptable? Would you require verified
  ZDR?
- What evidence is missing before approval?
- Which files should the system never touch?
- Should a PR be withheld when tests are partial, or created with a warning?
- Who should be notified?
- What would make you uninstall the App?

Ask the participant to explain the flow back. Misunderstanding is a product
failure even if the copy sounded acceptable to us.

### 27–30 minutes: commitment test

Use the strongest appropriate ask:

> Would you install this on a non-production repository and evaluate one real
> migration with us in the next two weeks?

If no:

- What specifically blocks it?
- Who else must approve?
- What evidence or architecture change would remove the block?
- May we follow up after that change?

Do not substitute “keep me updated” for design-partner commitment.

## 5. Permission experiment

Randomize only when enough participants exist:

- Variant A: one App asks for contents-write during initial installation.
- Variant B: read-only analyzer App first; second publisher installation is
  required after approval.

Measure:

- comprehension;
- willingness to proceed;
- perceived security;
- expected internal approval time;
- abandonment point.

With five interviews the evidence will be directional, not statistically
strong. Record individual reasons rather than reporting percentages as market
truth.

## 6. Scorecard

Complete immediately after each interview.

| Dimension                    | 0                            | 1                        | 2                                              |
| ---------------------------- | ---------------------------- | ------------------------ | ---------------------------------------------- |
| Recent pain                  | No relevant migration        | Minor/infrequent         | Costly, delayed, or risky migration            |
| Existing workaround          | Satisfactory                 | Manual but tolerable     | Clearly inadequate                             |
| Repository authority         | No influence                 | Influences approver      | Can install/authorize pilot                    |
| GitHub permission acceptance | Rejects both designs         | Conditional              | Accepts a concrete pilot design                |
| OpenAI processing acceptance | Prohibited                   | Requires controls/review | Accepts disclosed configuration                |
| Evidence need matched        | Workflow misses key evidence | Fixable gaps             | Existing design answers review need            |
| Commitment                   | Polite interest              | Named follow-up          | Scheduled test/pilot with repository and owner |

Do not sum the score into false precision. Use it to compare evidence
consistently.

## 7. Interview record template

```text
Interview ID:
Date:
Participant role:
Company/team profile:
Can authorize GitHub installation?:
Last relevant migration:
Measured time/impact:
Current tools/workaround:
Permission reaction:
OpenAI/data reaction:
Required evidence:
Purchase/budget owner:
Strongest objection:
Commitment and date:
Direct quotes approved for use?:
Follow-up owner:
Researcher confidence and why:
```

Store no customer source, credentials, or unnecessary personal data in research
notes.

## 8. Decision rules after five interviews

Proceed to deep GitHub automation only if:

- at least three qualified participants describe a concrete recent problem;
- at least one qualified participant commits to testing onboarding on a
  non-production repository;
- the GitHub permission design has a plausible path through their security
  process; and
- the OpenAI processing model is accepted or has a concrete attainable control
  requirement.

Change the design if:

- two or more otherwise-qualified participants reject upfront write permission
  as the primary blocker—test separate analyzer/publisher Apps;
- required ZDR or data residency is unavailable—do not process their source;
- users value impact analysis but reject publication—consider a read-only
  product or downloadable patch;
- API vendors, rather than customers, consistently own urgency and budget—test
  a vendor-distributed migration specification product.

Stop or narrow the product if participants do not report costly migrations or
will not take a concrete pilot step.

## 9. Evidence quality

Strong:

- repository installation scheduled;
- security reviewer introduced;
- real migration candidate supplied without source disclosure;
- pilot success criteria agreed;
- budget owner identified.

Weak:

- “I would use this”;
- praise for the demo;
- social-media interest;
- agreement from people without repository responsibility;
- hypothetical willingness without a next action.

## 10. Stage 0 completion recording

Update [Stage 0 completion](../stages/STAGE_0_COMPLETION.md) after each interview.
Stage 0 is not fully complete until the interview and design-partner gates have
real evidence. Codex can prepare this guide but cannot truthfully satisfy those
human gates.
