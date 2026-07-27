import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function fixture(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
}

const compute = fixture('../infra/terraform/environments/development/compute.tf');
const iam = fixture('../infra/terraform/environments/development/iam.tf');
const network = fixture('../infra/terraform/environments/development/network.tf');
const verifier = fixture('../workers/verifier/src/main.ts');

function resourceBody(
  source: string,
  kind: 'data' | 'resource',
  type: string,
  name: string,
  nextBlock: string,
): string {
  const expression = new RegExp(
    `${kind} "${type}" "${name}" \\{(?<body>[\\s\\S]*?)\\n\\}\\n\\n${nextBlock}`,
    'u',
  );
  const body = expression.exec(source)?.groups?.body;
  expect(body).toBeDefined();
  return body!;
}

describe('Stage 6B verifier trust zone', () => {
  it('defines a non-root, read-only, capability-free task with a bounded workspace', () => {
    const task = resourceBody(
      compute,
      'resource',
      'aws_ecs_task_definition',
      'verifier',
      'resource "aws_ecs_task_definition" "migrator"',
    );

    expect(task).toContain('cpu                      = 1024');
    expect(task).toContain('memory                   = 2048');
    expect(task).toContain('size_in_gib = 21');
    expect(task).toContain('readonlyRootFilesystem = true');
    expect(task).toContain('privileged             = false');
    expect(task).toContain('user                   = "10001:10001"');
    expect(task).toContain('capabilities       = { drop = ["ALL"] }');
    expect(task).toContain('containerPath = "/workspace"');
    expect(task).toContain('name      = "nproc"');
    expect(task).not.toContain('task_role_arn');
    expect(task).not.toContain('docker.sock');
    expect(task).not.toContain('host');
  });

  it('grants only image-pull and log permissions to the non-container execution role', () => {
    const policy = resourceBody(
      iam,
      'data',
      'aws_iam_policy_document',
      'verifier_execution',
      'resource "aws_iam_role_policy" "verifier_execution"',
    );

    expect(policy).toContain('data.aws_ecr_repository.verifier.arn');
    expect(policy).toContain('aws_cloudwatch_log_group.verifier.arn');
    expect(policy).toContain('"ecr:GetAuthorizationToken"');
    expect(policy).not.toContain('s3:');
    expect(policy).not.toContain('kms:');
    expect(policy).not.toContain('secretsmanager:');
    expect(policy).not.toContain('sts:GetWebIdentityToken');
  });

  it('routes external TLS through the firewall and permits only the approved registry', () => {
    expect(network).toContain('resource "aws_route_table" "verifier"');
    expect(network).toContain('resource "aws_route" "verifier_default"');
    expect(network).toContain(
      '[for route_table in aws_route_table.verifier : route_table.id]',
    );
    expect(network).toContain('content:"registry.npmjs.org"');

    const securityGroup = resourceBody(
      network,
      'resource',
      'aws_security_group',
      'verifier',
      'resource "aws_vpc_endpoint" "s3"',
    );
    expect(securityGroup).toContain(
      'security_groups = [aws_security_group.vpc_endpoints.id]',
    );
    expect(securityGroup).toContain(
      'prefix_list_ids = [aws_vpc_endpoint.s3.prefix_list_id]',
    );
    expect(securityGroup).toContain(
      'description = "TLS through Network Firewall to the approved npm registry"',
    );
  });

  it('is fail-closed when its signed work item is absent', () => {
    expect(verifier).toContain(
      "requiredEnvironment('VERIFICATION_WORK_ITEM_REFERENCE')",
    );
    expect(verifier).toContain('VERIFICATION_INFRASTRUCTURE_FAILED');
  });
});
