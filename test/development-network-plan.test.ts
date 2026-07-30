import { describe, expect, it } from 'vitest';

import { validateDevelopmentNetworkPlan } from '../scripts/deploy/validate-development-network-plan.mjs';

const routeTableId = 'rtb-0d877aa0f73f6ee09';
const networkInterfaceId = 'eni-0dd6f17bc574a317a';

function validPlan(): Record<string, unknown> {
  const associations = [
    'control["ap-southeast-2a"]',
    'control["ap-southeast-2b"]',
    'agent["ap-southeast-2a"]',
    'agent["ap-southeast-2b"]',
    'source_fetcher["ap-southeast-2a"]',
    'source_fetcher["ap-southeast-2b"]',
    'verifier["ap-southeast-2a"]',
    'verifier["ap-southeast-2b"]',
  ].map(suffix => ({
    address: `aws_route_table_association.${suffix}`,
    values: { route_table_id: routeTableId },
  }));

  return {
    planned_values: {
      root_module: {
        resources: [
          ...associations,
          {
            address: 'aws_route.development_nat_default',
            values: {
              destination_cidr_block: '0.0.0.0/0',
              network_interface_id: networkInterfaceId,
              route_table_id: routeTableId,
            },
          },
          {
            address: 'aws_vpc_endpoint.s3',
            values: { route_table_ids: [routeTableId] },
          },
        ],
      },
    },
    resource_changes: associations.map(association => ({
      address: association.address,
      change: { actions: ['no-op'] },
    })),
  };
}

describe('development NAT Terraform plan validation', () => {
  it('accepts the approved NAT-only topology', () => {
    expect(() =>
      validateDevelopmentNetworkPlan(validPlan(), routeTableId, networkInterfaceId),
    ).not.toThrow();
  });

  it('rejects a workload association replacement', () => {
    const plan = validPlan();
    const changes = plan.resource_changes as {
      address: string;
      change: { actions: string[] };
    }[];
    changes[0]!.change.actions = ['delete', 'create'];

    expect(() =>
      validateDevelopmentNetworkPlan(plan, routeTableId, networkInterfaceId),
    ).toThrow(/unsafe planned actions/u);
  });

  it('allows deletion of the obsolete firewall', () => {
    const plan = validPlan();
    const changes = plan.resource_changes as unknown[];
    changes.push({
      address: 'aws_networkfirewall_firewall.agent',
      change: { actions: ['delete'] },
    });

    expect(() =>
      validateDevelopmentNetworkPlan(plan, routeTableId, networkInterfaceId),
    ).not.toThrow();
  });

  it('rejects a firewall resource remaining in the desired topology', () => {
    const plan = validPlan();
    const resources = (
      plan.planned_values as {
        root_module: { resources: { address: string; values: object }[] };
      }
    ).root_module.resources;
    resources.push({
      address: 'aws_networkfirewall_firewall.agent',
      values: {},
    });

    expect(() =>
      validateDevelopmentNetworkPlan(plan, routeTableId, networkInterfaceId),
    ).toThrow(/still declares obsolete egress resources/u);
  });

  it('rejects deletion of the active NAT default route', () => {
    const plan = validPlan();
    const changes = plan.resource_changes as unknown[];
    changes.push({
      address: 'aws_route.development_nat_default',
      change: { actions: ['delete'] },
    });

    expect(() =>
      validateDevelopmentNetworkPlan(plan, routeTableId, networkInterfaceId),
    ).toThrow(/delete protected NAT-path infrastructure/u);
  });

  it('rejects a missing S3 route-table association', () => {
    const plan = validPlan();
    const resources = (
      plan.planned_values as {
        root_module: { resources: { address: string; values: object }[] };
      }
    ).root_module.resources;
    const endpoint = resources.find(
      resource => resource.address === 'aws_vpc_endpoint.s3',
    );
    endpoint!.values = { route_table_ids: [] };

    expect(() =>
      validateDevelopmentNetworkPlan(plan, routeTableId, networkInterfaceId),
    ).toThrow(/S3 gateway endpoint/u);
  });
});
