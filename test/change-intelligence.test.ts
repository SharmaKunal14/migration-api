import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  changeIntelligenceResultSchema,
  changeIntelligenceWorkflowInputSchema,
} from '@migration/contracts';

import { parseDraftSpecification } from '../workers/change-intelligence-agent/src/gateway.js';
import { ChangeIntelligenceTools } from '../workers/change-intelligence-agent/src/tools.js';
import type { ToolPolicyError } from '../workers/change-intelligence-agent/src/tools.js';
import { evidenceReferencesMatch } from '../services/vendor-intelligence-control/src/handler.js';

const releaseId = '914e7575-7dc8-40e4-9445-aa61bfdb4ade';
const runId = '40ade5b7-e4c9-438f-90a2-4a1fb93c8124';
const releasePrefix =
  'env/development/vendor/orbitchat/product/16dca0bb-dd7d-4251-8e51-3c34816d5014/release/' +
  releaseId;

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function mockS3(objects: ReadonlyMap<string, Uint8Array>): S3Client {
  return {
    send: vi.fn().mockImplementation((command: { input?: { Key?: string } }) => {
      const key = command.input?.Key;
      const bytes = key ? objects.get(key) : undefined;
      if (!bytes) throw new Error('Unexpected S3 object key.');
      return Promise.resolve({
        ContentLength: bytes.byteLength,
        Body: {
          transformToByteArray: () => Promise.resolve(bytes),
        },
      });
    }),
  } as unknown as S3Client;
}

describe('Stage 3C change-intelligence boundary', () => {
  it('accepts identifier-only workflow input', () => {
    expect(
      changeIntelligenceWorkflowInputSchema.parse({
        schemaVersion: '1.0',
        vendorReleaseId: releaseId,
        correlationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
      }),
    ).toBeDefined();
    expect(() =>
      changeIntelligenceWorkflowInputSchema.parse({
        schemaVersion: '1.0',
        vendorReleaseId: releaseId,
        correlationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
        url: 'https://attacker.invalid',
      }),
    ).toThrow();
  });

  it('server-injects draft trust state and rejects false promotion', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          '../fixtures/vendors/orbitchat/draft-migration-specification.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    delete fixture.trust;
    delete fixture.revision;
    delete fixture.generatedAt;

    const specification = parseDraftSpecification(
      JSON.stringify({
        ...fixture,
        trust: {
          status: 'vendor_verified',
          generatedBy: 'operator',
          reviewedAt: new Date().toISOString(),
        },
      }),
      3,
      new Date('2026-07-26T01:00:00.000Z'),
    );

    expect(specification).toMatchObject({
      revision: 3,
      trust: {
        status: 'draft',
        generatedBy: 'change_intelligence_agent',
        reviewedAt: null,
      },
    });

    const changed = JSON.parse(JSON.stringify(fixture)) as {
      changes: {
        changeId: string;
        transformations: { after: string }[];
      }[];
    };
    const methodChange = changed.changes.find(change => change.changeId === 'C-01');
    if (!methodChange?.transformations[0]) {
      throw new Error('The test fixture is missing C-01.');
    }
    methodChange.transformations[0].after = 'messages.delete';
    expect(() =>
      parseDraftSpecification(
        JSON.stringify(changed),
        3,
        new Date('2026-07-26T01:00:00.000Z'),
      ),
    ).toThrow(expect.objectContaining({ safeCode: 'ORBIT_SPECIFICATION_INVALID' }));
  });

  it('reads only digest-bound sources under the manifest release prefix', async () => {
    const sourceBytes = Buffer.from('trusted evidence bytes');
    const sourceKey = `${releasePrefix}/source/source-id/${sha256(sourceBytes)}`;
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: '1.0',
        vendorReleaseId: releaseId,
        vendorSlug: 'orbitchat',
        productId: '16dca0bb-dd7d-4251-8e51-3c34816d5014',
        version: '2.0.0',
        sources: [
          {
            vendorSourceId: '5bbb0741-98ec-4104-b19f-58ae8fc8b67f',
            sourceKey: 'migration_guide',
            canonicalUrl: 'https://vendor.example/MIGRATION.md',
            finalUrl: 'https://vendor.example/MIGRATION.md',
            objectKey: sourceKey,
            digest: sha256(sourceBytes),
            bytes: sourceBytes.byteLength,
            mediaType: 'text/plain',
            etag: null,
          },
        ],
      }),
    );
    const manifestKey = `${releasePrefix}/bundle/${sha256(manifest)}.json`;
    const tools = new ChangeIntelligenceTools(
      mockS3(
        new Map([
          [manifestKey, manifest],
          [sourceKey, sourceBytes],
        ]),
      ),
      'artifact-bucket',
      releaseId,
      manifestKey,
      sha256(manifest),
    );

    await tools.initialize();
    const execution = await tools.execute(
      'read_vendor_evidence',
      '{"sourceKey":"migration_guide"}',
      1,
    );

    expect(JSON.parse(execution.output)).toMatchObject({
      content: 'trusted evidence bytes',
      source: { sourceKey: 'migration_guide' },
    });
  });

  it('rejects a manifest that redirects evidence outside its release', async () => {
    const sourceBytes = Buffer.from('evidence');
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: '1.0',
        vendorReleaseId: releaseId,
        vendorSlug: 'orbitchat',
        productId: '16dca0bb-dd7d-4251-8e51-3c34816d5014',
        version: '2.0.0',
        sources: [
          {
            vendorSourceId: '5bbb0741-98ec-4104-b19f-58ae8fc8b67f',
            sourceKey: 'migration_guide',
            canonicalUrl: 'https://vendor.example/MIGRATION.md',
            finalUrl: 'https://vendor.example/MIGRATION.md',
            objectKey: 'env/development/change-intelligence/other/result.json',
            digest: sha256(sourceBytes),
            bytes: sourceBytes.byteLength,
            mediaType: 'text/plain',
            etag: null,
          },
        ],
      }),
    );
    const manifestKey = `${releasePrefix}/bundle/${sha256(manifest)}.json`;
    const tools = new ChangeIntelligenceTools(
      mockS3(new Map([[manifestKey, manifest]])),
      'artifact-bucket',
      releaseId,
      manifestKey,
      sha256(manifest),
    );

    await expect(tools.initialize()).rejects.toEqual(
      expect.objectContaining<Partial<ToolPolicyError>>({
        safeCode: 'EVIDENCE_SOURCE_KEY_INVALID',
      }),
    );
  });

  it('requires failed and successful result fields to agree', () => {
    const base = {
      schemaVersion: '1.0',
      vendorReleaseId: releaseId,
      changeIntelligenceRunId: runId,
      evidenceObjectKey: `${releasePrefix}/bundle/${'a'.repeat(64)}.json`,
      evidenceDigest: 'a'.repeat(64),
      model: {
        requestedModel: 'gpt-5.6-sol',
        returnedModel: 'gpt-5.6-sol',
        requestId: null,
      },
      usage: {
        modelCalls: 0,
        toolCalls: 0,
        iterations: 0,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 1,
      },
      actions: [],
    } as const;
    expect(
      changeIntelligenceResultSchema.parse({
        ...base,
        status: 'failed',
        safeErrorCode: 'MODEL_REQUEST_REJECTED',
        specification: null,
      }),
    ).toBeDefined();
    expect(() =>
      changeIntelligenceResultSchema.parse({
        ...base,
        status: 'succeeded',
        safeErrorCode: null,
        specification: null,
      }),
    ).toThrow();
  });

  it('requires every model citation to match controller-owned provenance', () => {
    const references = [
      {
        evidenceId: 'C-01',
        sourceKey: 'migration_guide',
        sourceUrl: 'https://vendor.example/MIGRATION.md',
        digest: 'a'.repeat(64),
        summary: 'The API method changed.',
      },
    ];
    const registered = new Map([
      [
        'migration_guide',
        {
          canonicalUrl: 'https://vendor.example/MIGRATION.md',
          digest: 'a'.repeat(64),
        },
      ],
    ]);

    expect(evidenceReferencesMatch(references, registered)).toBe(true);
    expect(
      evidenceReferencesMatch(
        [{ ...references[0]!, digest: 'b'.repeat(64) }],
        registered,
      ),
    ).toBe(false);
  });
});

