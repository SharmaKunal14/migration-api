import { posix } from 'node:path';

import { z } from 'zod';

const MAX_INVENTORY_FILES = 2_000;
const MAX_INVENTORY_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCKFILE_BYTES = 8 * 1024 * 1024;
const MAX_PATH_BYTES = 1_024;
const MAX_MANIFESTS = 200;
const MAX_OBSERVATIONS = 10_000;
export type DependencyKind = 'dependency' | 'development' | 'optional' | 'peer';

export interface InventoryFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface DependencyObservation {
  readonly packageName: string;
  readonly kind: DependencyKind;
  readonly manifestPath: string;
  readonly lockfilePath: string | null;
  readonly declaredRange: string;
  readonly resolvedVersion: string | null;
  readonly discoveryMethod: 'manifest' | 'npm_lockfile';
}

export interface RepositoryInventory {
  readonly manifests: readonly string[];
  readonly lockfiles: readonly string[];
  readonly observations: readonly DependencyObservation[];
}

const packageNameSchema = z
  .string()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/iu);

const dependencyMapSchema = z.record(packageNameSchema, z.string().min(1).max(1_024));

const packageManifestSchema = z
  .object({
    dependencies: dependencyMapSchema.optional(),
    devDependencies: dependencyMapSchema.optional(),
    optionalDependencies: dependencyMapSchema.optional(),
    peerDependencies: dependencyMapSchema.optional(),
  })
  .loose();

const npmLockPackageSchema = z
  .object({
    version: z.string().min(1).max(1_024).optional(),
  })
  .loose();

const npmLockSchema = z
  .object({
    lockfileVersion: z.number().int().min(2).max(3),
    packages: z.record(z.string(), npmLockPackageSchema),
  })
  .loose();

export class InventoryError extends Error {
  public constructor(
    public readonly safeCode:
      | 'INVENTORY_LIMIT_EXCEEDED'
      | 'INVENTORY_PATH_UNSAFE'
      | 'MANIFEST_INVALID'
      | 'LOCKFILE_INVALID',
  ) {
    super('Repository inventory could not be produced safely.');
    this.name = 'InventoryError';
  }
}

export function inventoryRepository(
  inputFiles: readonly InventoryFile[],
): RepositoryInventory {
  if (inputFiles.length > MAX_INVENTORY_FILES) {
    throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
  }

  const files = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const input of inputFiles) {
    const path = requireSafeRelativePath(input.path);
    totalBytes += input.content.byteLength;
    if (totalBytes > MAX_INVENTORY_BYTES) {
      throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
    }
    if (files.has(path)) {
      throw new InventoryError('INVENTORY_PATH_UNSAFE');
    }
    files.set(path, input.content);
  }

  const manifests = [...files.keys()]
    .filter(path => posix.basename(path) === 'package.json')
    .sort();
  const lockfiles = [...files.keys()]
    .filter(path => posix.basename(path) === 'package-lock.json')
    .sort();
  if (manifests.length > MAX_MANIFESTS || lockfiles.length > MAX_MANIFESTS) {
    throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
  }
  const observations: DependencyObservation[] = [];

  for (const manifestPath of manifests) {
    const manifestBytes = files.get(manifestPath);
    if (!manifestBytes || manifestBytes.byteLength > MAX_MANIFEST_BYTES) {
      throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
    }
    const manifest = parseJson(
      packageManifestSchema,
      manifestBytes,
      'MANIFEST_INVALID',
    );
    const lockfilePath = nearestLockfile(manifestPath, lockfiles);
    const lockfile = lockfilePath ? parseLockfile(files.get(lockfilePath)) : undefined;

    appendDependencies(
      observations,
      manifestPath,
      lockfilePath ?? null,
      manifest.dependencies,
      'dependency',
      lockfile,
    );
    appendDependencies(
      observations,
      manifestPath,
      lockfilePath ?? null,
      manifest.devDependencies,
      'development',
      lockfile,
    );
    appendDependencies(
      observations,
      manifestPath,
      lockfilePath ?? null,
      manifest.optionalDependencies,
      'optional',
      lockfile,
    );
    appendDependencies(
      observations,
      manifestPath,
      lockfilePath ?? null,
      manifest.peerDependencies,
      'peer',
      lockfile,
    );
  }

  observations.sort((left, right) =>
    [left.manifestPath, left.packageName, left.kind]
      .join('\0')
      .localeCompare([right.manifestPath, right.packageName, right.kind].join('\0')),
  );
  if (observations.length > MAX_OBSERVATIONS) {
    throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
  }
  return { manifests, lockfiles, observations };
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
    throw new InventoryError('INVENTORY_PATH_UNSAFE');
  }
  const normalized = posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    value
      .split('/')
      .some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new InventoryError('INVENTORY_PATH_UNSAFE');
  }
  return normalized;
}

function parseLockfile(bytes: Uint8Array | undefined): z.infer<typeof npmLockSchema> {
  if (!bytes || bytes.byteLength > MAX_LOCKFILE_BYTES) {
    throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
  }
  return parseJson(npmLockSchema, bytes, 'LOCKFILE_INVALID');
}

function parseJson<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array,
  code: 'MANIFEST_INVALID' | 'LOCKFILE_INVALID',
): T {
  try {
    return schema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch {
    throw new InventoryError(code);
  }
}

function nearestLockfile(
  manifestPath: string,
  lockfiles: readonly string[],
): string | undefined {
  let directory = posix.dirname(manifestPath);
  for (;;) {
    const candidate =
      directory === '.' ? 'package-lock.json' : `${directory}/package-lock.json`;
    if (lockfiles.includes(candidate)) {
      return candidate;
    }
    if (directory === '.') {
      return undefined;
    }
    directory = posix.dirname(directory);
  }
}

function appendDependencies(
  output: DependencyObservation[],
  manifestPath: string,
  lockfilePath: string | null,
  dependencies: Record<string, string> | undefined,
  kind: DependencyKind,
  lockfile: z.infer<typeof npmLockSchema> | undefined,
): void {
  if (!dependencies) return;
  for (const [packageName, declaredRange] of Object.entries(dependencies)) {
    if (output.length >= MAX_OBSERVATIONS) {
      throw new InventoryError('INVENTORY_LIMIT_EXCEEDED');
    }
    const resolvedVersion = resolveNpmVersion(lockfile, manifestPath, packageName);
    output.push({
      packageName,
      kind,
      manifestPath,
      lockfilePath,
      declaredRange,
      resolvedVersion,
      discoveryMethod: resolvedVersion ? 'npm_lockfile' : 'manifest',
    });
  }
}

function resolveNpmVersion(
  lockfile: z.infer<typeof npmLockSchema> | undefined,
  manifestPath: string,
  packageName: string,
): string | null {
  if (!lockfile) return null;
  const manifestDirectory = posix.dirname(manifestPath);
  const localPrefix = manifestDirectory === '.' ? '' : `${manifestDirectory}/`;
  const candidates = [
    `${localPrefix}node_modules/${packageName}`,
    `node_modules/${packageName}`,
  ];
  for (const candidate of candidates) {
    const version = lockfile.packages[candidate]?.version;
    if (version) return version;
  }
  return null;
}
