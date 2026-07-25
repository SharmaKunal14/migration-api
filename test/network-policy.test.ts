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
  it('allows only the required OpenAI HTTPS hostnames before denying all else', () => {
    const rules = /rules_string = <<-RULES(?<rules>[\s\S]*?)\n\s*RULES/u.exec(
      networkConfiguration,
    )?.groups?.rules;

    expect(rules).toBeDefined();
    expect(
      [...rules!.matchAll(/content:"(?<hostname>[^"]+)"/gu)].map(
        match => match.groups?.hostname,
      ),
    ).toEqual(['api.openai.com', 'auth.openai.com']);
    expect(rules).toContain(
      'drop ip $HOME_NET any -> $EXTERNAL_NET any (sid:3; rev:1;)',
    );
    expect(rules!.indexOf('auth.openai.com')).toBeLessThan(rules!.indexOf('drop ip'));
  });
});
