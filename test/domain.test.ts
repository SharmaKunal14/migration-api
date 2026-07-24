import { describe, expect, it } from 'vitest';

import {
  DomainError,
  requireAction,
  requireIdempotencyKey,
  type Membership,
} from '@migration/domain';

const membership = (role: Membership['role']): Membership => ({
  organisationId: '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624',
  userId: 'e4e2d9db-bd1c-4eef-b685-231128724583',
  role,
});

describe('organisation authorization', () => {
  it.each(['owner', 'admin', 'reviewer'] as const)(
    'allows %s to create a demo run',
    role => {
      expect(requireAction(membership(role), 'demo_run:create').role).toBe(role);
    },
  );

  it('denies viewers from creating a demo run', () => {
    expect(() => requireAction(membership('viewer'), 'demo_run:create')).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        safeCode: 'AUTHORIZATION_DENIED',
        httpStatus: 403,
      }),
    );
  });

  it('denies actors with no current membership', () => {
    expect(() => requireAction(undefined, 'demo_run:read')).toThrow(DomainError);
  });
});

describe('idempotency keys', () => {
  it('accepts a bounded key', () => {
    expect(requireIdempotencyKey('run:01J7Y5ABCD')).toBe('run:01J7Y5ABCD');
  });

  it.each([undefined, '', 'short', 'contains space', 'a'.repeat(129)])(
    'rejects invalid value %s',
    value => {
      expect(() => requireIdempotencyKey(value)).toThrow(
        expect.objectContaining<Partial<DomainError>>({
          safeCode: 'INVALID_IDEMPOTENCY_KEY',
          httpStatus: 400,
        }),
      );
    },
  );
});
