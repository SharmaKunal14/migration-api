import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { posix } from 'node:path';
import { createGunzip } from 'node:zlib';

import tar from 'tar-stream';

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ARCHIVE_STREAM_BYTES = MAX_EXPANDED_BYTES + 32 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_PATH_BYTES = 1_024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type VerificationWorkspaceErrorCode =
  | 'VERIFICATION_ARTIFACT_DOWNLOAD_FAILED'
  | 'VERIFICATION_ARTIFACT_DIGEST_MISMATCH'
  | 'VERIFICATION_ARTIFACT_SIZE_INVALID'
  | 'VERIFICATION_ARCHIVE_INVALID'
  | 'VERIFICATION_ARCHIVE_LIMIT_EXCEEDED'
  | 'VERIFICATION_ARCHIVE_PATH_UNSAFE'
  | 'VERIFICATION_PATCH_INVALID'
  | 'VERIFICATION_PATCH_BASE_MISMATCH'
  | 'VERIFICATION_WORKSPACE_INVALID';

export class VerificationWorkspaceError extends Error {
  public constructor(public readonly safeCode: VerificationWorkspaceErrorCode) {
    super('The verification workspace could not be constructed safely.');
    this.name = 'VerificationWorkspaceError';
  }
}

export interface BoundedArtifactDownload {
  readonly url: string;
  readonly expectedDigest: string;
  readonly expectedBytes: number;
  readonly maximumBytes: number;
  readonly artifactBucket: string;
  readonly awsRegion: string;
  readonly fetchImplementation?: typeof fetch;
}

export interface VerificationWorkspaceInput {
  readonly workspaceRoot: string;
  readonly verificationAttemptId: string;
  readonly baseCommitSha: string;
  readonly snapshot: {
    readonly bytes: Uint8Array;
    readonly digest: string;
  };
  readonly patch: {
    readonly bytes: Uint8Array;
    readonly digest: string;
  };
}

export interface VerificationWorkspaceManifest {
  readonly schemaVersion: '1.0';
  readonly verificationAttemptId: string;
  readonly baseCommitSha: string;
  readonly snapshotDigest: string;
  readonly patchDigest: string;
  readonly fileCount: number;
  readonly expandedBytes: number;
  readonly changedFiles: readonly {
    readonly path: string;
    readonly beforeDigest: string;
    readonly afterDigest: string;
  }[];
}

export interface MaterializedVerificationWorkspace {
  readonly rootPath: string;
  readonly repositoryPath: string;
  readonly manifestPath: string;
  readonly manifest: VerificationWorkspaceManifest;
}

export interface AppliedTextPatchFile {
  readonly path: string;
  readonly content: string;
  readonly beforeDigest: string;
  readonly afterDigest: string;
}

export function applyValidatedTextPatch(
  patch: string,
  sourceFiles: ReadonlyMap<string, string>,
): readonly AppliedTextPatchFile[] {
  const files = parsePatch(patch);
  if (
    files.length !== sourceFiles.size ||
    files.some(file => !sourceFiles.has(file.path))
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_PATCH_BASE_MISMATCH');
  }
  return files.map(file => {
    const source = sourceFiles.get(file.path);
    if (source === undefined) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_BASE_MISMATCH');
    }
    const content = applyFileHunk(source, file);
    return {
      path: file.path,
      content,
      beforeDigest: digest(Buffer.from(source, 'utf8')),
      afterDigest: digest(Buffer.from(content, 'utf8')),
    };
  });
}

