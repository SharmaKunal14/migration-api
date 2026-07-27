import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const handler = read('services/api/src/handler.ts');
const repository = read('services/api/src/repository.ts');
const web = read('apps/web/src/app.tsx');
const webApi = read('apps/web/src/api.ts');
const compute = read('infra/terraform/environments/development/compute.tf');
const iam = read('infra/terraform/environments/development/iam.tf');

describe('impact-analysis refresh UI boundary', () => {
  it('starts analysis only through an authenticated tenant-scoped API request', () => {
    expect(handler).toContain('/impact-analysis$/u.exec');
    expect(repository).toContain("'impact_analysis:request'");
    expect(repository).toContain(
      ".where('candidate.organisationId', '=', input.organisationId)",
    );
    expect(repository).toContain("'repository:scan'");
    expect(repository).toContain("'IMPACT_ANALYSIS_IN_PROGRESS'");
  });

  it('keeps Step Functions credentials and execution control out of the browser', () => {
    expect(webApi).toContain('/impact-analysis`');
    expect(web).toContain("'Refresh impact analysis'");
    expect(web).toContain("'Run impact analysis'");
    expect(web).toContain('Analysis is queued. This page will update automatically.');
    expect(webApi).not.toContain('@aws-sdk/client-sfn');
    expect(web).not.toContain('@aws-sdk/client-sfn');
  });

  it('grants the API least-privilege access to only the impact workflow', () => {
    expect(compute).toContain(
      'IMPACT_ANALYSIS_STATE_MACHINE_ARN = aws_sfn_state_machine.impact_analysis.arn',
    );
    const policy =
      /data "aws_iam_policy_document" "api_impact_analysis" \{([\s\S]*?)\n\}/u.exec(
        iam,
      )?.[1] ?? '';
    expect(policy).toContain('actions   = ["states:StartExecution"]');
    expect(policy).toContain('resources = [aws_sfn_state_machine.impact_analysis.arn]');
    expect(policy).not.toContain('"*"');
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
