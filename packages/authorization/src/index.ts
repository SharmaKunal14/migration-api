import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

import type { Actor } from '@migration/domain';
import { DomainError } from '@migration/domain';

const subjectSchema = z.string().min(1).max(255);

export interface JwtConfiguration {
  readonly issuer: string;
  readonly audience: string;
  readonly jwksUrl: string;
}

export interface TokenVerifier {
  verify(token: string): Promise<Actor>;
}

export function createTokenVerifier(
  configuration: JwtConfiguration,
  injectedKeySet?: JWTVerifyGetKey,
): TokenVerifier {
  const jwks =
    injectedKeySet ??
    createRemoteJWKSet(new URL(configuration.jwksUrl), {
      cooldownDuration: 30_000,
      timeoutDuration: 3_000,
    });
  return {
    async verify(token: string): Promise<Actor> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          audience: configuration.audience,
          clockTolerance: 5,
          issuer: configuration.issuer,
          requiredClaims: ['sub', 'iat', 'exp'],
        });
        const subject = subjectSchema.parse(payload.sub);
        return { userId: subject, subject };
      } catch {
        throw new DomainError(
          'AUTHENTICATION_REQUIRED',
          'A valid access token is required.',
          401,
        );
      }
    },
  };
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/u.exec(header ?? '');
  if (!match?.[1]) {
    throw new DomainError(
      'AUTHENTICATION_REQUIRED',
      'A valid access token is required.',
      401,
    );
  }
  return match[1];
}
