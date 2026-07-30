import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const applicationAssociation =
  /^aws_route_table_association\.(?:control|agent|source_fetcher|verifier)\[/u;

const rollbackResource = [
  /^aws_eip\.nat\[/u,
  /^aws_nat_gateway\.main\[/u,
  /^aws_networkfirewall_/u,
  /^aws_route\.agent_default\[/u,
  /^aws_route\.control_default\[/u,
  /^aws_route\.firewall_default\[/u,
  /^aws_route\.public_(?:agent|source_fetcher|verifier)_return\[/u,
  /^aws_route\.source_fetcher_default\[/u,
  /^aws_route\.verifier_default\[/u,
  /^aws_route_table\.(?:agent|control|firewall|source_fetcher|verifier)\[/u,
  /^aws_route_table_association\.firewall\[/u,
  /^aws_subnet\.firewall\[/u,
];

function flattenResources(module) {
  return [
    ...(module?.resources ?? []),
    ...(module?.child_modules ?? []).flatMap(flattenResources),
  ];
}

function requireResource(resources, address) {
  const resource = resources.find(candidate => candidate.address === address);
  if (!resource) {
    throw new Error(`Terraform plan is missing required resource ${address}.`);
  }
  return resource;
}

export function validateDevelopmentNetworkPlan(
  plan,
  expectedRouteTableId,
  expectedNetworkInterfaceId,
) {
  if (!/^rtb-[0-9a-f]+$/u.test(expectedRouteTableId)) {
    throw new Error('Expected development NAT route-table ID is invalid.');
  }
  if (!/^eni-[0-9a-f]+$/u.test(expectedNetworkInterfaceId)) {
    throw new Error('Expected development NAT network-interface ID is invalid.');
  }

  const plannedResources = flattenResources(plan.planned_values?.root_module);
  const associations = plannedResources.filter(resource =>
    applicationAssociation.test(resource.address),
  );
  if (associations.length !== 8) {
    throw new Error(
      `Expected 8 application route-table associations, found ${associations.length}.`,
    );
  }
  for (const association of associations) {
    if (association.values?.route_table_id !== expectedRouteTableId) {
      throw new Error(
        `${association.address} does not target ${expectedRouteTableId}.`,
      );
    }
  }

  const defaultRoute = requireResource(
    plannedResources,
    'aws_route.development_nat_default',
  );
  if (
    defaultRoute.values?.route_table_id !== expectedRouteTableId ||
    defaultRoute.values?.destination_cidr_block !== '0.0.0.0/0' ||
    defaultRoute.values?.network_interface_id !== expectedNetworkInterfaceId
  ) {
    throw new Error(
      'The development NAT default route does not match the approved path.',
    );
  }

  const s3Endpoint = requireResource(plannedResources, 'aws_vpc_endpoint.s3');
  if (!s3Endpoint.values?.route_table_ids?.includes(expectedRouteTableId)) {
    throw new Error(
      'The S3 gateway endpoint is not associated with the NAT route table.',
    );
  }

  for (const resource of plan.resource_changes ?? []) {
    const actions = resource.change?.actions ?? [];
    if (
      applicationAssociation.test(resource.address) &&
      actions.some(action => action !== 'no-op')
    ) {
      throw new Error(
        `${resource.address} has unsafe planned actions: ${actions.join(', ')}.`,
      );
    }
    if (
      actions.includes('delete') &&
      rollbackResource.some(pattern => pattern.test(resource.address))
    ) {
      throw new Error(
        `${resource.address} would delete rollback infrastructure during NAT adoption.`,
      );
    }
  }
}

function main() {
  const [, , planPath] = process.argv;
  if (!planPath) {
    throw new Error(
      'Usage: validate-development-network-plan.mjs <terraform-plan.json|->',
    );
  }
  const expectedRouteTableId =
    process.env.TF_VAR_development_nat_route_table_id?.trim() ?? '';
  const expectedNetworkInterfaceId =
    process.env.TF_VAR_development_nat_network_interface_id?.trim() ?? '';
  const planText =
    planPath === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(resolve(planPath), 'utf8');
  const plan = JSON.parse(planText);
  validateDevelopmentNetworkPlan(
    plan,
    expectedRouteTableId,
    expectedNetworkInterfaceId,
  );
  process.stdout.write(
    'Validated development NAT route, eight workload associations, S3 endpoint, and rollback preservation.\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
