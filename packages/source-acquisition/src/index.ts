import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';

import tar from 'tar-stream';

import type { InventoryFile } from '@migration/repository-inventory';

const MAX_FILES = 20_000;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

export type AcquisitionFailureCode =
  | 'ARCHIVE_INVALID'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_PATH_UNSAFE'
  | 'GIT_LFS_UNSUPPORTED'
  | 'GIT_SUBMODULES_UNSUPPORTED'
  | 'MISSING_SUPPORTED_MANIFEST'
  | 'SYMLINK_UNSUPPORTED';

export class AcquisitionError extends Error {
  public constructor(public readonly safeCode: AcquisitionFailureCode) {
    super('The repository archive could not be acquired safely.');
    this.name = 'AcquisitionError';
  }
}

export interface NormalizedArchive {
  readonly digest: string;
  readonly bytes: number;
  readonly fileCount: number;
  readonly inventoryFiles: readonly InventoryFile[];
}

export async function normalizeGithubTarball(
  inputPath: string,
  outputPath: string,
): Promise<NormalizedArchive> {
  const extract = tar.extract();
  const pack = tar.pack();
  const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 });
  const archiveFinished = new Promise<void>((resolve, reject) => {
    output.once('finish', resolve);
    output.once('error', reject);
  });
  pack.pipe(createGzip({ level: 9 })).pipe(output);

  let root: string | undefined;
  let fileCount = 0;
  let expandedBytes = 0;
  const paths = new Set<string>();
  const inventoryFiles: InventoryFile[] = [];

  extract.on('entry', (header, stream, next) => {
    void (async (): Promise<void> => {
      const components = safeArchiveComponents(header.name);
      root ??= components[0];
      if (components[0] !== root) {
        throw new AcquisitionError('ARCHIVE_PATH_UNSAFE');
      }
      const relativePath = components.slice(1).join('/');
      if (!relativePath) {
        stream.resume();
        await finishedEntry(stream);
        next();
        return;
      }
      if (header.type === 'directory') {
        stream.resume();
        await finishedEntry(stream);
        next();
        return;
      }
      if (header.type === 'symlink' || header.type === 'link') {
        throw new AcquisitionError('SYMLINK_UNSUPPORTED');
      }
      if (header.type !== 'file') {
        throw new AcquisitionError('ARCHIVE_INVALID');
      }
      const declaredSize = header.size;
      if (
        declaredSize === undefined ||
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > MAX_FILE_BYTES
      ) {
        throw new AcquisitionError('ARCHIVE_LIMIT_EXCEEDED');
      }
      requireSafeRelativePath(relativePath);
      if (paths.has(relativePath)) {
        throw new AcquisitionError('ARCHIVE_PATH_UNSAFE');
      }
      paths.add(relativePath);
      fileCount += 1;
      expandedBytes += declaredSize;
      if (fileCount > MAX_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new AcquisitionError('ARCHIVE_LIMIT_EXCEEDED');
      }

      const chunks: Buffer[] = [];
      let actualBytes = 0;
      for await (const value of stream) {
        const chunk = Buffer.from(value as Uint8Array);
        actualBytes += chunk.byteLength;
        if (actualBytes > declaredSize || actualBytes > MAX_FILE_BYTES) {
          throw new AcquisitionError('ARCHIVE_INVALID');
        }
        chunks.push(chunk);
      }
      if (actualBytes !== declaredSize) {
        throw new AcquisitionError('ARCHIVE_INVALID');
      }
      const content = Buffer.concat(chunks);
      if (relativePath === '.gitmodules') {
        throw new AcquisitionError('GIT_SUBMODULES_UNSUPPORTED');
      }
      if (
        content
          .subarray(0, Math.min(content.byteLength, 256))
          .toString('utf8')
          .startsWith(LFS_POINTER)
      ) {
        throw new AcquisitionError('GIT_LFS_UNSUPPORTED');
      }
      if (
        posix.basename(relativePath) === 'package.json' ||
        posix.basename(relativePath) === 'package-lock.json'
      ) {
        inventoryFiles.push({ path: relativePath, content });
      }
      await new Promise<void>((resolve, reject) => {
        pack.entry(
          {
            name: relativePath,
            type: 'file',
            size: content.byteLength,
            mode: 0o644,
            uid: 0,
            gid: 0,
            mtime: new Date(0),
          },
          content,
          error => (error ? reject(error) : resolve()),
        );
      });
      next();
    })().catch((error: unknown) => extract.destroy(asError(error)));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      extract.once('finish', resolve);
      extract.once('error', reject);
      createReadStream(inputPath)
        .pipe(createGunzip())
        .once('error', reject)
        .pipe(extract);
    });
    if (fileCount === 0) throw new AcquisitionError('ARCHIVE_INVALID');
    pack.finalize();
    await archiveFinished;
    const metadata = await stat(outputPath);
    const digest = await digestFile(outputPath);
    return {
      digest,
      bytes: metadata.size,
      fileCount,
      inventoryFiles,
    };
  } catch (error) {
    pack.destroy();
    output.destroy();
    if (error instanceof AcquisitionError) throw error;
    throw new AcquisitionError('ARCHIVE_INVALID');
  }
}

export function requireSafeRelativePath(value: string): string {
  const components = safeArchiveComponents(value);
  const normalized = components.join('/');
  if (normalized !== value || normalized === '.' || normalized === '..') {
    throw new AcquisitionError('ARCHIVE_PATH_UNSAFE');
  }
  return normalized;
}

function safeArchiveComponents(value: string): string[] {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new AcquisitionError('ARCHIVE_PATH_UNSAFE');
  }
  const components = value.replace(/\/$/u, '').split('/');
  if (
    components.length === 0 ||
    components.some(
      component => component === '' || component === '.' || component === '..',
    )
  ) {
    throw new AcquisitionError('ARCHIVE_PATH_UNSAFE');
  }
  return components;
}

function finishedEntry(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('end', resolve);
    stream.once('error', reject);
  });
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Uint8Array);
  }
  return hash.digest('hex');
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Archive processing failed.');
}
