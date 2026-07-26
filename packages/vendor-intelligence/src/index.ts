import { createHash } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import type { IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { BlockList, isIP } from 'node:net';

import {
  vendorEvidenceBundleSchema,
  type VendorEvidenceBundle,
} from '@migration/contracts';

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

const blockedIpv4Addresses = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
] as const) {
  blockedIpv4Addresses.addSubnet(address, prefix, 'ipv4');
}

const blockedIpv6Addresses = new BlockList();
for (const [address, prefix] of [
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['64:ff9b:1::', 48, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:20::', 28, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['2002::', 16, 'ipv6'],
  ['3fff::', 20, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
] as const) {
  blockedIpv6Addresses.addSubnet(address, prefix, 'ipv6');
}

export class VendorEvidenceError extends Error {
  public constructor(public readonly safeCode: string) {
    super('The vendor evidence bundle is invalid.');
    this.name = 'VendorEvidenceError';
  }
}

export function normalizeTrustedVendorUrl(
  rawUrl: string,
  allowedDomains: ReadonlySet<string>,
): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new VendorEvidenceError('VENDOR_SOURCE_URL_INVALID');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.hash !== '' ||
    url.search !== '' ||
    !allowedDomains.has(hostname)
  ) {
    throw new VendorEvidenceError('VENDOR_SOURCE_URL_REJECTED');
  }
  url.hostname = hostname;
  return url.toString();
}

export interface VendorSourceRequest {
  readonly sourceKey: string;
  readonly canonicalUrl: string;
  readonly expectedMediaTypes: readonly string[];
  readonly allowedDomains: ReadonlySet<string>;
}

export interface RetrievedVendorSource {
  readonly canonicalUrl: string;
  readonly finalUrl: string;
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly mediaType: string;
  readonly etag: string | null;
}

interface VendorHttpResponse {
  readonly status: number;
  readonly location: string | null;
  readonly mediaType: string | null;
  readonly etag: string | null;
  readonly bytes: Uint8Array;
}

interface HttpsResponse {
  readonly statusCode?: number;
  readonly headers: IncomingHttpHeaders;
  on(event: 'data', listener: (chunk: Buffer) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'end', listener: () => void): this;
  destroy(error?: Error): void;
}

interface HttpsClientRequest {
  setTimeout(milliseconds: number, listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  destroy(error?: Error): void;
  end(): void;
}

export type HttpsRequestFactory = (
  url: URL,
  options: RequestOptions,
  responseListener: (response: HttpsResponse) => void,
) => HttpsClientRequest;

export interface VendorRetrievalDependencies {
  readonly resolve: (hostname: string) => Promise<readonly string[]>;
  readonly request: (
    url: URL,
    address: string,
    maximumBytes: number,
  ) => Promise<VendorHttpResponse>;
}

export async function retrieveVendorSource(
  source: VendorSourceRequest,
  dependencies: VendorRetrievalDependencies = {
    resolve: resolvePublicAddresses,
    request: productionHttpsRequest,
  },
): Promise<RetrievedVendorSource> {
  const canonicalUrl = normalizeTrustedVendorUrl(
    source.canonicalUrl,
    source.allowedDomains,
  );
  let current = new URL(canonicalUrl);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const addresses = await dependencies.resolve(current.hostname);
    if (
      addresses.length === 0 ||
      addresses.some(address => !isPublicIpAddress(address))
    ) {
      throw new VendorEvidenceError('VENDOR_SOURCE_ADDRESS_REJECTED');
    }
    const address = [...addresses].sort((left, right) => {
      const family = isIP(left) - isIP(right);
      return family === 0 ? left.localeCompare(right) : family;
    })[0];
    if (!address) {
      throw new VendorEvidenceError('VENDOR_SOURCE_DNS_FAILED');
    }
    const response = await dependencies.request(current, address, MAX_SOURCE_BYTES);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === MAX_REDIRECTS || !response.location) {
        throw new VendorEvidenceError('VENDOR_SOURCE_REDIRECT_REJECTED');
      }
      let redirected: URL;
      try {
        redirected = new URL(response.location, current);
      } catch {
        throw new VendorEvidenceError('VENDOR_SOURCE_REDIRECT_REJECTED');
      }
      current = new URL(
        normalizeTrustedVendorUrl(redirected.toString(), source.allowedDomains),
      );
      continue;
    }
    if (response.status !== 200) {
      throw new VendorEvidenceError('VENDOR_SOURCE_REQUEST_REJECTED');
    }
    if (response.bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new VendorEvidenceError('VENDOR_SOURCE_SIZE_REJECTED');
    }
    const mediaType = response.mediaType?.split(';', 1)[0]?.trim().toLowerCase();
    if (!mediaType || !source.expectedMediaTypes.includes(mediaType)) {
      throw new VendorEvidenceError('VENDOR_SOURCE_MEDIA_TYPE_REJECTED');
    }
    if (response.bytes.byteLength === 0) {
      throw new VendorEvidenceError('VENDOR_SOURCE_EMPTY');
    }
    return {
      canonicalUrl,
      finalUrl: current.toString(),
      bytes: response.bytes,
      digest: createHash('sha256').update(response.bytes).digest('hex'),
      mediaType,
      etag: response.etag,
    };
  }
  throw new VendorEvidenceError('VENDOR_SOURCE_REDIRECT_REJECTED');
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return !blockedIpv4Addresses.check(address, 'ipv4');
  }
  if (family === 6) {
    return !blockedIpv6Addresses.check(address, 'ipv6');
  }
  return false;
}

