import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const observabilityConfiguration = readFileSync(
  fileURLToPath(
    new URL(
      '../infra/terraform/environments/development/observability.tf',
      import.meta.url,
    ),
  ),
  'utf8',
);

describe('Stage 2 operational monitoring', () => {
  it('alarms on repository acquisition failures that are handled by the workflow', () => {
    expect(observabilityConfiguration).toContain(
      'resource "aws_cloudwatch_log_metric_filter" "repository_acquisition_failure"',
    );
    expect(observabilityConfiguration).toContain(
      'pattern        = "{ $.event = \\"repository_acquisition_failed\\" }"',
    );
    expect(observabilityConfiguration).toContain(
      'resource "aws_cloudwatch_metric_alarm" "repository_acquisition_failure"',
    );
    expect(observabilityConfiguration).toContain(
      'metric_name         = "RepositoryAcquisitionFailed"',
    );
    expect(observabilityConfiguration).toContain(
      'treat_missing_data  = "notBreaching"',
    );
  });
});