export async function downloadBoundedArtifact(
  input: BoundedArtifactDownload,
): Promise<Buffer> {
  requireDigest(input.expectedDigest);
  requireBoundedInteger(input.expectedBytes, 1, input.maximumBytes);
  requireBoundedInteger(input.maximumBytes, 1, MAX_EXPANDED_BYTES);
  const url = requireRegionalS3Url(input.url, input.artifactBucket, input.awsRegion);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (input.fetchImplementation ?? fetch)(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: 'application/octet-stream' },
    });
  } catch {
    clearTimeout(timeout);
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DOWNLOAD_FAILED');
  }
  if (response.status !== 200 || response.body === null) {
    clearTimeout(timeout);
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DOWNLOAD_FAILED');
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) ||
      Number(declaredLength) !== input.expectedBytes)
  ) {
    clearTimeout(timeout);
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_SIZE_INVALID');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    let complete = false;
    while (!complete) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        continue;
      }
      const chunk = Buffer.from(result.value);
      total += chunk.byteLength;
      if (total > input.expectedBytes || total > input.maximumBytes) {
        await reader.cancel();
        throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_SIZE_INVALID');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    clearTimeout(timeout);
    if (error instanceof VerificationWorkspaceError) throw error;
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DOWNLOAD_FAILED');
  }
  clearTimeout(timeout);
  if (total !== input.expectedBytes) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_SIZE_INVALID');
  }
  const bytes = Buffer.concat(chunks, total);
  if (digest(bytes) !== input.expectedDigest) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DIGEST_MISMATCH');
  }
  return bytes;
}

export async function materializeVerificationWorkspace(
  input: VerificationWorkspaceInput,
): Promise<MaterializedVerificationWorkspace> {
  validateWorkspaceInput(input);
  await requireSafeWorkspaceRoot(input.workspaceRoot);
  const rootPath = await mkdtemp(join(input.workspaceRoot, 'attempt-'));
  const repositoryPath = join(rootPath, 'repository');
  const manifestPath = join(rootPath, 'workspace-manifest.json');
  try {
    await mkdir(repositoryPath, { mode: 0o700 });
    const archive = await extractSnapshot(input.snapshot.bytes, repositoryPath);
    const changedFiles = await applyPatch(
      input.patch.bytes,
      repositoryPath,
      archive.paths,
    );
    const manifest: VerificationWorkspaceManifest = {
      schemaVersion: '1.0',
      verificationAttemptId: input.verificationAttemptId,
      baseCommitSha: input.baseCommitSha,
      snapshotDigest: input.snapshot.digest,
      patchDigest: input.patch.digest,
      fileCount: archive.fileCount,
      expandedBytes: archive.expandedBytes,
      changedFiles,
    };
    await writeFile(manifestPath, JSON.stringify(manifest), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return { rootPath, repositoryPath, manifestPath, manifest };
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true });
    if (error instanceof VerificationWorkspaceError) throw error;
    throw new VerificationWorkspaceError('VERIFICATION_WORKSPACE_INVALID');
  }
}

interface ExtractedSnapshot {
  readonly fileCount: number;
  readonly expandedBytes: number;
  readonly paths: ReadonlySet<string>;
}

async function extractSnapshot(
  input: Uint8Array,
  repositoryPath: string,
): Promise<ExtractedSnapshot> {
  const extract = tar.extract();
  let fileCount = 0;
  let expandedBytes = 0;
  let archiveStreamBytes = 0;
  const paths = new Set<string>();
  extract.on('entry', (header, stream, next) => {
    stream.on('error', () => undefined);
    void (async (): Promise<void> => {
      if (header.type !== 'file') {
        throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID');
      }
      const path = requireSafeRelativePath(header.name);
      if (paths.has(path)) {
        throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_PATH_UNSAFE');
      }
      const declaredSize = header.size;
      if (
        declaredSize === undefined ||
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > MAX_FILE_BYTES
      ) {
        throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_LIMIT_EXCEEDED');
      }
      fileCount += 1;
      expandedBytes += declaredSize;
      if (fileCount > MAX_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_LIMIT_EXCEEDED');
      }
      paths.add(path);
      const target = join(repositoryPath, ...path.split('/'));
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 });
      const output = createWriteStream(target, {
        flags: 'wx',
        mode: 0o600,
      });
      let actualBytes = 0;
      const completed = new Promise<void>((resolve, reject) => {
        output.once('finish', resolve);
        output.once('error', reject);
      });
      stream.on('data', chunk => {
        actualBytes += Buffer.from(chunk as Uint8Array).byteLength;
        if (actualBytes > declaredSize || actualBytes > MAX_FILE_BYTES) {
          stream.destroy(
            new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID'),
          );
        }
      });
      stream.pipe(output);
      await completed;
      if (actualBytes !== declaredSize) {
        throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID');
      }
      next();
    })().catch((error: unknown) => extract.destroy(asError(error)));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      extract.once('finish', resolve);
      extract.once('error', reject);
      const gunzip = createGunzip();
      gunzip.once('error', reject);
      gunzip.on('data', chunk => {
        archiveStreamBytes += Buffer.from(chunk as Uint8Array).byteLength;
        if (archiveStreamBytes > MAX_ARCHIVE_STREAM_BYTES) {
          gunzip.destroy(
            new VerificationWorkspaceError('VERIFICATION_ARCHIVE_LIMIT_EXCEEDED'),
          );
        }
      });
      gunzip.pipe(extract);
      gunzip.end(input);
    });
  } catch (error) {
    if (error instanceof VerificationWorkspaceError) throw error;
    throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID');
  }
  if (fileCount === 0) {
    throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID');
  }
  return { fileCount, expandedBytes, paths };
}

