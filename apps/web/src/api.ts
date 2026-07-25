import type {
  PublicAgentRun,
  PublicGithubInstallation,
  PublicGithubInstallLink,
  PublicGithubSetupCompletion,
  PublicOrganisation,
} from '@migration/contracts';

import { browserConfiguration } from './config.js';

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly requestId?: string;
  };
}

export class ApiError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly requestId: string | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${token}`);
  if (init?.body) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(`${browserConfiguration.VITE_API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'omit',
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = body as ApiErrorBody;
    throw new ApiError(
      error.error?.code ?? 'REQUEST_FAILED',
      error.error?.message ?? 'The request could not be completed.',
      error.error?.requestId,
    );
  }
  return body as T;
}

export async function loadMe(
  token: string,
): Promise<{ organisations: PublicOrganisation[] }> {
  return request(token, '/v1/me');
}

export async function createOrganisation(
  token: string,
  input: { readonly name: string; readonly slug: string },
): Promise<{ organisation: PublicOrganisation }> {
  return request(token, '/v1/organisations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function loadGithubInstallations(
  token: string,
  organisationId: string,
): Promise<{ installations: PublicGithubInstallation[] }> {
  return request(token, `/v1/organisations/${organisationId}/github/installations`);
}

export async function createGithubInstallLink(
  token: string,
  organisationId: string,
): Promise<{ installLink: PublicGithubInstallLink }> {
  return request(token, `/v1/organisations/${organisationId}/github/install-link`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function completeGithubSetup(
  token: string,
  input: { readonly installationId: string; readonly state: string },
): Promise<PublicGithubSetupCompletion> {
  return request(token, '/v1/github/setup/callback', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createDemoRun(
  token: string,
  organisationId: string,
  idempotencyKey: string,
): Promise<{ run: PublicAgentRun }> {
  return request(token, `/v1/organisations/${organisationId}/demo-runs`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ scenarioId: 'orbitchat-typescript-v1-v2' }),
  });
}

export async function loadRun(
  token: string,
  organisationId: string,
  runId: string,
): Promise<{ run: PublicAgentRun }> {
  return request(token, `/v1/organisations/${organisationId}/runs/${runId}`);
}