describe('Stage 3C database and infrastructure policy', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../supabase/migrations/0006_stage_3c.sql', import.meta.url)),
    'utf8',
  );
  const iam = readFileSync(
    fileURLToPath(
      new URL('../infra/terraform/environments/development/iam.tf', import.meta.url),
    ),
    'utf8',
  );
  const compute = readFileSync(
    fileURLToPath(
      new URL(
        '../infra/terraform/environments/development/compute.tf',
        import.meta.url,
      ),
    ),
    'utf8',
  );

  it('allows the runtime to insert only draft specifications', () => {
    expect(migration).toContain(
      'grant execute on function create_change_intelligence_draft',
    );
    expect(migration).toContain("'change_intelligence_agent'");
    expect(migration).not.toMatch(
      /grant update\s*(?:\([^;]*\)\s*)?on migration_specifications to app_runtime/iu,
    );
    expect(migration).not.toMatch(
      /grant insert on migration_specifications to app_runtime/iu,
    );
  });

  it('does not grant database, GitHub, shell, or general HTTP capability to the agent role', () => {
    const policy =
      /data "aws_iam_policy_document" "change_intelligence_task" \{([\s\S]*?)\n\}/u.exec(
        iam,
      )?.[1];
    expect(policy).toBeDefined();
    expect(policy).not.toMatch(
      /secretsmanager|lambda:InvokeFunction|github|execute-command/iu,
    );
    expect(policy).toContain('/env/development/vendor/*');
    expect(policy).toContain('/env/development/change-intelligence/*');
  });

  it('marks rejected drafts and infrastructure errors as failed executions', () => {
    expect(compute).toContain('ChangeIntelligenceFailed = {');
    expect(compute).toContain('ChangeIntelligenceInfrastructureFailed = {');
    expect(compute).toMatch(/ChangeIntelligenceFailed = \{\s*Type\s+= "Fail"/u);
  });
});
