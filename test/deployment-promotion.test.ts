import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const createManifest = fileURLToPath(
  new URL('../scripts/deploy/create-promotion-manifest.mjs', import.meta.url),
);
const verifyPromotion = fileURLToPath(
  new URL('../scripts/deploy/verify-promotion.mjs', import.meta.url),
);
const verifySignature = fileURLToPath(
  new URL('../scripts/deploy/verify-promotion-signature.sh', import.meta.url),
);
const temporaryDirectories: string[] = [];
const digest = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const imageDefinitions = [
  ['agent', 'migration-api-development-agent'],
  ['migrator', 'migration-api-development-database-migrator'],
  ['sourceFetcher', 'migration-api-development-source-fetcher'],
  ['vendorFetcher', 'migration-api-development-vendor-fetcher'],
  ['changeIntelligenceAgent', 'migration-api-development-change-intelligence-agent'],
  ['impactAnalysisAgent', 'migration-api-development-impact-analysis-agent'],
  ['migrationAgent', 'migration-api-development-migration-agent'],
] as const;

interface PromotionFixture {
  readonly directory: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly expectedMigratorDigest: string;
  readonly githubEnvironmentPath: string;
  readonly githubOutputPath: string;
  readonly imagesPath: string;
  readonly manifestPath: string;
  readonly payloadPath: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly signaturePath: string;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(): PromotionFixture {
  const directory = mkdtempSync(join(tmpdir(), 'migration-promotion-'));
  temporaryDirectories.push(directory);
  const registry = '393209814365.dkr.ecr.ap-southeast-2.amazonaws.com';
  const expectedMigratorDigest = digest('migrator-content');
  const runId = '123456';
  const runAttempt = '1';
  const environment = {
    ...process.env,
    ECR_REGISTRY: registry,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_REPOSITORY: 'SharmaKunal14/migration-api',
    GITHUB_RUN_ATTEMPT: runAttempt,
    GITHUB_RUN_ID: runId,
    GITHUB_SHA: 'a'.repeat(40),
    MIGRATOR_CONTENT_DIGEST: expectedMigratorDigest,
    PROMOTION_SIGNING_KEY_ARN:
      'arn:aws:kms:ap-southeast-2:393209814365:key/00000000-0000-0000-0000-000000000005',
    VITE_API_BASE_URL: '/api',
    VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
    VITE_SUPABASE_URL: 'https://project-ref.supabase.co',
  };
  const imagesPath = join(directory, 'images.json');
  const payloadPath = join(directory, 'promotion-payload.tar.gz');
  const manifestPath = join(directory, 'promotion-manifest.json');
  const signaturePath = join(directory, 'promotion-signature.json');
  const githubEnvironmentPath = join(directory, 'github-env');
  const githubOutputPath = join(directory, 'github-output');
  writeFileSync(payloadPath, 'immutable payload');
  writeFileSync(
    imagesPath,
    JSON.stringify(
      imageDefinitions.map(([key, repository], index) => ({
        key,
        repository,
        subjectName: `${registry}/${repository}`,
        digest: digest(`image-${String(index)}`),
        scanDigest: digest(`scan-${String(index)}`),
      })),
    ),
  );
  writeFileSync(githubEnvironmentPath, '');
  writeFileSync(githubOutputPath, '');
  return {
    directory,
    environment,
    expectedMigratorDigest,
    githubEnvironmentPath,
    githubOutputPath,
    imagesPath,
    manifestPath,
    payloadPath,
    runId,
    runAttempt,
    signaturePath,
  };
}

describe('CI promotion contract', () => {
  it('binds exact build inputs and exports only validated immutable digests', () => {
    const promotion = fixture();
    const created = spawnSync(
      process.execPath,
      [
        createManifest,
        promotion.imagesPath,
        promotion.payloadPath,
        promotion.manifestPath,
      ],
      { encoding: 'utf8', env: promotion.environment },
    );
    expect(created.status, created.stderr).toBe(0);

    const verified = spawnSync(
      process.execPath,
      [
        verifyPromotion,
        promotion.manifestPath,
        promotion.payloadPath,
        promotion.runId,
        promotion.runAttempt,
      ],
      {
        encoding: 'utf8',
        env: {
          ...promotion.environment,
          GITHUB_ENV: promotion.githubEnvironmentPath,
          GITHUB_OUTPUT: promotion.githubOutputPath,
        },
      },
    );
    expect(verified.status, verified.stderr).toBe(0);
    expect(readFileSync(promotion.githubEnvironmentPath, 'utf8')).toContain(
      `MIGRATOR_CONTENT_DIGEST=${promotion.expectedMigratorDigest}`,
    );
    expect(readFileSync(promotion.githubOutputPath, 'utf8')).toContain(
      `ci_run_id=${promotion.runId}`,
    );
  });

  it('rejects a protected web configuration that differs from the CI build', () => {
    const promotion = fixture();
    expect(
      spawnSync(
        process.execPath,
        [
          createManifest,
          promotion.imagesPath,
          promotion.payloadPath,
          promotion.manifestPath,
        ],
        { encoding: 'utf8', env: promotion.environment },
      ).status,
    ).toBe(0);

    const verified = spawnSync(
      process.execPath,
      [
        verifyPromotion,
        promotion.manifestPath,
        promotion.payloadPath,
        promotion.runId,
        promotion.runAttempt,
      ],
      {
        encoding: 'utf8',
        env: {
          ...promotion.environment,
          GITHUB_ENV: promotion.githubEnvironmentPath,
          GITHUB_OUTPUT: promotion.githubOutputPath,
          VITE_SUPABASE_URL: 'https://other-project.supabase.co',
        },
      },
    );
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain(
      'The promoted web configuration differs from the protected deployment configuration.',
    );
  });

  it('rejects an artifact from a different attempt of the selected CI run', () => {
    const promotion = fixture();
    expect(
      spawnSync(
        process.execPath,
        [
          createManifest,
          promotion.imagesPath,
          promotion.payloadPath,
          promotion.manifestPath,
        ],
        { encoding: 'utf8', env: promotion.environment },
      ).status,
    ).toBe(0);

    const verified = spawnSync(
      process.execPath,
      [
        verifyPromotion,
        promotion.manifestPath,
        promotion.payloadPath,
        promotion.runId,
        '2',
      ],
      {
        encoding: 'utf8',
        env: {
          ...promotion.environment,
          GITHUB_ENV: promotion.githubEnvironmentPath,
          GITHUB_OUTPUT: promotion.githubOutputPath,
        },
      },
    );
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain(
      'The promotion workflow run attempt does not match the downloaded artifact.',
    );
  });

  it('rejects a payload modified after the manifest was produced', () => {
    const promotion = fixture();
    expect(
      spawnSync(
        process.execPath,
        [
          createManifest,
          promotion.imagesPath,
          promotion.payloadPath,
          promotion.manifestPath,
        ],
        { encoding: 'utf8', env: promotion.environment },
      ).status,
    ).toBe(0);
    writeFileSync(promotion.payloadPath, 'tampered payload');

    const verified = spawnSync(
      process.execPath,
      [
        verifyPromotion,
        promotion.manifestPath,
        promotion.payloadPath,
        promotion.runId,
        promotion.runAttempt,
      ],
      {
        encoding: 'utf8',
        env: {
          ...promotion.environment,
          GITHUB_ENV: promotion.githubEnvironmentPath,
          GITHUB_OUTPUT: promotion.githubOutputPath,
        },
      },
    );
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain(
      'The promotion payload digest does not match the signed manifest.',
    );
  });

  it('rejects a signature envelope that is not bound to the manifest digest', () => {
    const promotion = fixture();
    expect(
      spawnSync(
        process.execPath,
        [
          createManifest,
          promotion.imagesPath,
          promotion.payloadPath,
          promotion.manifestPath,
        ],
        { encoding: 'utf8', env: promotion.environment },
      ).status,
    ).toBe(0);
    writeFileSync(
      promotion.signaturePath,
      JSON.stringify({
        schemaVersion: '1.0',
        keyArn: promotion.environment.PROMOTION_SIGNING_KEY_ARN,
        signingAlgorithm: 'ECDSA_SHA_256',
        manifestDigest: digest('another manifest'),
        signature: Buffer.from('invalid signature').toString('base64'),
      }),
    );

    const verified = spawnSync(
      'bash',
      [verifySignature, promotion.manifestPath, promotion.signaturePath],
      { encoding: 'utf8', env: promotion.environment },
    );
    expect(verified.status).not.toBe(0);
  });
});
