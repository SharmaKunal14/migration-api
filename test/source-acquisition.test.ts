import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  normalizeGithubTarball,
  requireSafeRelativePath,
} from '@migration/source-acquisition';
import type { AcquisitionError } from '@migration/source-acquisition';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })),
  );
});

describe('GitHub archive normalization', () => {
  it('strips the GitHub root, records inventory files, and writes a bounded archive', async () => {
    const paths = await fixture([
      {
        name: 'acme-repository-abcdef/package.json',
        content: JSON.stringify({ dependencies: { react: '^19.0.0' } }),
      },
      {
        name: 'acme-repository-abcdef/src/',
        content: '',
        type: 'directory',
      },
      {
        name: 'acme-repository-abcdef/src/index.ts',
        content: 'export const value = 1;\n',
      },
    ]);

    const result = await normalizeGithubTarball(paths.input, paths.output);

    expect(result.fileCount).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.inventoryFiles.map(file => file.path)).toEqual(['package.json']);
    expect((await readFile(paths.output)).byteLength).toBe(result.bytes);
  });

  it.each([
    {
      name: 'symlink',
      entries: [
        {
          name: 'root/package.json',
          content: '',
          type: 'symlink' as const,
          linkname: '../../etc/passwd',
        },
      ],
      safeCode: 'SYMLINK_UNSUPPORTED',
    },
    {
      name: 'submodule',
      entries: [{ name: 'root/.gitmodules', content: '[submodule "unsafe"]' }],
      safeCode: 'GIT_SUBMODULES_UNSUPPORTED',
    },
    {
      name: 'Git LFS pointer',
      entries: [
        {
          name: 'root/package.json',
          content:
            'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n',
        },
      ],
      safeCode: 'GIT_LFS_UNSUPPORTED',
    },
  ])('rejects unsupported $name archive content', async fixtureCase => {
    const paths = await fixture(fixtureCase.entries);
    await expect(normalizeGithubTarball(paths.input, paths.output)).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: fixtureCase.safeCode as AcquisitionError['safeCode'],
      }),
    );
  });

  it('rejects archives whose entries do not share one GitHub root', async () => {
    const paths = await fixture([
      { name: 'root-a/package.json', content: '{}' },
      { name: 'root-b/package.json', content: '{}' },
    ]);
    await expect(normalizeGithubTarball(paths.input, paths.output)).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_PATH_UNSAFE',
      }),
    );
  });

  it('accepts canonical relative paths and rejects traversal or platform paths', () => {
    expect(requireSafeRelativePath('packages/client/package.json')).toBe(
      'packages/client/package.json',
    );
    for (const path of [
      '',
      '../package.json',
      '/package.json',
      'packages//package.json',
      'packages\\package.json',
      'C:/package.json',
      'package.json\0ignored',
      `${'a'.repeat(1_025)}.json`,
    ]) {
      expect(() => requireSafeRelativePath(path)).toThrow(
        expect.objectContaining<Partial<AcquisitionError>>({
          safeCode: 'ARCHIVE_PATH_UNSAFE',
        }),
      );
    }
  });

  it('rejects empty and duplicate-path archives', async () => {
    const empty = await fixture([]);
    await expect(normalizeGithubTarball(empty.input, empty.output)).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_INVALID',
      }),
    );

    const duplicate = await fixture([
      { name: 'root/package.json', content: '{}' },
      { name: 'root/package.json', content: '{}' },
    ]);
    await expect(
      normalizeGithubTarball(duplicate.input, duplicate.output),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_PATH_UNSAFE',
      }),
    );
  });

  it('rejects special files without extracting them', async () => {
    const paths = await fixture([
      {
        name: 'root/device',
        content: '',
        type: 'character-device',
      },
    ]);

    await expect(normalizeGithubTarball(paths.input, paths.output)).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_INVALID',
      }),
    );
  });

  it('rejects files and archives above their configured limits', async () => {
    const oversizedFile = await fixture([
      {
        name: 'root/oversized.bin',
        content: Buffer.alloc(32 * 1024 * 1024 + 1),
      },
    ]);
    await expect(
      normalizeGithubTarball(oversizedFile.input, oversizedFile.output),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_LIMIT_EXCEEDED',
      }),
    );

    const excessiveFiles = await fixture(
      Array.from({ length: 20_001 }, (_, index) => ({
        name: `root/files/${String(index).padStart(5, '0')}`,
        content: '',
      })),
    );
    await expect(
      normalizeGithubTarball(excessiveFiles.input, excessiveFiles.output),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AcquisitionError>>({
        safeCode: 'ARCHIVE_LIMIT_EXCEEDED',
      }),
    );
  }, 30_000);
});

interface FixtureEntry {
  readonly name: string;
  readonly content: string | Buffer;
  readonly type?: 'file' | 'symlink' | 'directory' | 'character-device';
  readonly linkname?: string;
}

async function fixture(entries: readonly FixtureEntry[]): Promise<{
  readonly input: string;
  readonly output: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'migration-api-source-'));
  temporaryDirectories.push(directory);
  const input = join(directory, 'input.tar.gz');
  const output = join(directory, 'output.tar.gz');
  await writeFile(input, await archive(entries));
  return { input, output };
}

function archive(entries: readonly FixtureEntry[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pack = tar.pack();
    const gzip = createGzip();
    const chunks: Buffer[] = [];
    gzip.on('data', (chunk: Buffer) => chunks.push(chunk));
    gzip.once('end', () => resolve(Buffer.concat(chunks)));
    gzip.once('error', reject);
    pack.once('error', reject);
    pack.pipe(gzip);
    for (const entry of entries) {
      const content =
        typeof entry.content === 'string' ? Buffer.from(entry.content) : entry.content;
      pack.entry(
        {
          name: entry.name,
          type: entry.type ?? 'file',
          linkname: entry.linkname,
          size:
            entry.type === 'symlink' ||
            entry.type === 'directory' ||
            entry.type === 'character-device'
              ? 0
              : content.byteLength,
        },
        entry.type === 'symlink' ||
          entry.type === 'directory' ||
          entry.type === 'character-device'
          ? undefined
          : content,
      );
    }
    pack.finalize();
  });
}
