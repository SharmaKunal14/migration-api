import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { prerelease, valid } from 'semver';
import { z } from 'zod';

const DEFAULT_REGISTRY_ORIGIN = 'https://registry.npmjs.org';
const MAX_RESPONSE_BYTES = 1024 * 1024;
// Full npm metadata includes authoritative per-version publication timestamps.
// npm documents that some packuments exceed 10 MiB, so keep a higher but finite cap.
const MAX_PACKUMENT_RESPONSE_BYTES = 32 * 1024 * 1024;
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

const packageDocumentSchema = z
  .object({
    name: z.string().min(1).max(214),
    'dist-tags': z.object({ latest: z.string().min(1).max(100) }).loose(),
    time: z.record(z.string(), z.string()).optional(),
    versions: z.record(z.string(), z.unknown()),
  })
  .loose();

const packageVersionSchema = z.object({ deprecated: z.string().optional() }).loose();

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

export type NpmPackageReleasePoll =
  | {
      status: 'not_modified';
      registryEtag: string;
    }
  | {
      status: 'modified';
      packageName: string;
      latestVersion: string;
      latestDeprecated: boolean;
      publishedAt: string | null;
      registryEtag: string | null;
      responseDigest: string;
      responseBody: Uint8Array;
    };

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

export function npmRegistryPackageUrl(
  packageName: string,
  registryOrigin: typeof DEFAULT_REGISTRY_ORIGIN = DEFAULT_REGISTRY_ORIGIN,
): string {
  assertPackageName(packageName);
  return `${registryOrigin}/${packagePath(packageName)}`;
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

async function readBoundedBody(
  response: Response,
  maximumBytes = MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > maximumBytes
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
    if (bytes > maximumBytes) {
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

function assertRegistryResponseUrl(
  response: Response,
  registryOrigin: typeof DEFAULT_REGISTRY_ORIGIN,
  expectedPath: string,
): void {
  if (response.url === '') return;
  const finalUrl = new URL(response.url);
  if (finalUrl.origin !== registryOrigin || finalUrl.pathname !== expectedPath) {
    throw new NpmRegistryError('NPM_REGISTRY_REDIRECT_REJECTED');
  }
}

function assertJsonResponse(response: Response): void {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    throw new NpmRegistryError('NPM_REGISTRY_MEDIA_TYPE_INVALID');
  }
}

function parseJsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  }
}

function boundedEtag(response: Response): string | null {
  return response.headers.get('etag')?.slice(0, 512) ?? null;
}