interface PatchFile {
  readonly path: string;
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

async function applyPatch(
  input: Uint8Array,
  repositoryPath: string,
  snapshotPaths: ReadonlySet<string>,
): Promise<VerificationWorkspaceManifest['changedFiles']> {
  const patch = decodeText(input, 'VERIFICATION_PATCH_INVALID');
  const files = parsePatch(patch);
  const changedFiles: {
    path: string;
    beforeDigest: string;
    afterDigest: string;
  }[] = [];
  for (const file of files) {
    if (!snapshotPaths.has(file.path)) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_BASE_MISMATCH');
    }
    const target = join(repositoryPath, ...file.path.split('/'));
    const before = await readFile(target);
    if (before.includes(0)) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
    }
    const beforeText = decodeText(before, 'VERIFICATION_PATCH_INVALID');
    const afterText = applyFileHunk(beforeText, file);
    const handle = await open(target, 'r+');
    try {
      await handle.truncate(0);
      await handle.writeFile(afterText, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    changedFiles.push({
      path: file.path,
      beforeDigest: digest(before),
      afterDigest: digest(Buffer.from(afterText, 'utf8')),
    });
  }
  return changedFiles;
}

function parsePatch(patch: string): PatchFile[] {
  if (
    patch.length === 0 ||
    Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES ||
    patch.includes('\r') ||
    patch.includes('\0')
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
  }
  const lines = patch.split('\n');
  const files: PatchFile[] = [];
  const seen = new Set<string>();
  let index = 0;
  while (index < lines.length - 1) {
    const diff = /^diff --git a\/(.+) b\/(.+)$/u.exec(lines[index] ?? '');
    if (!diff || diff[1] !== diff[2]) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
    }
    const path = requireSafeRelativePath(diff[1] ?? '');
    if (seen.has(path)) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
    }
    seen.add(path);
    if (lines[index + 1] !== `--- a/${path}` || lines[index + 2] !== `+++ b/${path}`) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
    }
    const hunk = /^@@ -([0-9]+),([0-9]+) \+([0-9]+),([0-9]+) @@$/u.exec(
      lines[index + 3] ?? '',
    );
    if (!hunk) {
      throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
    }
    index += 4;
    const hunkLines: string[] = [];
    while (
      index < lines.length &&
      !lines[index]?.startsWith('diff --git ') &&
      !(index === lines.length - 1 && lines[index] === '')
    ) {
      const line = lines[index] ?? '';
      if (
        !line.startsWith(' ') &&
        !line.startsWith('+') &&
        !line.startsWith('-') &&
        line !== '\\ No newline at end of file'
      ) {
        throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
      }
      hunkLines.push(line);
      index += 1;
    }
    files.push({
      path,
      oldStart: Number(hunk[1]),
      oldCount: Number(hunk[2]),
      newStart: Number(hunk[3]),
      newCount: Number(hunk[4]),
      lines: hunkLines,
    });
  }
  if (files.length === 0 || index !== lines.length - 1) {
    throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
  }
  return files;
}

