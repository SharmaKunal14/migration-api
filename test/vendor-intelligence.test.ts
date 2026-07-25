import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  impactReportSchema,
  migrationSpecificationSchema,
  type VendorEvidenceBundle,
} from '@migration/contracts';
import {
  normalizeTrustedVendorUrl,
  VendorEvidenceError,
  verifyVendorEvidenceBundle,
} from '@migration/vendor-intelligence';

const fixtureDirectory = new URL('../fixtures/vendors/orbitchat/', import.meta.url);
const bundle = JSON.parse(
  readFileSync(new URL('evidence-bundle.json', fixtureDirectory), 'utf8'),
) as unknown;
const draftSpecification = JSON.parse(
  readFileSync(new URL('draft-migration-specification.json', fixtureDirectory), 'utf8'),
) as unknown;
const expectedImpactReport = JSON.parse(
  readFileSync(
    new URL('../fixtures/impact/orbitchat.expected.json', import.meta.url),
    'utf8',
  ),
) as unknown;

function evidenceContents(manifest: VendorEvidenceBundle): Map<string, Uint8Array> {
  return new Map(
    manifest.sources.map(source => [
      source.contentPath,
      readFileSync(new URL(source.contentPath, fixtureDirectory)),
    ]),
  );
}

describe('Stage 3A vendor intelligence', () => {
  it('validates the digest-bound OrbitChat release bundle', () => {
    const manifest = verifyVendorEvidenceBundle(
      bundle,
      evidenceContents(bundle as VendorEvidenceBundle),
    );

    expect(manifest.productIdentifier).toBe('@orbitchat/sdk');
    expect(manifest.sources).toHaveLength(5);
  });

  it('rejects altered, missing, and unlisted evidence', () => {
    const manifest = bundle as VendorEvidenceBundle;
    const altered = evidenceContents(manifest);
    altered.set('v2/migration-guide.md', Buffer.from('altered'));
    expect(() => verifyVendorEvidenceBundle(bundle, altered)).toThrow(
      expect.objectContaining<Partial<VendorEvidenceError>>({
        safeCode: 'VENDOR_EVIDENCE_SIZE_MISMATCH',
      }),
    );

    const missing = evidenceContents(manifest);
    missing.delete('v1/api.d.ts');
    expect(() => verifyVendorEvidenceBundle(bundle, missing)).toThrow(
      expect.objectContaining<Partial<VendorEvidenceError>>({
        safeCode: 'VENDOR_EVIDENCE_FILE_SET_INVALID',
      }),
    );

    const unlisted = evidenceContents(manifest);
    unlisted.set('extra.txt', Buffer.from('extra'));
    expect(() => verifyVendorEvidenceBundle(bundle, unlisted)).toThrow(
      expect.objectContaining<Partial<VendorEvidenceError>>({
        safeCode: 'VENDOR_EVIDENCE_FILE_SET_INVALID',
      }),
    );
  });

  it('rejects same-size evidence with an unexpected digest', () => {
    const manifest = bundle as VendorEvidenceBundle;
    const altered = evidenceContents(manifest);
    const original = altered.get('v1/api.d.ts')!;
    altered.set('v1/api.d.ts', Buffer.alloc(original.byteLength, 0x61));

    expect(() => verifyVendorEvidenceBundle(bundle, altered)).toThrow(
      expect.objectContaining<Partial<VendorEvidenceError>>({
        safeCode: 'VENDOR_EVIDENCE_DIGEST_MISMATCH',
      }),
    );
  });

  it('rejects a malformed evidence manifest', () => {
    expect(() => verifyVendorEvidenceBundle({}, new Map())).toThrow(
      expect.objectContaining<Partial<VendorEvidenceError>>({
        safeCode: 'VENDOR_EVIDENCE_MANIFEST_INVALID',
      }),
    );
  });

  it('normalizes only exact, credential-free HTTPS catalogue origins', () => {
    const domains = new Set(['raw.githubusercontent.com']);
    expect(
      normalizeTrustedVendorUrl(
        'https://RAW.GITHUBUSERCONTENT.COM/vendor/release.json',
        domains,
      ),
    ).toBe('https://raw.githubusercontent.com/vendor/release.json');

    for (const url of [
      'not a URL',
      'http://raw.githubusercontent.com/vendor/release.json',
      'https://user:secret@raw.githubusercontent.com/vendor/release.json',
      'https://raw.githubusercontent.com:8443/vendor/release.json',
      'https://raw.githubusercontent.com/vendor/release.json?redirect=internal',
      'https://raw.githubusercontent.com/vendor/release.json#fragment',
      'https://attacker.raw.githubusercontent.com/vendor/release.json',
    ]) {
      expect(() => normalizeTrustedVendorUrl(url, domains)).toThrow(
        VendorEvidenceError,
      );
    }
  });

  it('accepts the draft specification and fails closed on false promotion', () => {
    expect(migrationSpecificationSchema.parse(draftSpecification)).toMatchObject({
      trust: { status: 'draft', reviewedAt: null },
      revision: 1,
    });
    expect(() =>
      migrationSpecificationSchema.parse({
        ...(draftSpecification as Record<string, unknown>),
        trust: {
          status: 'reviewed',
          generatedBy: 'operator',
          reviewedAt: null,
        },
      }),
    ).toThrow();
  });

  it('rejects duplicate changes and unknown evidence references', () => {
    const specification = draftSpecification as {
      changes: Record<string, unknown>[];
      [key: string]: unknown;
    };
    expect(() =>
      migrationSpecificationSchema.parse({
        ...specification,
        changes: [
          specification.changes[0],
          { ...specification.changes[1], changeId: 'C-01' },
        ],
      }),
    ).toThrow();
    expect(() =>
      migrationSpecificationSchema.parse({
        ...specification,
        changes: [
          {
            ...specification.changes[0],
            evidenceIds: ['C-99'],
          },
        ],
      }),
    ).toThrow();
  });

  it('accepts a commit-bound impact report without numeric confidence', () => {
    expect(impactReportSchema.parse(expectedImpactReport)).toMatchObject({
      outcome: 'affected',
      risk: 'medium',
      revision: 1,
    });
    expect(() =>
      impactReportSchema.parse({
        ...(expectedImpactReport as Record<string, unknown>),
        confidence: 0.95,
      }),
    ).toThrow();
  });

  it('rejects contradictory and path-unsafe impact reports', () => {
    const report = expectedImpactReport as {
      affectedFiles: Record<string, unknown>[];
      unaffectedFiles: Record<string, unknown>[];
      [key: string]: unknown;
    };
    expect(() =>
      impactReportSchema.parse({
        ...report,
        unaffectedFiles: [
          ...report.unaffectedFiles,
          {
            path: report.affectedFiles[0]?.path,
            reason: 'Contradictory classification.',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      impactReportSchema.parse({
        ...report,
        affectedFiles: [
          {
            ...report.affectedFiles[0],
            path: '../secrets',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('Stage 3A database migration', () => {
  const migration = readFileSync(
    fileURLToPath(new URL('../supabase/migrations/0004_stage_3a.sql', import.meta.url)),
    'utf8',
  );

  it('seeds only the tagged public OrbitChat evidence origins', () => {
    expect(migration).toContain(
      'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v1.0.0/index.d.ts',
    );
    expect(migration).toContain(
      'https://raw.githubusercontent.com/SharmaKunal14/orbitchat-sdk/v2.0.0/MIGRATION.md',
    );
    expect(migration).not.toContain('/main/');
  });

  it('does not grant runtime mutation of the trusted catalogue', () => {
    expect(migration).not.toMatch(
      /grant\s+(?:insert|update|delete)[\s\S]*to app_runtime/iu,
    );
    expect(migration).toMatch(
      /grant select on[\s\S]*migration_specifications[\s\S]*to app_runtime, app_readonly/iu,
    );
  });

  it('prevents duplicate open candidates and cross-repository impact reports', () => {
    expect(migration).toMatch(
      /create unique index migration_candidates_one_open_idx[\s\S]*where status = 'open'/iu,
    );
    expect(migration).toContain('foreign key (candidate_id, repository_id)');
    expect(migration).toContain('foreign key (repository_snapshot_id, repository_id)');
  });
});
