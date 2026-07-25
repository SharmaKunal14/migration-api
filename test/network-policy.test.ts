import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const networkConfiguration = readFileSync(
  fileURLToPath(
    new URL('../infra/terraform/environments/development/network.tf', import.meta.url),
  ),
  'utf8',
);

describe('agent outbound network policy', () => {
  it('allows only the required OpenAI HTTPS hostnames and denies other established traffic', () => {
    const rules = /rules_string = <<-RULES(?<rules>[\s\S]*?)\n\s*RULES/u.exec(
      networkConfiguration,
    )?.groups?.rules;

    expect(rules).toBeDefined();
    expect(
      [...rules!.matchAll(/content:"(?<hostname>[^"]+)"/gu)].map(
        match => match.groups?.hostname,
      ),
    ).toEqual(['api.openai.com', 'auth.openai.com']);
    expect(rules).not.toContain('drop ip $HOME_NET');
    expect(networkConfiguration).toContain(
      'stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]',
    );
  });
});
