import { describe, expect, it, vi } from 'vitest';

import {
  createPinnedHttpsRequester,
  resolvePublicAddresses,
  type HttpsRequestFactory,
} from '@migration/vendor-intelligence';

interface ResponsePlan {
  readonly statusCode?: number;
  readonly headers?: Readonly<Record<string, string | string[]>>;
  readonly chunks?: readonly Buffer[];
  readonly responseError?: Error;
  readonly requestError?: Error;
  readonly timeOut?: boolean;
}

function requestFactory(plan: ResponsePlan): HttpsRequestFactory {
  return (_url, _options, responseListener) => {
    let requestErrorListener: ((error: Error) => void) | undefined;
    let timeoutListener: (() => void) | undefined;
    const request = {
      setTimeout: vi.fn((_milliseconds: number, listener: () => void) => {
        timeoutListener = listener;
        return request;
      }),
      once: vi.fn((_event: 'error', listener: (error: Error) => void) => {
        requestErrorListener = listener;
        return request;
      }),
      destroy: vi.fn((error?: Error) => {
        if (error) requestErrorListener?.(error);
      }),
      end: vi.fn(() => {
        if (plan.timeOut) {
          timeoutListener?.();
          return;
        }
        if (plan.requestError) {
          requestErrorListener?.(plan.requestError);
          return;
        }
        let dataListener: ((chunk: Buffer) => void) | undefined;
        let responseErrorListener: ((error: Error) => void) | undefined;
        let endListener: (() => void) | undefined;
        const response = {
          statusCode: plan.statusCode,
          headers: plan.headers ?? {},
          on: vi.fn((_event: 'data', listener: (chunk: Buffer) => void) => {
            dataListener = listener;
            return response;
          }),
          once: vi.fn(
            (
              event: 'error' | 'end',
              listener: ((error: Error) => void) | (() => void),
            ) => {
              if (event === 'error') {
                responseErrorListener = listener;
              } else {
                endListener = listener as () => void;
              }
              return response;
            },
          ),
          destroy: vi.fn((error?: Error) => {
            if (error) responseErrorListener?.(error);
          }),
        };
        responseListener(response);
        if (plan.responseError) {
          responseErrorListener?.(plan.responseError);
          return;
        }
        for (const chunk of plan.chunks ?? []) dataListener?.(chunk);
        endListener?.();
      }),
    };
    return request;
  };
}

describe('vendor HTTPS transport adapter', () => {
  it('returns bounded response metadata and content', async () => {
    const request = createPinnedHttpsRequester(
      requestFactory({
        statusCode: 200,
        headers: {
          'content-type': 'text/plain',
          etag: ['first', 'ignored'],
        },
        chunks: [Buffer.from('trusted'), Buffer.from(' evidence')],
      }),
    );

    await expect(
      request(new URL('https://example.com/evidence'), '8.8.8.8', 1024),
    ).resolves.toMatchObject({
      status: 200,
      mediaType: 'text/plain',
      etag: 'first',
      bytes: Buffer.from('trusted evidence'),
    });
  });

  it('rejects an oversized declared response before reading it', async () => {
    const request = createPinnedHttpsRequester(
      requestFactory({
        statusCode: 200,
        headers: { 'content-length': '1025' },
      }),
    );

    await expect(
      request(new URL('https://example.com/evidence'), '8.8.8.8', 1024),
    ).rejects.toMatchObject({ safeCode: 'VENDOR_SOURCE_SIZE_REJECTED' });
  });

  it('rejects a streamed response that crosses the byte limit', async () => {
    const request = createPinnedHttpsRequester(
      requestFactory({
        statusCode: 200,
        chunks: [Buffer.alloc(700), Buffer.alloc(700)],
      }),
    );

    await expect(
      request(new URL('https://example.com/evidence'), '8.8.8.8', 1024),
    ).rejects.toMatchObject({ safeCode: 'VENDOR_SOURCE_SIZE_REJECTED' });
  });

  it('turns a socket timeout into a safe error', async () => {
    const request = createPinnedHttpsRequester(requestFactory({ timeOut: true }));

    await expect(
      request(new URL('https://example.com/evidence'), '8.8.8.8', 1024),
    ).rejects.toMatchObject({ safeCode: 'VENDOR_SOURCE_TIMEOUT' });
  });

  it('propagates transport errors for safe classification by the worker', async () => {
    const request = createPinnedHttpsRequester(
      requestFactory({ requestError: new Error('connection failed') }),
    );

    await expect(
      request(new URL('https://example.com/evidence'), '8.8.8.8', 1024),
    ).rejects.toThrow('connection failed');
  });
});

describe('vendor DNS adapter', () => {
  it('combines successful address families and tolerates one unavailable family', async () => {
    await expect(
      resolvePublicAddresses('example.com', {
        ipv4: vi.fn().mockResolvedValue(['93.184.216.34']),
        ipv6: vi.fn().mockRejectedValue(new Error('unavailable')),
      }),
    ).resolves.toEqual(['93.184.216.34']);
  });
});
