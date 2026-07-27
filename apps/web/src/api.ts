import type {
  CreateMigrationApprovalRequest,
  CancelMigrationRunRequest,
  PublicAgentRun,
  PublicGithubInstallation,
  PublicGithubInstallLink,
  PublicGithubSetupCompletion,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationApprovalResult,
  PublicImpactAnalysisRequest,
  PublicMigrationPatchReview,
  PublicMigrationRunDetail,
  PublicMigrationRunSummary,
  PublicOrganisation,
  PublicDependencyObservation,
  PublicRepository,
  PublicRepositoryScan,
  RevokeMigrationApprovalRequest,
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

export async function loadRepositories(
  token: string,
  organisationId: string,
): Promise<{ repositories: PublicRepository[] }> {
  return request(token, `/v1/organisations/${organisationId}/repositories`);
}

export async function startRepositoryScan(
  token: string,
  organisationId: string,
  repositoryId: string,
  idempotencyKey: string,
): Promise<{ scan: PublicRepositoryScan }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/repositories/${repositoryId}/scans`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({}),
    },
  );
}

export async function loadDependencies(
  token: string,
  organisationId: string,
  repositoryId: string,
): Promise<{ dependencies: PublicDependencyObservation[] }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/repositories/${repositoryId}/dependencies`,
  );
}

export async function loadMigrationCandidates(
  token: string,
  organisationId: string,
): Promise<{ candidates: PublicMigrationCandidate[] }> {
  return request(token, `/v1/organisations/${organisationId}/migration-candidates`);
}

export async function loadMigrationCandidate(
  token: string,
  organisationId: string,
  candidateId: string,
): Promise<{ candidate: PublicMigrationCandidateDetail }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-candidates/${candidateId}`,
  );
}

export async function requestImpactAnalysis(
  token: string,
  organisationId: string,
  candidateId: string,
  idempotencyKey: string,
): Promise<{ analysis: PublicImpactAnalysisRequest }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-candidates/${candidateId}/impact-analysis`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({}),
    },
  );
}

export async function approveMigrationCandidate(
  token: string,
  organisationId: string,
  candidateId: string,
  idempotencyKey: string,
  input: CreateMigrationApprovalRequest,
): Promise<PublicMigrationApprovalResult> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-candidates/${candidateId}/approvals`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export async function loadMigrationRun(
  token: string,
  organisationId: string,
  migrationRunId: string,
): Promise<{ run: PublicMigrationRunDetail }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-runs/${migrationRunId}`,
  );
}

export async function loadMigrationRuns(
  token: string,
  organisationId: string,
): Promise<{ runs: PublicMigrationRunSummary[] }> {
  return request(token, `/v1/organisations/${organisationId}/migration-runs`);
}

export async function loadMigrationPatchReview(
  token: string,
  organisationId: string,
  migrationRunId: string,
): Promise<{ patchReview: PublicMigrationPatchReview | null }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-runs/${migrationRunId}/patch-review`,
  );
}

export async function cancelMigrationRun(
  token: string,
  organisationId: string,
  migrationRunId: string,
  idempotencyKey: string,
  input: CancelMigrationRunRequest,
): Promise<{ run: PublicMigrationRunDetail }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-runs/${migrationRunId}/cancellation`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    },
  );
}

export async function revokeMigrationApproval(
  token: string,
  organisationId: string,
  migrationRunId: string,
  idempotencyKey: string,
  input: RevokeMigrationApprovalRequest,
): Promise<{ run: PublicMigrationRunDetail }> {
  return request(
    token,
    `/v1/organisations/${organisationId}/migration-runs/${migrationRunId}/approval-revocation`,
    {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(input),
    },
  );
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