function applyFileHunk(source: string, patch: PatchFile): string {
  const sourceEndsWithNewline = source.endsWith('\n');
  const sourceLines = source.split('\n');
  if (sourceEndsWithNewline) sourceLines.pop();
  const start = patch.oldStart === 0 ? 0 : patch.oldStart - 1;
  if (start > sourceLines.length || patch.newStart !== patch.oldStart) {
    throw new VerificationWorkspaceError('VERIFICATION_PATCH_BASE_MISMATCH');
  }
  const output = sourceLines.slice(0, start);
  let cursor = start;
  let consumed = 0;
  let produced = 0;
  let outputEndsWithNewline = true;
  let previousChange: string | undefined;
  for (const line of patch.lines) {
    if (line === '\\ No newline at end of file') {
      if (previousChange === '+' || previousChange === ' ') {
        outputEndsWithNewline = false;
      }
      continue;
    }
    const marker = line[0];
    const content = line.slice(1);
    previousChange = marker;
    if (marker === ' ' || marker === '-') {
      if (sourceLines[cursor] !== content) {
        throw new VerificationWorkspaceError('VERIFICATION_PATCH_BASE_MISMATCH');
      }
      cursor += 1;
      consumed += 1;
    }
    if (marker === ' ' || marker === '+') {
      output.push(content);
      produced += 1;
    }
  }
  if (consumed !== patch.oldCount || produced !== patch.newCount) {
    throw new VerificationWorkspaceError('VERIFICATION_PATCH_INVALID');
  }
  output.push(...sourceLines.slice(cursor));
  if (cursor < sourceLines.length) {
    outputEndsWithNewline = sourceEndsWithNewline;
  }
  return `${output.join('\n')}${outputEndsWithNewline ? '\n' : ''}`;
}

function validateWorkspaceInput(input: VerificationWorkspaceInput): void {
  if (
    !isAbsolute(input.workspaceRoot) ||
    !uuidPattern.test(input.verificationAttemptId) ||
    !commitPattern.test(input.baseCommitSha)
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_WORKSPACE_INVALID');
  }
  requireArtifact(input.snapshot.bytes, input.snapshot.digest, MAX_SNAPSHOT_BYTES);
  requireArtifact(input.patch.bytes, input.patch.digest, MAX_PATCH_BYTES);
}

async function requireSafeWorkspaceRoot(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new VerificationWorkspaceError('VERIFICATION_WORKSPACE_INVALID');
  }
  if ((await realpath(path)) !== path) {
    throw new VerificationWorkspaceError('VERIFICATION_WORKSPACE_INVALID');
  }
}

function requireArtifact(
  bytes: Uint8Array,
  expectedDigest: string,
  maximumBytes: number,
): void {
  requireDigest(expectedDigest);
  requireBoundedInteger(bytes.byteLength, 1, maximumBytes);
  if (digest(bytes) !== expectedDigest) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DIGEST_MISMATCH');
  }
}

function requireRegionalS3Url(value: string, bucket: string, region: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DOWNLOAD_FAILED');
  }
  const expectedHost = `${bucket}.s3.${region}.amazonaws.com`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expectedHost ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DOWNLOAD_FAILED');
  }
  return url;
}

function requireSafeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_PATH_BYTES ||
    value.includes('\0') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_PATH_UNSAFE');
  }
  const normalized = posix.normalize(value);
  const components = normalized.split('/');
  if (
    normalized !== value ||
    components.some(
      component => component === '' || component === '.' || component === '..',
    )
  ) {
    throw new VerificationWorkspaceError('VERIFICATION_ARCHIVE_PATH_UNSAFE');
  }
  return normalized;
}

function requireDigest(value: string): void {
  if (!sha256Pattern.test(value)) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_DIGEST_MISMATCH');
  }
}

function requireBoundedInteger(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new VerificationWorkspaceError('VERIFICATION_ARTIFACT_SIZE_INVALID');
  }
}

function decodeText(
  bytes: Uint8Array,
  safeCode: VerificationWorkspaceErrorCode,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new VerificationWorkspaceError(safeCode);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new VerificationWorkspaceError('VERIFICATION_ARCHIVE_INVALID');
}
