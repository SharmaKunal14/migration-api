import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { migrationVerificationWorkItemSchema } from '@migration/contracts';

const compute = read('infra/terraform/environments/development/compute.tf');
const iam = read('infra/terraform/environments/development/iam.tf');
const worker = read('workers/verifier/src/main.ts');
const control = read('services/workflow-control/src/handler.ts');

describe('Stage 6E verifier orchestration', () => {
  it('runs the verifier in its isolated Fargate trust zone and ingests its result', () => {
    expect(compute).toContain('RunVerifierTask = {');
    expect(compute).toContain('TaskDefinition = aws_ecs_task_definition.verifier.arn');
    expect(compute).toContain('SecurityGroups = [aws_security_group.verifier.id]');
    expect(compute).toContain(
      'Subnets        = [for subnet in aws_subnet.verifier : subnet.id]',
    );
    expect(compute).toContain('"Value.$" = "States.JsonToString($.boundary.Payload)"');
    expect(compute).toContain('operation    = "ingest_migration_verification"');
  });

  it('uses short-lived exact-object transfers without a verifier task role', () => {
    expect(control).toContain('const expiresIn = 15 * 60');
    expect(control).toContain('getSignedUrl(');
    expect(iam).toContain('sid       = "ReadWriteVerifierResults"');
    const verifierTask = compute.slice(
      compute.indexOf('resource "aws_ecs_task_definition" "verifier"'),
      compute.indexOf('resource "aws_ecs_task_definition" "migrator"'),
    );
    expect(verifierTask).not.toContain('task_role_arn');
    expect(worker).not.toContain('S3Client');
    expect(worker).not.toContain('AWS_ACCESS_KEY_ID');
  });

  it('binds transfers to the exact attempt and validates all result evidence', () => {
    const parsed = migrationVerificationWorkItemSchema.parse({
      status: 'ready',
      schemaVersion: '1.0',
      organisationId: '07a17d5a-820d-4199-93d9-4e71b1c2d4f5',
      repositoryId: 'fb88f567-56f6-4151-8a42-c84981f49ec6',
      migrationRunId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      approvalId: '8955ed33-d1d8-4fdb-bd48-3a0835562934',
      verificationAttemptId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
      attemptNumber: 1,
      patchAttemptId: '12a906c7-f7df-4c65-9137-70bcf17eec86',
      baseCommitSha: 'a'.repeat(40),
      snapshot: {
        artifactId: '32b9664f-12c0-4276-aea5-46938b6f5a97',
        objectKey: 'input/snapshot.tar.gz',
        digest: 'b'.repeat(64),
        bytes: 1,
      },
      patch: {
        artifactId: '51862bc4-9e1a-49a9-a4bf-376eae3f52b6',
        objectKey: 'agent/proposal.diff',
        digest: 'c'.repeat(64),
        bytes: 1,
        validationArtifactId: '74218edf-4836-4b41-8f6c-1525c5fa1075',
        validationObjectKey: 'agent/validation.json',
        validationDigest: 'd'.repeat(64),
      },
      authority: {
        verificationPolicyVersion: 'typescript-default-1.0',
        verificationProfile: {
          schemaVersion: '1.0',
          profiles: [
            {
              profile: 'typescript_static',
              availability: 'available',
              commandIds: ['npm.typecheck'],
            },
          ],
        },
        verificationProfileDigest: 'e'.repeat(64),
      },
      transfers: {
        snapshotDownloadUrl:
          'https://bucket.s3.ap-southeast-2.amazonaws.com/snapshot?sig=1',
        patchDownloadUrl: 'https://bucket.s3.ap-southeast-2.amazonaws.com/patch?sig=1',
        resultUploadUrl: 'https://bucket.s3.ap-southeast-2.amazonaws.com/result?sig=1',
        stdoutUploadUrl: 'https://bucket.s3.ap-southeast-2.amazonaws.com/stdout?sig=1',
        stderrUploadUrl: 'https://bucket.s3.ap-southeast-2.amazonaws.com/stderr?sig=1',
        resultObjectKey: 'verification/result.json',
        stdoutObjectKey: 'verification/stdout.log',
        stderrObjectKey: 'verification/stderr.log',
        artifactBucket: 'bucket',
        artifactKmsKeyArn:
          'arn:aws:kms:ap-southeast-2:393209814365:key/53a1ea6a-3e01-41b6-8be0-e1268de8c58e',
        awsRegion: 'ap-southeast-2',
        approvedRegistryUrl: 'https://registry.npmjs.org/',
      },
    });
    expect(parsed.snapshot.bytes).toBe(1);
    expect(control).toContain(
      "throw new Error('The verification result binding is invalid.')",
    );
    expect(control).toContain(
      "throw new Error('The verification log artifact digest is invalid.')",
    );
  });
});

function read(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
}
