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

  it('removes managed firewall and NAT Gateway resources after cutover', () => {
    expect(networkConfiguration).not.toContain('aws_networkfirewall_');
    expect(networkConfiguration).not.toContain('resource "aws_nat_gateway"');
    expect(networkConfiguration).not.toContain('resource "aws_eip" "nat"');
    expect(networkConfiguration).not.toContain('resource "aws_subnet" "firewall"');
    expect(networkConfiguration).not.toContain('firewall_endpoints');
    expect(networkConfiguration).not.toContain('aws_route_table.control');
    expect(networkConfiguration).not.toContain('aws_route_table.agent');
    expect(networkConfiguration).not.toContain('aws_route_table.source_fetcher');
    expect(networkConfiguration).not.toContain('aws_route_table.verifier');
  });
});