async function fixedRegistryRequest(
  requestUrl: string,
  options: {
    fetch: Fetch;
    timeoutMs: number;
    userAgent: string;
    etag?: string;
  },
): Promise<Response> {
  try {
    return await options.fetch(requestUrl, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.etag === undefined ? {} : { 'if-none-match': options.etag }),
        'user-agent': options.userAgent,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
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

  const response = await fixedRegistryRequest(requestUrl, {
    fetch: fetchImplementation,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    userAgent: 'migration-api-package-source-resolver/1.0',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new NpmRegistryError('NPM_REGISTRY_REDIRECT_REJECTED');
  }
  if (response.status === 404) throw new NpmRegistryError('NPM_PACKAGE_NOT_FOUND');
  if (!response.ok) throw new NpmRegistryError('NPM_REGISTRY_REQUEST_FAILED');

  assertRegistryResponseUrl(response, registryOrigin, `/${encodedName}/latest`);
  assertJsonResponse(response);

  const body = await readBoundedBody(response);
  const parsed = parseJsonBody(body);
  const result = packageMetadataSchema.safeParse(parsed);
  if (!result.success) throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  if (result.data.name !== packageName) {
    throw new NpmRegistryError('NPM_REGISTRY_PACKAGE_MISMATCH');
  }
  if (valid(result.data.version) === null || prerelease(result.data.version) !== null) {
    throw new NpmRegistryError('NPM_REGISTRY_VERSION_INVALID');
  }

  const registryUrl = npmRegistryPackageUrl(packageName, registryOrigin);
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
    registryEtag: boundedEtag(response),
    registryUrl,
    candidates,
  };
}

export async function pollNpmPackageRelease(
  packageName: string,
  options: {
    fetch?: Fetch;
    registryOrigin?: typeof DEFAULT_REGISTRY_ORIGIN;
    timeoutMs?: number;
    previousEtag?: string | null;
  } = {},
): Promise<NpmPackageReleasePoll> {
  assertPackageName(packageName);
  if (options.previousEtag !== undefined && options.previousEtag !== null) {
    if (options.previousEtag.length < 1 || options.previousEtag.length > 512) {
      throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
    }
  }

  const registryOrigin = options.registryOrigin ?? DEFAULT_REGISTRY_ORIGIN;
  const encodedName = packagePath(packageName);
  const expectedPath = `/${encodedName}`;
  const requestUrl = `${registryOrigin}${expectedPath}`;
  const response = await fixedRegistryRequest(requestUrl, {
    fetch: options.fetch ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    userAgent: 'migration-api-package-release-poller/1.0',
    ...(options.previousEtag === undefined || options.previousEtag === null
      ? {}
      : { etag: options.previousEtag }),
  });

  if (response.status >= 300 && response.status < 400 && response.status !== 304) {
    throw new NpmRegistryError('NPM_REGISTRY_REDIRECT_REJECTED');
  }
  if (response.status === 304) {
    if (options.previousEtag === undefined || options.previousEtag === null) {
      throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
    }
    assertRegistryResponseUrl(response, registryOrigin, expectedPath);
    return {
      status: 'not_modified',
      registryEtag: boundedEtag(response) ?? options.previousEtag,
    };
  }
  if (response.status === 404) throw new NpmRegistryError('NPM_PACKAGE_NOT_FOUND');
  if (!response.ok) throw new NpmRegistryError('NPM_REGISTRY_REQUEST_FAILED');

  assertRegistryResponseUrl(response, registryOrigin, expectedPath);
  assertJsonResponse(response);
  const body = await readBoundedBody(response, MAX_PACKUMENT_RESPONSE_BYTES);
  const result = packageDocumentSchema.safeParse(parseJsonBody(body));
  if (!result.success) throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  if (result.data.name !== packageName) {
    throw new NpmRegistryError('NPM_REGISTRY_PACKAGE_MISMATCH');
  }

  const latestVersion = result.data['dist-tags'].latest;
  if (valid(latestVersion) === null || prerelease(latestVersion) !== null) {
    throw new NpmRegistryError('NPM_REGISTRY_VERSION_INVALID');
  }
  const latestMetadata = packageVersionSchema.safeParse(
    result.data.versions[latestVersion],
  );
  if (!latestMetadata.success) {
    throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
  }

  const rawPublishedAt = result.data.time?.[latestVersion];
  let publishedAt: string | null = null;
  if (rawPublishedAt !== undefined) {
    const parsedPublishedAt = new Date(rawPublishedAt);
    if (Number.isNaN(parsedPublishedAt.getTime())) {
      throw new NpmRegistryError('NPM_REGISTRY_RESPONSE_INVALID');
    }
    publishedAt = parsedPublishedAt.toISOString();
  }

  return {
    status: 'modified',
    packageName,
    latestVersion,
    latestDeprecated: latestMetadata.data.deprecated !== undefined,
    publishedAt,
    registryEtag: boundedEtag(response),
    responseDigest: createHash('sha256').update(body).digest('hex'),
    responseBody: body,
  };
}

export function isRetryableNpmRegistryError(error: unknown): boolean {
  return (
    error instanceof NpmRegistryError &&
    (error.safeCode === 'NPM_REGISTRY_TIMEOUT' ||
      error.safeCode === 'NPM_REGISTRY_REQUEST_FAILED')
  );
}

export function npmRegistrySafeErrorCode(error: unknown): NpmRegistrySafeErrorCode {
  return error instanceof NpmRegistryError
    ? error.safeCode
    : 'NPM_REGISTRY_REQUEST_FAILED';
}
