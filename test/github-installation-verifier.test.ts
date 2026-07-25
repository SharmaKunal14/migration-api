import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { DomainError } from '@migration/domain';

import { createGithubInstallationVerifier } from '../services/api/src/handler.js';

function payload(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value));
}

describe('GitHub installation broker boundary', () => {
  it('invokes only the configured broker operation and validates its response', async () => {
    const send = vi.fn<(command: InvokeCommand) => Promise<{ Payload: Uint8Array }>>(
      () =>
        Promise.resolve({
          Payload: payload({
            installationId: '123456789',
            accountId: '104818699',
            accountLogin: 'SharmaKunal14',
            accountType: 'User',
            status: 'active',
          }),
        }),
    );
    const verifier = createGithubInstallationVerifier(
      { send },
      'migration-api-development-github-token-broker',
    );

    await expect(verifier.verify('123456789')).resolves.toMatchObject({
      accountId: '104818699',
      status: 'active',
    });
    const command = send.mock.calls[0]?.[0];
    expect(command?.input.FunctionName).toBe(
      'migration-api-development-github-token-broker',
    );
    const commandPayload = command?.input.Payload;
    if (!(commandPayload instanceof Uint8Array)) {
      throw new Error('Expected an in-memory invocation payload.');
    }
    expect(Buffer.from(commandPayload).toString('utf8')).toBe(
      JSON.stringify({
        operation: 'verify_installation',
        installationId: '123456789',
      }),
    );
  });

  it.each([
    ['broker execution failure', { FunctionError: 'Unhandled' }],
    ['missing payload', {}],
    ['invalid payload', { Payload: payload({ token: 'must-not-be-accepted' }) }],
  ])('fails closed on %s', async (_name, response) => {
    const verifier = createGithubInstallationVerifier(
      {
        send: () => Promise.resolve(response),
      },
      'migration-api-development-github-token-broker',
    );

    await expect(verifier.verify('123456789')).rejects.toEqual(
      expect.objectContaining<Partial<DomainError>>({
        safeCode: 'GITHUB_INSTALLATION_VERIFICATION_FAILED',
        httpStatus: 502,
      }),
    );
  });

  it('redacts an invocation exception behind a stable error', async () => {
    const verifier = createGithubInstallationVerifier(
      {
        send: () => Promise.reject(new Error('sensitive provider detail')),
      },
      'migration-api-development-github-token-broker',
    );

    await expect(verifier.verify('123456789')).rejects.toMatchObject({
      safeCode: 'GITHUB_INSTALLATION_VERIFICATION_FAILED',
      message: 'The GitHub installation could not be verified.',
    });
  });
});
