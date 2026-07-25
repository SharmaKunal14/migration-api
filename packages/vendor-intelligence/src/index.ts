import { createHash } from 'node:crypto';

import {
  vendorEvidenceBundleSchema,
  type VendorEvidenceBundle,
} from '@migration/contracts';

const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;

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
