import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  downloadBoundedArtifact,
  materializeVerificationWorkspace,
  VerificationWorkspaceError,
} from '@migration/verifier-workspace';

const verificationAttemptId = 'e4e2d9db-bd1c-4eef-b685-231128724583';
const baseCommitSha = 'a'.repeat(40);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe('Stage 6C exact verification workspace', () => {
  it('materializes the exact snapshot and applies the validated canonical patch', async () => {
    const workspaceRoot = await temporaryRoot();
    const snapshot = await archive([
      ['package.json', '{"name":"fixture"}\n'],
      ['src/client.ts', 'const version = "v1";\nexport { version };\n'],
    ]);
    const patch = Buffer.from(
      [
        'diff --git a/src/client.ts b/src/client.ts',
        '--- a/src/client.ts',
        '+++ b/src/client.ts',
        '@@ -1,2 +1,2 @@',
        '-const version = "v1";',
        '+const version = "v2";',
        ' export { version };',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await materializeVerificationWorkspace({
      workspaceRoot,
      verificationAttemptId,
      baseCommitSha,
      snapshot: { bytes: snapshot, digest: digest(snapshot) },
      patch: { bytes: patch, digest: digest(patch) },
    });

    await expect(
      readFile(join(result.repositoryPath, 'src/client.ts'), 'utf8'),
    ).resolves.toBe('const version = "v2";\nexport { version };\n');
    expect(result.manifest).toMatchObject({
      schemaVersion: '1.0',
      verificationAttemptId,
      baseCommitSha,
      snapshotDigest: digest(snapshot),
      patchDigest: digest(patch),
      fileCount: 2,
      changedFiles: [{ path: 'src/client.ts' }],
    });
    await expect(readFile(result.manifestPath, 'utf8')).resolves.toBe(
      JSON.stringify(result.manifest),
    );
  });

  it('rejects traversal, links, and duplicate archive paths', async () => {
    for (const maliciousArchive of [
      await archive([['../escape.txt', 'escape']]),
      await archive([
        ['safe.txt', 'first'],
        ['safe.txt', 'second'],
      ]),
      await archive([], [{ name: 'link', type: 'symlink', linkname: '/etc/passwd' }]),
    ]) {
      const patch = canonicalPatch('safe.txt', 'first', 'changed');
      await expect(
        materializeVerificationWorkspace({
          workspaceRoot: await temporaryRoot(),
          verificationAttemptId,
          baseCommitSha,
          snapshot: {
            bytes: maliciousArchive,
            digest: digest(maliciousArchive),
          },
          patch: { bytes: patch, digest: digest(patch) },
        }),
      ).rejects.toBeInstanceOf(VerificationWorkspaceError);
    }
  });

  it('rejects a patch whose context does not match the exact snapshot', async () => {
    const snapshot = await archive([['src/client.ts', 'const value = 1;\n']]);
    const patch = canonicalPatch(
      'src/client.ts',
      'const value = 2;',
      'const value = 3;',
    );

    await expect(
      materializeVerificationWorkspace({
        workspaceRoot: await temporaryRoot(),
        verificationAttemptId,
        baseCommitSha,
        snapshot: { bytes: snapshot, digest: digest(snapshot) },
        patch: { bytes: patch, digest: digest(patch) },
      }),
    ).rejects.toMatchObject({
      safeCode: 'VERIFICATION_PATCH_BASE_MISMATCH',
    });
  });

  it('rejects modified artifact bytes before creating a workspace', async () => {
    const snapshot = await archive([['src/client.ts', 'const value = 1;\n']]);
    const patch = canonicalPatch(
      'src/client.ts',
      'const value = 1;',
      'const value = 2;',
    );

    await expect(
      materializeVerificationWorkspace({
        workspaceRoot: await temporaryRoot(),
        verificationAttemptId,
        baseCommitSha,
        snapshot: { bytes: snapshot, digest: 'b'.repeat(64) },
        patch: { bytes: patch, digest: digest(patch) },
      }),
    ).rejects.toMatchObject({
      safeCode: 'VERIFICATION_ARTIFACT_DIGEST_MISMATCH',
    });
  });

  it('downloads only exact-size, exact-digest regional S3 objects without redirects', async () => {
    const body = Buffer.from('artifact', 'utf8');
    const fetchImplementation = (): Promise<Response> =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(body.byteLength) },
        }),
      );
    await expect(
      downloadBoundedArtifact({
        url: 'https://migration-artifacts.s3.ap-southeast-2.amazonaws.com/input?signature=secret',
        expectedDigest: digest(body),
        expectedBytes: body.byteLength,
        maximumBytes: 100,
        artifactBucket: 'migration-artifacts',
        awsRegion: 'ap-southeast-2',
        fetchImplementation,
      }),
    ).resolves.toEqual(body);

    for (const url of [
      'http://migration-artifacts.s3.ap-southeast-2.amazonaws.com/input',
      'https://127.0.0.1/input',
      'https://migration-artifacts.s3.us-east-1.amazonaws.com/input',
    ]) {
      await expect(
        downloadBoundedArtifact({
          url,
          expectedDigest: digest(body),
          expectedBytes: body.byteLength,
          maximumBytes: 100,
          artifactBucket: 'migration-artifacts',
          awsRegion: 'ap-southeast-2',
          fetchImplementation,
        }),
      ).rejects.toMatchObject({
        safeCode: 'VERIFICATION_ARTIFACT_DOWNLOAD_FAILED',
      });
    }
  });

  it('does not expose bearer URLs in safe errors', async () => {
    const bearerUrl =
      'https://migration-artifacts.s3.ap-southeast-2.amazonaws.com/input?signature=do-not-log';
    try {
      await downloadBoundedArtifact({
        url: bearerUrl,
        expectedDigest: 'a'.repeat(64),
        expectedBytes: 1,
        maximumBytes: 1,
        artifactBucket: 'migration-artifacts',
        awsRegion: 'ap-southeast-2',
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 403 })),
      });
      throw new Error('Expected the download to fail.');
    } catch (error) {
      expect(String(error)).not.toContain('do-not-log');
    }
  });

  it('rejects failed, oversized, incomplete, and digest-mismatched downloads', async () => {
    const baseInput = {
      url: 'https://migration-artifacts.s3.ap-southeast-2.amazonaws.com/input',
      expectedDigest: digest(Buffer.from('a')),
      expectedBytes: 1,
      maximumBytes: 2,
      artifactBucket: 'migration-artifacts',
      awsRegion: 'ap-southeast-2',
    } as const;
    const cases: readonly {
      readonly fetchImplementation: typeof fetch;
      readonly safeCode:
        | 'VERIFICATION_ARTIFACT_DOWNLOAD_FAILED'
        | 'VERIFICATION_ARTIFACT_SIZE_INVALID'
        | 'VERIFICATION_ARTIFACT_DIGEST_MISMATCH';
    }[] = [
      {
        fetchImplementation: () => Promise.reject(new Error('network failed')),
        safeCode: 'VERIFICATION_ARTIFACT_DOWNLOAD_FAILED',
      },
      {
        fetchImplementation: () =>
          Promise.resolve(
            new Response('a', {
              status: 200,
              headers: { 'content-length': '2' },
            }),
          ),
        safeCode: 'VERIFICATION_ARTIFACT_SIZE_INVALID',
      },
      {
        fetchImplementation: () => Promise.resolve(new Response('ab')),
        safeCode: 'VERIFICATION_ARTIFACT_SIZE_INVALID',
      },
      {
        fetchImplementation: () => Promise.resolve(new Response('b')),
        safeCode: 'VERIFICATION_ARTIFACT_DIGEST_MISMATCH',
      },
    ];
    for (const testCase of cases) {
      await expect(
        downloadBoundedArtifact({
          ...baseInput,
          fetchImplementation: testCase.fetchImplementation,
        }),
      ).rejects.toMatchObject({ safeCode: testCase.safeCode });
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'migration-verifier-')));
  temporaryRoots.push(root);
  return root;
}

function canonicalPatch(path: string, before: string, after: string): Buffer {
  return Buffer.from(
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      '@@ -1,1 +1,1 @@',
      `-${before}`,
      `+${after}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

async function archive(
  files: readonly (readonly [string, string])[],
  extraEntries: readonly {
    readonly name: string;
    readonly type: 'symlink';
    readonly linkname: string;
  }[] = [],
): Promise<Buffer> {
  const pack = tar.pack();
  for (const [name, content] of files) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name,
          type: 'file',
          size: Buffer.byteLength(content),
          mode: 0o644,
        },
        content,
        error => (error ? reject(error) : resolve()),
      );
    });
  }
  for (const entry of extraEntries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(entry, error => (error ? reject(error) : resolve()));
    });
  }
  pack.finalize();
  const gzip = createGzip();
  pack.pipe(gzip);
  const chunks: Buffer[] = [];
  for await (const chunk of gzip) {
    chunks.push(Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
