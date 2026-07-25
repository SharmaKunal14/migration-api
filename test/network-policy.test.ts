import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const networkConfiguration = readFileSync(
  fileURLToPath(
    new URL('../infra/terraform/environments/development/network.tf', import.meta.url),
  ),
  'utf8',
);

describe('workload outbound network policy', () => {
  it('separates agent OpenAI egress from source-fetcher GitHub egress', () => {
    const rules = /rules_string = <<-RULES(?<rules>[\s\S]*?)\n\s*RULES/u.exec(
      networkConfiguration,
    )?.groups?.rules;

    expect(rules).toBeDefined();
    expect(
      [...rules!.matchAll(/content:"(?<hostname>[^"]+)"/gu)].map(
        match => match.groups?.hostname,
      ),
    ).toEqual([
      'api.openai.com',
      'auth.openai.com',
      'api.github.com',
      'codeload.github.com',
    ]);
    const ruleLines = rules!.split('\n');
    expect(
      ruleLines
        .filter(line => line.includes('openai.com'))
        .every(line => line.includes('aws_subnet.agent')),
    ).toBe(true);
    expect(
      ruleLines
        .filter(line => line.includes('github.com'))
        .every(line => line.includes('aws_subnet.source_fetcher')),
    ).toBe(true);
    expect(rules).not.toContain('drop ip $HOME_NET');
    expect(networkConfiguration).toContain(
      'stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]',
    );
  });
});