export async function resolvePublicAddresses(
  hostname: string,
  resolvers: {
    readonly ipv4: typeof resolve4;
    readonly ipv6: typeof resolve6;
  } = { ipv4: resolve4, ipv6: resolve6 },
): Promise<readonly string[]> {
  const [ipv4, ipv6] = await Promise.all([
    resolvers.ipv4(hostname).catch(() => []),
    resolvers.ipv6(hostname).catch(() => []),
  ]);
  return [...ipv4, ...ipv6];
}

export function createPinnedHttpsRequester(
  requestFactory: HttpsRequestFactory,
): VendorRetrievalDependencies['request'] {
  return (url, address, maximumBytes) =>
    requestPinnedHttps(requestFactory, url, address, maximumBytes);
}

const productionHttpsRequest = createPinnedHttpsRequester(
  (url, options, responseListener) => httpsRequest(url, options, responseListener),
);

function requestPinnedHttps(
  requestFactory: HttpsRequestFactory,
  url: URL,
  address: string,
  maximumBytes: number,
): Promise<VendorHttpResponse> {
  return new Promise((resolve, reject) => {
    const family = isIP(address);
    const request = requestFactory(
      url,
      {
        method: 'GET',
        agent: false,
        family,
        headers: {
          accept: '*/*',
          'user-agent': 'migration-api-vendor-fetcher',
        },
        lookup: (_hostname, _options, callback) => callback(null, address, family),
        servername: url.hostname,
      },
      response => {
        const declaredLength = Number(response.headers['content-length']);
        if (
          Number.isFinite(declaredLength) &&
          (declaredLength < 1 || declaredLength > maximumBytes)
        ) {
          response.destroy();
          reject(new VendorEvidenceError('VENDOR_SOURCE_SIZE_REJECTED'));
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        response.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > maximumBytes) {
            response.destroy(new VendorEvidenceError('VENDOR_SOURCE_SIZE_REJECTED'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', error => reject(classifyTransportError(error)));
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            location: headerValue(response.headers.location),
            mediaType: headerValue(response.headers['content-type']),
            etag: headerValue(response.headers.etag),
            bytes: Buffer.concat(chunks, total),
          });
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new VendorEvidenceError('VENDOR_SOURCE_TIMEOUT'));
    });
    request.once('error', error => reject(classifyTransportError(error)));
    request.end();
  });
}

function classifyTransportError(error: Error): VendorEvidenceError {
  if (error instanceof VendorEvidenceError) return error;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : '';
  if (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  ) {
    return new VendorEvidenceError('VENDOR_SOURCE_TLS_FAILED');
  }
  return new VendorEvidenceError('VENDOR_SOURCE_TRANSPORT_FAILED');
}

function headerValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

export function verifyVendorEvidenceBundle(
  rawBundle: unknown,
  contents: ReadonlyMap<string, Uint8Array>,
): VendorEvidenceBundle {
  const parsed = vendorEvidenceBundleSchema.safeParse(rawBundle);
  if (!parsed.success) {
    throw new VendorEvidenceError('VENDOR_EVIDENCE_MANIFEST_INVALID');
  }
  const bundle = parsed.data;
  const expectedPaths = new Set(bundle.sources.map(source => source.contentPath));
  if (
    contents.size !== expectedPaths.size ||
    [...contents.keys()].some(path => !expectedPaths.has(path))
  ) {
    throw new VendorEvidenceError('VENDOR_EVIDENCE_FILE_SET_INVALID');
  }
  let totalBytes = 0;
  for (const source of bundle.sources) {
    const bytes = contents.get(source.contentPath);
    if (bytes?.byteLength !== source.bytes) {
      throw new VendorEvidenceError('VENDOR_EVIDENCE_SIZE_MISMATCH');
    }
    totalBytes += bytes.byteLength;
    if (createHash('sha256').update(bytes).digest('hex') !== source.digest) {
      throw new VendorEvidenceError('VENDOR_EVIDENCE_DIGEST_MISMATCH');
    }
  }
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new VendorEvidenceError('VENDOR_EVIDENCE_BUNDLE_TOO_LARGE');
  }
  return bundle;
}
