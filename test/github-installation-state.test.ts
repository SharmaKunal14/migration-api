import { describe, expect, it } from 'vitest';

import type { DomainError } from '@migration/domain';

import {
  requireInstallationOrganisation,
  validateInstallationLinkState,
  type InstallationLinkStateRecord,
} from '../services/api/src/repository.js';

const organisationId = '6b768f2a-7bd0-47b7-8acb-f8c7ebfd8624';
const userId = '12a906c7-f7df-4c65-9137-70bcf17eec86';
const now = new Date('2026-07-24T00:00:00.000Z');

function state(
  override: Partial<InstallationLinkStateRecord> = {},
): InstallationLinkStateRecord {
  return {
    organisationId,
    userId,
    expiresAt: new Date('2026-07-24T00:10:00.000Z'),
    consumedAt: null,
    ...override,
  };
}

describe('GitHub installation state policy', () => {
  it('accepts an unconsumed state belonging to the callback user', () => {
    expect(validateInstallationLinkState(state(), userId, now)).toMatchObject({
      organisationId,
      userId,
    });
  });

  it.each([
    ['missing', undefined],
    ['another user', state({ userId: '2d677157-e8d6-4e35-b3fb-3ca67300762b' })],
    ['already consumed', state({ consumedAt: now })],
    ['expired', state({ expiresAt: now })],
  ])('rejects a %s state without revealing which check failed', (_name, record) => {
    expect(() => validateInstallationLinkState(record, userId, now)).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        safeCode: 'GITHUB_INSTALLATION_STATE_INVALID',
        httpStatus: 409,
      }),
    );
  });

  it('rejects linking one GitHub installation to a second organisation', () => {
    expect(() =>
      requireInstallationOrganisation(
        '2d677157-e8d6-4e35-b3fb-3ca67300762b',
        organisationId,
      ),
    ).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        safeCode: 'GITHUB_INSTALLATION_ALREADY_LINKED',
        httpStatus: 409,
      }),
    );
  });
});
