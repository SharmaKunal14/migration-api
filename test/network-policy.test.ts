import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const networkConfiguration = readFileSync(
  fileURLToPath(
    new URL('../infra/terraform/environments/development/network.tf', import.meta.url),
  ),
  'utf8',
);
const importConfiguration = readFileSync(
  fileURLToPath(
    new URL('../infra/terraform/environments/development/imports.tf', import.meta.url),
  ),
  'utf8',
);

describe('workload outbound network policy', () => {
  it('adopts the manual NAT route and keeps every workload on the green table', () => {
    expect(
      networkConfiguration.match(/data\.aws_route_table\.development_nat\.id/gu),
    ).toHaveLength(6);
    expect(networkConfiguration).toContain(
      'network_interface_id   = data.aws_network_interface.development_nat.id',
    );
    expect(importConfiguration).toContain('id = "rtb-0d877aa0f73f6ee09_0.0.0.0/0"');
    expect(
      importConfiguration.match(/id = "subnet-[0-9a-f]+\/rtb-0d877aa0f73f6ee09"/gu),
    ).toHaveLength(8);
  });

  it('separates agent, source-fetcher, and verifier domain allowlists', () => {
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
      'registry.npmjs.org',
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
    expect(
      ruleLines
        .filter(line => line.includes('registry.npmjs.org'))
        .every(line => line.includes('aws_subnet.verifier')),
    ).toBe(true);
    expect(rules).not.toContain('drop ip $HOME_NET');
    expect(networkConfiguration).toContain(
      'stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]',
    );
  });
});
