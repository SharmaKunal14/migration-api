import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const applicationAssociation =
  /^aws_route_table_association\.(?:control|agent|source_fetcher|verifier)\[/u;

const interfaceEndpointServices = [
  'ecr.api',
  'ecr.dkr',
  'kms',
  'lambda',
  'logs',
  'secretsmanager',
  'sts',
];
const interfaceEndpointResource = /^aws_vpc_endpoint\.interface\["([^"]+)"\]$/u;

const obsoleteEgressResource = [
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

const protectedNetworkResource = [
  /^aws_internet_gateway\.main$/u,
  /^aws_route\.development_nat_default$/u,
  /^aws_route\.public_default\[/u,
  /^aws_route_table\.public\[/u,
  /^aws_route_table_association\.public\[/u,
  /^aws_subnet\.(?:agent|control|public|source_fetcher|verifier)\[/u,
  /^aws_vpc\.main$/u,
  /^aws_vpc_endpoint\.s3$/u,
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
  interfaceEndpointsEnabled = false,
) {
  if (!/^rtb-[0-9a-f]+$/u.test(expectedRouteTableId)) {
    throw new Error('Expected development NAT route-table ID is invalid.');
  }
  if (!/^eni-[0-9a-f]+$/u.test(expectedNetworkInterfaceId)) {
    throw new Error('Expected development NAT network-interface ID is invalid.');
  }

  const plannedResources = flattenResources(plan.planned_values?.root_module);
  const obsoleteResources = plannedResources.filter(resource =>
    obsoleteEgressResource.some(pattern => pattern.test(resource.address)),
  );
  if (obsoleteResources.length > 0) {
    throw new Error(
      `Terraform still declares obsolete egress resources: ${obsoleteResources
        .map(resource => resource.address)
        .join(', ')}.`,
    );
  }

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

  const plannedInterfaceEndpoints = plannedResources
    .map(resource => interfaceEndpointResource.exec(resource.address)?.[1])
    .filter(service => service !== undefined)
    .sort();
  const expectedInterfaceEndpoints = interfaceEndpointsEnabled
    ? [...interfaceEndpointServices]
    : [];
  if (
    plannedInterfaceEndpoints.length !== expectedInterfaceEndpoints.length ||
    plannedInterfaceEndpoints.some(
      (service, index) => service !== expectedInterfaceEndpoints[index],
    )
  ) {
    throw new Error(
      interfaceEndpointsEnabled
        ? 'The development plan does not contain exactly the approved interface VPC endpoints.'
        : 'The development plan would retain or create paid interface VPC endpoints.',
    );
  }

  for (const resource of plan.resource_changes ?? []) {
    const actions = resource.change?.actions ?? [];
    const interfaceEndpointService = interfaceEndpointResource.exec(
      resource.address,
    )?.[1];
    if (
      interfaceEndpointService &&
      !interfaceEndpointServices.includes(interfaceEndpointService)
    ) {
      throw new Error(
        `${resource.address} is not an approved development interface endpoint.`,
      );
    }
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
      protectedNetworkResource.some(pattern => pattern.test(resource.address))
    ) {
      throw new Error(
        `${resource.address} would delete protected NAT-path infrastructure.`,
      );
    }
    if (
      actions.includes('delete') &&
      resource.address.startsWith('aws_vpc_endpoint.') &&
      !interfaceEndpointService
    ) {
      throw new Error(
        `${resource.address} is not an approved interface endpoint deletion.`,
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
  const interfaceEndpointsEnabled =
    process.env.TF_VAR_enable_interface_vpc_endpoints?.trim() === 'true';
  const planText =
    planPath === '-'
      ? readFileSync(0, 'utf8')
      : readFileSync(resolve(planPath), 'utf8');
  const plan = JSON.parse(planText);
  validateDevelopmentNetworkPlan(
    plan,
    expectedRouteTableId,
    expectedNetworkInterfaceId,
    interfaceEndpointsEnabled,
  );
  process.stdout.write(
    `Validated development NAT route, eight workload associations, S3 endpoint, ${
      interfaceEndpointsEnabled
        ? 'seven approved interface endpoints'
        : 'zero interface endpoints'
    }, and obsolete-egress cleanup.\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
