# Stage 7 acceptance

Stage 7 publishes one deterministic draft pull request, follows its GitHub
lifecycle, and records an in-app reviewer notification. It never approves,
merges, or deploys the pull request.

## GitHub App prerequisite

In the development GitHub App settings, keep these repository permissions:

- Contents: read and write.
- Pull requests: read and write.
- Metadata: read-only.

Subscribe the App to the **Pull request** event. Keep the existing webhook URL
and webhook secret. Do not create another GitHub App or webhook endpoint.

## Acceptance flow

1. Deploy the development environment from an exact reviewed commit.
2. Run a migration whose verification result is `passed`.
3. Confirm the migration timeline reaches `Run completed`.
4. Confirm the Stage 7 card contains:
   - the deterministic `migration-api/run-<run-id>` branch;
   - the exact base and publication commit identifiers;
   - one GitHub draft pull request link;
   - an in-app notification status.
5. Open the GitHub link and confirm the pull request is a draft.
6. Mark it ready for review, close it, reopen it, or merge it manually.
7. Reload the run page and confirm the GitHub state and reconciliation time
   match the signed webhook event.

Retrying the workflow must not create another branch or pull request. A pull
request event with a mismatched repository, node ID, URL, base, or head branch
must fail reconciliation without changing the stored publication identity.

## Operator checks

Tail reconciliation and notification logs:

```bash
aws logs tail \
  /aws/lambda/migration-api-development-github-reconciler \
  --region ap-southeast-2 \
  --since 30m \
  --format short

aws logs tail \
  /aws/lambda/migration-api-development-outbox \
  --region ap-southeast-2 \
  --since 30m \
  --format short
```

Expected structured events include `github_pull_request_reconciled` and
`publication_notification_delivered`. Do not copy GitHub installation tokens,
private keys, or webhook secrets into diagnostic commands.
