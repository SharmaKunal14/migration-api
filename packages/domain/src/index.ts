export const organisationRoles = ['owner', 'admin', 'reviewer', 'viewer'] as const;
export type OrganisationRole = (typeof organisationRoles)[number];

export const runStatuses = ['queued', 'running', 'succeeded', 'failed'] as const;
export type RunStatus = (typeof runStatuses)[number];

export const terminalCodes = [
  'completed',
  'cancelled',
  'budget_exhausted_model_calls',
  'budget_exhausted_tool_calls',
  'budget_exhausted_iterations',
  'budget_exhausted_time',
  'invalid_model_output',
  'policy_rejected',
  'upstream_transient',
  'upstream_permanent',
  'infrastructure_failed',
] as const;
export type TerminalCode = (typeof terminalCodes)[number];

export class DomainError extends Error {
  public constructor(
    public readonly safeCode: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export interface Actor {
  readonly userId: string;
  readonly subject: string;
}

export interface Membership {
  readonly organisationId: string;
  readonly userId: string;
  readonly role: OrganisationRole;
}

export interface RepositoryScanEligibility {
  readonly selected: boolean;
  readonly enabled: boolean;
  readonly archived: boolean;
  readonly installationStatus: 'active' | 'suspended' | 'removed';
}

export type OrganisationAction =
  | 'organisation:read'
  | 'organisation:create'
  | 'demo_run:create'
  | 'demo_run:read'
  | 'github_installation:manage'
  | 'repository:read'
  | 'repository:scan'
  | 'migration:approve'
  | 'migration:read'
  | 'migration:cancel';

const allowedActions: Readonly<
  Record<OrganisationRole, readonly OrganisationAction[]>
> = {
  owner: [
    'organisation:read',
    'organisation:create',
    'demo_run:create',
    'demo_run:read',
    'github_installation:manage',
    'repository:read',
    'repository:scan',
    'migration:approve',
    'migration:read',
    'migration:cancel',
  ],
  admin: [
    'organisation:read',
    'demo_run:create',
    'demo_run:read',
    'github_installation:manage',
    'repository:read',
    'repository:scan',
    'migration:approve',
    'migration:read',
    'migration:cancel',
  ],
  reviewer: [
    'organisation:read',
    'demo_run:create',
    'demo_run:read',
    'repository:read',
    'repository:scan',
    'migration:approve',
    'migration:read',
    'migration:cancel',
  ],
  viewer: ['organisation:read', 'demo_run:read', 'repository:read', 'migration:read'],
};

export function requireAction(
  membership: Membership | undefined,
  action: OrganisationAction,
): Membership {
  if (!membership || !allowedActions[membership.role].includes(action)) {
    throw new DomainError(
      'AUTHORIZATION_DENIED',
      'The actor is not authorized for this action.',
      403,
    );
  }
  return membership;
}

export function isRepositoryScannable(repository: RepositoryScanEligibility): boolean {
  return (
    repository.selected &&
    repository.enabled &&
    !repository.archived &&
    repository.installationStatus === 'active'
  );
}

export function requireIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9:_-]{7,127}$/u.test(value)) {
    throw new DomainError(
      'INVALID_IDEMPOTENCY_KEY',
      'A valid Idempotency-Key header is required.',
      400,
    );
  }
  return value;
}
