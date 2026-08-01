import { isIP } from 'node:net';

import { prerelease, valid } from 'semver';
import { z } from 'zod';

const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const npmPackageNamePattern =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/u;
const dnsNamePattern =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u;

const packageMetadataSchema = z
  .object({
    name: z.string().min(1).max(214),
    version: z.string().min(1).max(100),
    deprecated: z.string().optional(),
    homepage: z.string().max(2048).optional(),
    repository: z
      .union([z.string().max(2048), z.object({ url: z.string().max(2048) }).loose()])
      .optional(),
    bugs: z
      .union([z.string().max(2048), z.object({ url: z.string().max(2048) }).loose()])
      .optional(),
  })
  .loose();

export type PackageSourceKind =
  'package_registry_release' | 'sdk_repository_release' | 'homepage' | 'issue_tracker';

export interface PackageSourceCandidate {
  sourceKind: PackageSourceKind;
  canonicalUrl: string;
  canonicalDomain: string;
}

export interface NpmPackageResolution {
  packageName: string;
  latestVersion: string;
  deprecated: boolean;
  registryEtag: string | null;
  registryUrl: string;
  candidates: PackageSourceCandidate[];
}

export type NpmRegistrySafeErrorCode =
  | 'NPM_PACKAGE_NAME_INVALID'
  | 'NPM_REGISTRY_TIMEOUT'
  | 'NPM_REGISTRY_REDIRECT_REJECTED'
  | 'NPM_PACKAGE_NOT_FOUND'
  | 'NPM_REGISTRY_REQUEST_FAILED'
  | 'NPM_REGISTRY_MEDIA_TYPE_INVALID'
  | 'NPM_REGISTRY_RESPONSE_TOO_LARGE'
  | 'NPM_REGISTRY_RESPONSE_INVALID'
  | 'NPM_REGISTRY_PACKAGE_MISMATCH'
  | 'NPM_REGISTRY_VERSION_INVALID';

export class NpmRegistryError extends Error {
  public constructor(public readonly safeCode: NpmRegistrySafeErrorCode) {
    super('npm package metadata could not be resolved safely.');
    this.name = 'NpmRegistryError';
  }
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function assertPackageName(packageName: string): void {
  if (
    packageName.length < 1 ||
    packageName.length > 214 ||
    !npmPackageNamePattern.test(packageName)
  ) {
    throw new NpmRegistryError('NPM_PACKAGE_NAME_INVALID');
  }
}

function packagePath(packageName: string): string {
  return encodeURIComponent(packageName);
}

function isUnsafeHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    isIP(normalized) !== 0 ||
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.length > 253 ||
    !dnsNamePattern.test(normalized)
  );
}

function candidateUrl(rawValue: string | undefined): URL | null {
  if (rawValue === undefined || rawValue.length === 0) return null;

  let value = rawValue.trim();
  const githubShorthand = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(value);
  if (githubShorthand?.[1] !== undefined) {
    value = `https://github.com/${githubShorthand[1]}`;
  } else if (value.startsWith('git+https://')) {
    value = value.slice(4);
  } else if (value.startsWith('git://github.com/')) {
    value = `https://${value.slice('git://'.length)}`;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username !== '' ||
      url.password !== '' ||
      (url.port !== '' && url.port !== '443') ||
      url.search !== '' ||
      isUnsafeHostname(url.hostname)
    ) {
      return null;
    }
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    url.port = '';
    url.pathname = url.pathname.replace(/\.git\/?$/u, '').replace(/\/$/u, '') || '/';
    return url.toString().length <= 2048 ? url : null;
  } catch {
    return null;
  }
}

function addCandidate(
  candidates: PackageSourceCandidate[],
  sourceKind: PackageSourceKind,
  url: URL | null,
): void {
  if (url === null) return;
  const canonicalUrl = url.toString();
  if (
    candidates.some(
      candidate =>
        candidate.sourceKind === sourceKind && candidate.canonicalUrl === canonicalUrl,
    )
  ) {
    return;
  }
  candidates.push({ sourceKind, canonicalUrl, canonicalDomain: url.hostname });
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_RESPONSE_BYTES
    ) {
      throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_TOO_LARGE');
    }
  }

  if (response.body === null) {
    throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let result = await reader.read();
  while (!result.done) {
    bytes += result.value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_TOO_LARGE');
    }
    chunks.push(result.value);
    result = await reader.read();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function metadataValue(
  value: string | { url: string } | undefined,
): string | undefined {
  return typeof value === 'string' ? value : value?.url;
}

export async function resolveNpmPackageMetadata(
  packageName: string,
  options: {
    fetch?: Fetch;
    registryOrigin?: typeof DEFAULT_REGISTRY_ORIGIN;
    timeoutMs?: number;
  } = {},
): Promise<NpmPackageResolution> {
  assertPackageName(packageName);
  const registryOrigin = options.registryOrigin ?? DEFAULT_REGISTRY_ORIGIN;
  const encodedName = packagePath(packageName);
  const requestUrl = `${registryOrigin}/${encodedName}/latest`;
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  let response: Response;
  try {
    response = await fetchImplementation(requestUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'migration-api-package-source-resolver/1.0',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    ) {
      throw new NpmRegistryError('NPM_REGISTRY_TIMEOUT');
    }
    throw new NpmRegistryError('NPM_REGISTRY_REQUEST_FAILED');
  }

  if (response.status >= 300 && response.status < 400) {
    throw new NpmRegistryError('NPM_REGISTRY_REDIRECT_REJECTED');
  }
  if (response.status === 404) throw new NpmRegistryError('NPM_PACKAGE_NOT_FOUND');
  if (!response.ok) throw new NpmRegistryError('NPM_REGISTRY_REQUEST_FAILED');

  if (response.url !== '') {
    const finalUrl = new URL(response.url);
    if (
      finalUrl.origin !== registryOrigin ||
      finalUrl.pathname !== `/${encodedName}/latest`
    ) {
      throw new NpmRegistryError('NPM_REGISTRY_REDIRECT_REJECTED');
    }
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new NpmRegistryError('NPM_REGISTRY_MEDIA_TYPE_INVALID');
  }

  const body = await readBoundedBody(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  }
  const result = packageMetadataSchema.safeParse(parsed);
  if (!result.success) throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  if (result.data.name !== packageName) {
    throw new NpmRegistryError('NPM_REGISTRY_PACKAGE_MISMATCH');
  }
  if (valid(result.data.version) === null || prerelease(result.data.version) !== null) {
    throw new NpmRegistryError('NPM_REGISTRY_VERSION_INVALID');
  }

  const registryUrl = `${registryOrigin}/${encodedName}`;
  const candidates: PackageSourceCandidate[] = [];
  addCandidate(candidates, 'package_registry_release', candidateUrl(registryUrl));
  addCandidate(
    candidates,
    'sdk_repository_release',
    candidateUrl(metadataValue(result.data.repository)),
  );
  addCandidate(candidates, 'homepage', candidateUrl(result.data.homepage));
  addCandidate(
    candidates,
    'issue_tracker',
    candidateUrl(metadataValue(result.data.bugs)),
  );

  return {
    packageName,
    latestVersion: result.data.version,
    deprecated: result.data.deprecated !== undefined,
    registryEtag: response.headers.get('etag')?.slice(0, 512) ?? null,
    registryUrl,
    candidates,
  };
}

export function npmRegistrySafeErrorCode(error: unknown): NpmRegistrySafeErrorCode {
  return error instanceof NpmRegistryError
    ? error.safeCode
    : 'NPM_REGISTRY_REQUEST_FAILED';
}
