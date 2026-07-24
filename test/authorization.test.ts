import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import { bearerToken, createTokenVerifier } from '@migration/authorization';
import type { DomainError } from '@migration/domain';

const issuer = 'https://project.supabase.co/auth/v1';
let privateKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const keys = await generateKeyPair('ES256');
  privateKey = keys.privateKey;
  publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    alg: 'ES256',
    kid: 'test-key',
    use: 'sig',
  };
});

describe('bearer token boundary', () => {
  it('extracts a syntactically valid bearer token', () => {
    expect(bearerToken('Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature')).toBe(
      'eyJhbGciOiJIUzI1NiJ9.payload.signature',
    );
  });

  it.each([undefined, '', 'Basic abc', 'bearer abc.def', 'Bearer token with spaces'])(
    'rejects malformed authorization header %s',
    header => {
      expect(() => bearerToken(header)).toThrow(
        expect.objectContaining<Partial<DomainError>>({
          safeCode: 'AUTHENTICATION_REQUIRED',
          httpStatus: 401,
        }),
      );
    },
  );
});

describe('Supabase JWT verification', () => {
  it('validates signature, issuer, audience, time, and subject', async () => {
    const token = await signedToken({
      issuer,
      audience: 'authenticated',
      subject: 'user-subject',
    });
    const verifier = createTokenVerifier(
      {
        issuer,
        audience: 'authenticated',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
      },
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    await expect(verifier.verify(token)).resolves.toEqual({
      userId: 'user-subject',
      subject: 'user-subject',
    });
  });

  it('rejects a token for another audience without leaking verification details', async () => {
    const token = await signedToken({
      issuer,
      audience: 'attacker',
      subject: 'user-subject',
    });
    const verifier = createTokenVerifier(
      {
        issuer,
        audience: 'authenticated',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
      },
      createLocalJWKSet({ keys: [publicJwk] }),
    );
    await expect(verifier.verify(token)).rejects.toMatchObject({
      safeCode: 'AUTHENTICATION_REQUIRED',
      httpStatus: 401,
    });
  });
});

async function signedToken(input: {
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
}): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'test-key' })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}
