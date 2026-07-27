import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate, useParams } from 'react-router';

import type {
  PublicAgentRun,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationApprovalResult,
  PublicOrganisation,
  PublicRepository,
} from '@migration/contracts';

import {
  ApiError,
  approveMigrationCandidate,
  completeGithubSetup,
  createDemoRun,
  createGithubInstallLink,
  createOrganisation,
  loadGithubInstallations,
  loadDependencies,
  loadMe,
  loadMigrationCandidate,
  loadMigrationCandidates,
  loadRepositories,
  loadRun,
  startRepositoryScan,
} from './api.js';
import { useAuth } from './auth.js';
import { supabase } from './supabase.js';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/github/setup/callback" element={<GithubSetupCallbackPage />} />
        <Route
          path="/organisations/:orgId/settings/github"
          element={<GithubSettingsPage />}
        />
        <Route path="/organisations/:orgId/demo" element={<DemoPage />} />
        <Route path="/organisations/:orgId/runs/:runId" element={<RunPage />} />
        <Route
          path="/organisations/:orgId/migrations"
          element={<MigrationInboxPage />}
        />
        <Route
          path="/organisations/:orgId/migrations/:candidateId"
          element={<MigrationCandidatePage />}
        />
      </Route>
      <Route path="*" element={<HomeRedirect />} />
    </Routes>
  );
}

function ProtectedLayout(): React.JSX.Element {
  const { loading, session } = useAuth();
  if (loading) {
    return <FullPageMessage>Checking your session…</FullPageMessage>;
  }
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/onboarding">
          <span className="brand-mark" aria-hidden="true">
            M
          </span>
          Migration API
        </a>
        <button
          className="text-button"
          type="button"
          onClick={() => void supabase.auth.signOut()}
        >
          Sign out
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function HomeRedirect(): React.JSX.Element {
  const { loading, session } = useAuth();
  if (loading) {
    return <FullPageMessage>Loading…</FullPageMessage>;
  }
  return <Navigate to={session ? '/onboarding' : '/login'} replace />;
}

function LoginPage(): React.JSX.Element {
  const { loading, session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  if (!loading && session) {
    return <Navigate to="/onboarding" replace />;
  }
  async function signIn(): Promise<void> {
    setError(null);
    const redirectTo = new URL('/auth/callback', window.location.origin).toString();
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: { redirectTo },
    });
    if (authError) {
      setError('Sign-in could not be started. Try again.');
    }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <p className="eyebrow">Production-shaped migration intelligence</p>
        <h1>Understand the change before touching the code.</h1>
        <p className="lede">
          Review bounded evidence, uncertainty, and verification intent before any
          repository mutation is authorized.
        </p>
        <button className="primary-button" type="button" onClick={() => void signIn()}>
          Continue with GitHub
        </button>
        {error && <p className="error-message">{error}</p>}
        <p className="fine-print">
          Stage 2B reconciles selected repository metadata. Repository contents are not
          accessed until a later, explicit scan.
        </p>
      </section>
      <aside className="login-aside" aria-label="Current product boundaries">
        <span>01</span>
        <p>Authenticated control plane</p>
        <span>02</span>
        <p>Verified GitHub installation</p>
        <span>03</span>
        <p>Explicit repository access</p>
      </aside>
    </main>
  );
}

function AuthCallback(): React.JSX.Element {
  const { loading, session } = useAuth();
  if (loading) {
    return <FullPageMessage>Completing sign-in…</FullPageMessage>;
  }
  return <Navigate to={session ? '/onboarding' : '/login'} replace />;
}

function OnboardingPage(): React.JSX.Element {
  const { session } = useAuth();
  const navigate = useNavigate();
  const [organisations, setOrganisations] = useState<PublicOrganisation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');

  useEffect(() => {
    if (!session) return;
    void loadMe(session.access_token)
      .then(data => setOrganisations(data.organisations))
      .catch((caught: unknown) => setError(errorText(caught)))
      .finally(() => setLoading(false));
  }, [session]);

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!session) return;
    setError(null);
    try {
      const { organisation } = await createOrganisation(session.access_token, {
        name,
        slug,
      });
      await navigate(`/organisations/${organisation.id}/settings/github`);
    } catch (caught) {
      setError(errorText(caught));
    }
  }

  return (
    <div className="page page-narrow">
      <p className="eyebrow">Workspace</p>
      <h1>Choose an organisation</h1>
      <p className="lede">
        Organisation membership is loaded from PostgreSQL on every protected request.
      </p>
      {loading ? (
        <p>Loading organisations…</p>
      ) : (
        <div className="organisation-grid">
          {organisations.map(organisation => (
            <button
              className="organisation-card"
              key={organisation.id}
              type="button"
              onClick={() =>
                navigate(`/organisations/${organisation.id}/settings/github`)
              }
            >
              <span>{organisation.name}</span>
              <small>
                {organisation.slug} · {organisation.role}
              </small>
            </button>
          ))}
        </div>
      )}
      <form className="panel form-panel" onSubmit={event => void submit(event)}>
        <h2>Create an organisation</h2>
        <label>
          Name
          <input
            required
            maxLength={120}
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>
        <label>
          Slug
          <input
            required
            minLength={3}
            maxLength={63}
            pattern="[a-z][a-z0-9-]{2,62}"
            value={slug}
            onChange={event => setSlug(event.target.value)}
          />
        </label>
        <button className="primary-button" type="submit">
          Create workspace
        </button>
      </form>
      {error && <p className="error-message">{error}</p>}
    </div>
  );
}

function GithubSettingsPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId } = useParams();
  const [installations, setInstallations] = useState<PublicGithubInstallation[]>([]);
  const [repositories, setRepositories] = useState<PublicRepository[]>([]);
  const [dependencies, setDependencies] = useState<
    Record<string, PublicDependencyObservation[]>
  >({});
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [scanningRepositoryId, setScanningRepositoryId] = useState<string | null>(null);
  const [scanGeneration, setScanGeneration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId) return;
    let active = true;
    let timer: number | undefined;
    let attempts = 0;
    const refresh = async (): Promise<void> => {
      try {
        const [installationData, repositoryData] = await Promise.all([
          loadGithubInstallations(session.access_token, orgId),
          loadRepositories(session.access_token, orgId),
        ]);
        if (!active) return;
        setInstallations(installationData.installations);
        setRepositories(repositoryData.repositories);
        const completedRepositories = repositoryData.repositories.filter(
          repository => repository.latestScanStatus === 'succeeded',
        );
        const dependencyResults = await Promise.all(
          completedRepositories.map(async repository => ({
            repositoryId: repository.id,
            dependencies: (
              await loadDependencies(session.access_token, orgId, repository.id)
            ).dependencies,
          })),
        );
        setDependencies(
          Object.fromEntries(
            dependencyResults.map(result => [result.repositoryId, result.dependencies]),
          ),
        );
        setError(null);
        setLoading(false);
        attempts += 1;
        const reconciliationPending = installationData.installations.some(
          installation =>
            installation.status === 'active' && installation.lastReconciledAt === null,
        );
        const scanPending = repositoryData.repositories.some(repository =>
          ['queued', 'running'].includes(repository.latestScanStatus ?? ''),
        );
        if ((reconciliationPending || scanPending) && attempts < 60) {
          timer = window.setTimeout(() => void refresh(), 2_000);
        } else if (!scanPending) {
          setScanningRepositoryId(null);
        }
      } catch (caught) {
        if (active) {
          setError(errorText(caught));
          setLoading(false);
        }
      }
    };
    void refresh();
    return (): void => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [orgId, scanGeneration, session]);

  async function startInstallation(): Promise<void> {
    if (!session || !orgId) return;
    setStarting(true);
    setError(null);
    try {
      const { installLink } = await createGithubInstallLink(
        session.access_token,
        orgId,
      );
      const destination = new URL(installLink.installationUrl);
      if (
        destination.origin !== 'https://github.com' ||
        !/^\/apps\/[a-z0-9-]+\/installations\/new$/u.test(destination.pathname)
      ) {
        throw new Error('The installation destination is invalid.');
      }
      window.location.assign(destination);
    } catch (caught) {
      setError(errorText(caught));
      setStarting(false);
    }
  }

  async function startScan(repositoryId: string): Promise<void> {
    if (!session || !orgId) return;
    setScanningRepositoryId(repositoryId);
    setError(null);
    try {
      await startRepositoryScan(
        session.access_token,
        orgId,
        repositoryId,
        crypto.randomUUID(),
      );
      setScanGeneration(value => value + 1);
    } catch (caught) {
      setError(errorText(caught));
      setScanningRepositoryId(null);
    }
  }

  return (
    <div className="page github-settings-page">
      <p className="eyebrow">GitHub connection</p>
      <h1>Connect repository access</h1>
      <p className="lede">
        Install the Migration API GitHub App on an organisation or account. Choose only
        the repositories you want this workspace to see.
      </p>
      <section className="panel">
        <h2>What you are authorising</h2>
        <ul>
          <li>Read repository metadata and selected repository contents.</li>
          <li>
            Grant contents and pull-request write permission for later, explicitly
            approved migrations.
          </li>
          <li>Receive installation and repository-selection webhooks.</li>
          <li>Stage 2C scans an exact commit without executing repository code.</li>
        </ul>
        <button
          className="primary-button"
          type="button"
          disabled={starting}
          onClick={() => void startInstallation()}
        >
          {starting ? 'Opening GitHub…' : 'Install or update GitHub App'}
        </button>
        {error && <p className="error-message">{error}</p>}
      </section>
      <section className="panel settings-section repository-section">
        <div className="section-heading">
          <div>
            <p className="section-kicker">Repository inventory</p>
            <h2>Selected repositories</h2>
          </div>
          {!loading && repositories.length > 0 && (
            <span className="count-badge">
              {repositories.length}{' '}
              {repositories.length === 1 ? 'repository' : 'repositories'}
            </span>
          )}
        </div>
        {loading ? (
          <p>Waiting for repository reconciliation…</p>
        ) : repositories.length === 0 ? (
          <p>
            No selected repositories have been reconciled yet. GitHub webhook processing
            can take a few seconds after installation or a selection change.
          </p>
        ) : (
          <div className="repository-list">
            {repositories.map(repository => (
              <RepositoryInventoryCard
                key={repository.id}
                repository={repository}
                dependencies={dependencies[repository.id] ?? []}
                scanning={scanningRepositoryId === repository.id}
                onScan={startScan}
              />
            ))}
          </div>
        )}
      </section>
      <section className="panel settings-section">
        <h2>Connected installations</h2>
        {loading ? (
          <p>Loading installations…</p>
        ) : installations.length === 0 ? (
          <p>No GitHub installation is connected to this workspace yet.</p>
        ) : (
          <div className="installation-list">
            {installations.map(installation => (
              <article key={installation.id}>
                <div>
                  <strong>{installation.accountLogin}</strong>
                  <p>
                    {installation.accountType} account
                    {installation.lastReconciledAt
                      ? ` · reconciled ${new Date(
                          installation.lastReconciledAt,
                        ).toLocaleString()}`
                      : ' · reconciliation pending'}
                  </p>
                </div>
                <span className={`status status-${installation.status}`}>
                  {installation.status}
                </span>
              </article>
            ))}
          </div>
        )}
      </section>
      {orgId && (
        <nav className="settings-links" aria-label="Workspace tools">
          <a
            className="primary-button link-button"
            href={`/organisations/${orgId}/migrations`}
          >
            Open migration inbox
          </a>
          <a href={`/organisations/${orgId}/demo`}>
            Open the Stage 1 OrbitChat evidence demo
          </a>
        </nav>
      )}
    </div>
  );
}

interface RepositoryInventoryCardProps {
  readonly repository: PublicRepository;
  readonly dependencies: PublicDependencyObservation[];
  readonly scanning: boolean;
  readonly onScan: (repositoryId: string) => Promise<void>;
}

function RepositoryInventoryCard({
  repository,
  dependencies,
  scanning,
  onScan,
}: RepositoryInventoryCardProps): React.JSX.Element {
  const scanInProgress = ['queued', 'running'].includes(
    repository.latestScanStatus ?? '',
  );
  const state = repository.archived
    ? 'archived'
    : repository.selected
      ? 'selected'
      : 'removed';
  return (
    <article className="repository-card">
      <header className="repository-header">
        <div className="repository-identity">
          <strong>{repository.fullName}</strong>
          <div className="repository-metadata">
            <span>{repository.visibility}</span>
            <span>
              Default branch <code>{repository.defaultBranch}</code>
            </span>
            {repository.latestScannedCommit && (
              <span>
                Commit <code>{repository.latestScannedCommit.slice(0, 12)}</code>
              </span>
            )}
          </div>
        </div>
        <div className="repository-actions">
          <span
            className={`status status-${repository.enabled ? 'active' : 'removed'}`}
          >
            {state}
          </span>
          <button
            className="secondary-button"
            type="button"
            disabled={!repository.enabled || scanInProgress || scanning}
            onClick={() => void onScan(repository.id)}
          >
            {scanInProgress || scanning ? 'Scanning…' : 'Scan dependencies'}
          </button>
        </div>
      </header>
      {repository.latestScanStatus && repository.latestScanStatus !== 'succeeded' && (
        <p
          className={`scan-notice scan-notice-${repository.latestScanStatus}`}
          role={repository.latestScanStatus === 'failed' ? 'alert' : undefined}
        >
          Scan {repository.latestScanStatus}
          {repository.latestScanSafeErrorCode
            ? ` · ${repository.latestScanSafeErrorCode}`
            : ''}
        </p>
      )}
      {dependencies.length > 0 && (
        <div className="dependency-inventory">
          <div className="dependency-heading">
            <h3>Dependencies</h3>
            <span>
              {dependencies.length} {dependencies.length === 1 ? 'package' : 'packages'}
            </span>
          </div>
          <div className="dependency-table" role="table" aria-label="Dependencies">
            <div className="dependency-table-header" role="row">
              <span role="columnheader">Package</span>
              <span role="columnheader">Version</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Source</span>
            </div>
            {dependencies.slice(0, 200).map(dependency => (
              <div
                className="dependency-row"
                role="row"
                key={`${dependency.manifestPath}:${dependency.packageName}:${dependency.dependencyKind}`}
              >
                <span className="dependency-package" role="cell" data-label="Package">
                  <code>{dependency.packageName}</code>
                </span>
                <span className="dependency-version" role="cell" data-label="Version">
                  <strong>
                    {dependency.resolvedVersion ?? dependency.declaredRange}
                  </strong>
                  {dependency.resolvedVersion &&
                    dependency.resolvedVersion !== dependency.declaredRange && (
                      <small>Declared {dependency.declaredRange}</small>
                    )}
                </span>
                <span role="cell" data-label="Type">
                  <span className="dependency-kind">{dependency.dependencyKind}</span>
                </span>
                <span className="dependency-source" role="cell" data-label="Source">
                  <code>{dependency.manifestPath}</code>
                  <small>
                    {dependency.lockfilePath
                      ? `Resolved from ${dependency.lockfilePath}`
                      : 'Manifest declaration'}
                  </small>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

function GithubSetupCallbackPage(): React.JSX.Element {
  const { session } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);
  const callback = useMemo(() => readGithubSetupCallback(), []);
  const [error, setError] = useState<string | null>(
    callback ? null : 'GitHub did not return the required installation details.',
  );

  useEffect(() => {
    if (!session || !callback || started.current) return;
    started.current = true;
    void completeGithubSetup(session.access_token, callback)
      .then(result =>
        navigate(`/organisations/${result.organisationId}/settings/github`, {
          replace: true,
        }),
      )
      .catch((caught: unknown) => setError(errorText(caught)));
  }, [callback, navigate, session]);

  if (error) {
    return (
      <div className="page page-narrow">
        <p className="eyebrow">GitHub connection</p>
        <h1>Connection not completed</h1>
        <p className="error-message">{error}</p>
        <a href="/onboarding">Return to your workspaces</a>
      </div>
    );
  }
  return <FullPageMessage>Verifying the GitHub installation…</FullPageMessage>;
}

function readGithubSetupCallback():
  { readonly installationId: string; readonly state: string } | undefined {
  const parameters = new URLSearchParams(window.location.search);
  const installationId = parameters.get('installation_id');
  const state = parameters.get('state');
  return installationId && state ? { installationId, state } : undefined;
}

function MigrationInboxPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId } = useParams();
  const [candidates, setCandidates] = useState<PublicMigrationCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId) return;
    let active = true;
    void loadMigrationCandidates(session.access_token, orgId)
      .then(data => {
        if (active) setCandidates(data.candidates);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorText(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [orgId, session]);

  return (
    <div className="page migration-page">
      <div className="migration-page-heading">
        <div>
          <p className="eyebrow">Migration inbox</p>
          <h1>Changes worth reviewing.</h1>
          <p className="lede">
            Candidates appear only after vendor evidence is reviewed and matched to an
            observed dependency. Nothing here changes repository code.
          </p>
        </div>
        {orgId && (
          <a
            className="secondary-button link-button"
            href={`/organisations/${orgId}/settings/github`}
          >
            Repository settings
          </a>
        )}
      </div>
      {loading ? (
        <section className="panel empty-state">Loading migration candidates…</section>
      ) : error ? (
        <section className="panel empty-state error-message">{error}</section>
      ) : candidates.length === 0 ? (
        <section className="panel empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            ✓
          </span>
          <h2>No open migrations</h2>
          <p>
            No reviewed vendor release currently matches the dependencies in this
            workspace.
          </p>
        </section>
      ) : (
        <div className="candidate-grid">
          {candidates.map(candidate => (
            <MigrationCandidateCard
              candidate={candidate}
              organisationId={orgId ?? ''}
              key={candidate.id}
            />
          ))}
        </div>
      )}
      <p className="fine-print stage-boundary">
        Stage 3 is read-only. Approval, repository edits, test execution, branches, and
        pull requests are not available from this inbox.
      </p>
    </div>
  );
}

function MigrationCandidateCard({
  candidate,
  organisationId,
}: {
  readonly candidate: PublicMigrationCandidate;
  readonly organisationId: string;
}): React.JSX.Element {
  const impact = candidate.impact;
  return (
    <a
      className="candidate-card"
      href={`/organisations/${organisationId}/migrations/${candidate.id}`}
    >
      <div className="candidate-card-topline">
        <span className="package-pill">{candidate.packageName}</span>
        <span className={`risk risk-${impact?.riskCategory ?? 'pending'}`}>
          {impact ? `${impact.riskCategory} risk` : 'analysis pending'}
        </span>
      </div>
      <h2>{candidate.repositoryFullName}</h2>
      <div className="version-route" aria-label="Version migration">
        <div>
          <small>Observed</small>
          <strong>{candidate.resolvedVersion ?? candidate.declaredRange}</strong>
        </div>
        <span aria-hidden="true">→</span>
        <div>
          <small>Target</small>
          <strong>{candidate.targetVersion}</strong>
        </div>
      </div>
      <div className="candidate-metrics">
        <span>
          <small>Evidence</small>
          <strong>{candidate.specificationTrustState.replace('_', ' ')}</strong>
        </span>
        <span>
          <small>Affected areas</small>
          <strong>{impact ? impact.affectedFileCount : '—'}</strong>
        </span>
        <span>
          <small>Uncertainties</small>
          <strong>{impact ? impact.uncertaintyCount : '—'}</strong>
        </span>
      </div>
      <footer>
        <span className={`freshness freshness-${impact?.freshness ?? 'pending'}`}>
          {impact
            ? `${impact.freshness} · ${shortSha(impact.analysedCommit)}`
            : 'Impact report pending'}
        </span>
        <strong>
          Review evidence <span aria-hidden="true">↗</span>
        </strong>
      </footer>
    </a>
  );
}

function MigrationCandidatePage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId, candidateId } = useParams();
  const [detail, setDetail] = useState<PublicMigrationCandidateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId || !candidateId) return;
    let active = true;
    void loadMigrationCandidate(session.access_token, orgId, candidateId)
      .then(data => {
        if (active) setDetail(data.candidate);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorText(caught));
      });
    return (): void => {
      active = false;
    };
  }, [candidateId, orgId, session]);

  if (error) return <FullPageMessage>{error}</FullPageMessage>;
  if (!detail) return <FullPageMessage>Loading migration evidence…</FullPageMessage>;

  const { candidate, impactReport, specification } = detail;
  return (
    <div className="page migration-detail-page">
      <a className="back-link" href={`/organisations/${orgId ?? ''}/migrations`}>
        ← Migration inbox
      </a>
      <header className="candidate-hero">
        <div>
          <p className="eyebrow">Reviewed migration candidate</p>
          <h1>{candidate.repositoryFullName}</h1>
          <p className="lede">
            {candidate.packageName}{' '}
            {candidate.resolvedVersion ?? candidate.declaredRange} can be evaluated for{' '}
            {candidate.targetVersion}.
          </p>
        </div>
        <div className="hero-badges">
          <span className={`status status-${candidate.status}`}>
            {candidate.status}
          </span>
          <span className={`risk risk-${impactReport?.riskCategory ?? 'pending'}`}>
            {impactReport ? `${impactReport.riskCategory} risk` : 'analysis pending'}
          </span>
        </div>
      </header>

      <section className="detail-overview">
        <article className="panel version-panel">
          <p className="section-kicker">Version route</p>
          <div className="version-route version-route-large">
            <div>
              <small>Current</small>
              <strong>{candidate.resolvedVersion ?? candidate.declaredRange}</strong>
              <span>{candidate.declaredRange}</span>
            </div>
            <span aria-hidden="true">→</span>
            <div>
              <small>Target</small>
              <strong>{candidate.targetVersion}</strong>
              <span>Supports {candidate.sourceCompatibility}</span>
            </div>
          </div>
        </article>
        <article className="panel trust-panel">
          <p className="section-kicker">Evidence status</p>
          <h2>{specification.trustState.replace('_', ' ')}</h2>
          <p>
            Operator-reviewed specification revision {specification.revision}.
            {specification.reviewedAt
              ? ` Reviewed ${new Date(specification.reviewedAt).toLocaleString()}.`
              : ''}
          </p>
        </article>
      </section>

      {impactReport ? (
        <>
          <section className="panel detail-section">
            <div className="section-heading">
              <div>
                <p className="section-kicker">Read-only impact analysis</p>
                <h2>{impactHeadline(impactReport.outcome)}</h2>
              </div>
              <span className={`freshness freshness-${impactReport.freshness}`}>
                {impactReport.freshness} report
              </span>
            </div>
            {impactReport.affectedFiles.length === 0 ? (
              <p className="muted-copy">No affected files were identified.</p>
            ) : (
              <div className="file-impact-list">
                {impactReport.affectedFiles.map(file => (
                  <article key={file.path}>
                    <div className="file-impact-heading">
                      <code>{file.path}</code>
                      <span>{file.classification.replace('_', ' ')}</span>
                    </div>
                    {file.symbols.length > 0 && (
                      <div className="symbol-list" aria-label="Affected symbols">
                        {file.symbols.map(symbol => (
                          <code key={symbol}>{symbol}</code>
                        ))}
                      </div>
                    )}
                    <ul>
                      {file.expectedChanges.map(change => (
                        <li key={change}>{change}</li>
                      ))}
                    </ul>
                  </article>
                ))}
              </div>
            )}
          </section>

          <div className="detail-two-column">
            <section className="panel detail-section">
              <p className="section-kicker">Verification availability</p>
              <h2>Checks found in the snapshot</h2>
              <div className="verification-list">
                {impactReport.verification.profiles.map(profile => (
                  <article key={profile.profile}>
                    <span
                      className={`availability availability-${profile.availability}`}
                    >
                      {profile.availability}
                    </span>
                    <div>
                      <strong>{profileLabel(profile.profile)}</strong>
                      <p>{profile.reason}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
            <section className="panel detail-section uncertainty-panel">
              <p className="section-kicker">Uncertainty</p>
              <h2>
                {impactReport.uncertainties.length === 0
                  ? 'No reported ambiguity'
                  : `${String(impactReport.uncertainties.length)} item${
                      impactReport.uncertainties.length === 1 ? '' : 's'
                    } need judgement`}
              </h2>
              {impactReport.uncertainties.map(item => (
                <article key={item.code}>
                  <code>{item.code}</code>
                  <p>{item.summary}</p>
                </article>
              ))}
            </section>
          </div>
        </>
      ) : (
        <section className="panel empty-state">
          <h2>Impact analysis pending</h2>
          <p>
            The candidate is valid, but no structured impact report is available yet.
          </p>
        </section>
      )}

      <section className="panel detail-section">
        <p className="section-kicker">Reviewed change specification</p>
        <h2>What the vendor evidence says changed</h2>
        <div className="specification-change-list">
          {specification.specification.changes.map(change => (
            <article key={change.changeId}>
              <span>{change.changeId}</span>
              <div>
                <h3>{change.summary}</h3>
                <p>
                  {change.category} · {change.certainty.replace('_', ' ')}
                </p>
                {change.transformations.map((transformation, index) => (
                  <div
                    className="transformation"
                    key={`${change.changeId}:${transformation.kind}:${String(index)}`}
                  >
                    <code>{transformation.before}</code>
                    <span aria-hidden="true">→</span>
                    <code>{transformation.after}</code>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <div className="detail-two-column">
        <section className="panel detail-section">
          <p className="section-kicker">Vendor provenance</p>
          <h2>{detail.vendorEvidence.length} immutable sources</h2>
          <div className="evidence-list">
            {detail.vendorEvidence.map(evidence => (
              <article key={`${evidence.sourceKey}:${evidence.digest}`}>
                <div>
                  <strong>{evidence.sourceKey.replaceAll('_', ' ')}</strong>
                  <span>{evidence.sourceKind.replaceAll('_', ' ')}</span>
                </div>
                <a href={evidence.canonicalUrl} rel="noreferrer" target="_blank">
                  View source ↗
                </a>
                <code title={evidence.digest}>{evidence.digest}</code>
              </article>
            ))}
          </div>
        </section>
        <section className="panel detail-section provenance-panel">
          <p className="section-kicker">Exact analysis boundary</p>
          <h2>Reproducible references</h2>
          <DescriptionRow label="Commit" value={detail.repository.commitSha} />
          <DescriptionRow
            label="Snapshot digest"
            value={detail.repository.snapshotDigest}
          />
          <DescriptionRow
            label="Specification digest"
            value={specification.evidenceDigest}
          />
          {impactReport && (
            <DescriptionRow label="Impact digest" value={impactReport.artifactDigest} />
          )}
          <DescriptionRow label="Manifest" value={detail.dependency.manifestPath} />
          {detail.dependency.lockfilePath && (
            <DescriptionRow label="Lockfile" value={detail.dependency.lockfilePath} />
          )}
        </section>
      </div>
      <MigrationApprovalPanel
        detail={detail}
        organisationId={orgId ?? ''}
        token={session?.access_token ?? ''}
      />
      <p className="fine-print stage-boundary">
        Approval creates a durable authorization record and queues one migration run.
        Stage 4B does not yet dispatch the workflow, execute repository code, modify
        files, or create a pull request.
      </p>
    </div>
  );
}

function MigrationApprovalPanel({
  detail,
  organisationId,
  token,
}: {
  readonly detail: PublicMigrationCandidateDetail;
  readonly organisationId: string;
  readonly token: string;
}): React.JSX.Element {
  const [acknowledgements, setAcknowledgements] = useState({
    sourceProcessing: false,
    verificationExecution: false,
    draftPullRequest: false,
    humanReviewRequired: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicMigrationApprovalResult | null>(null);
  const idempotencyKey = useRef(`approval:${crypto.randomUUID()}`);
  const { approval, candidate, impactReport, repository, specification } = detail;
  const acknowledged = Object.values(acknowledgements).every(Boolean);

  function updateAcknowledgement(
    key: keyof typeof acknowledgements,
    checked: boolean,
  ): void {
    setAcknowledgements(current => ({ ...current, [key]: checked }));
  }

  async function submit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!approval.eligible || !impactReport || !acknowledged || !token) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(
        await approveMigrationCandidate(
          token,
          organisationId,
          candidate.id,
          idempotencyKey.current,
          {
            expectedCandidateVersion: candidate.version,
            expectedRepositorySnapshotId: repository.snapshotId,
            expectedBaseCommitSha: repository.commitSha,
            expectedSnapshotDigest: repository.snapshotDigest,
            expectedSpecificationRevision: specification.revision,
            expectedSpecificationDigest: specification.evidenceDigest,
            expectedImpactReportId: impactReport.id,
            expectedImpactReportRevision: impactReport.revision,
            expectedImpactReportDigest: impactReport.artifactDigest,
            renderedCopyDigest: approval.renderedCopyDigest,
            acknowledgements: {
              sourceProcessing: true,
              verificationExecution: true,
              draftPullRequest: true,
              humanReviewRequired: true,
            },
          },
        ),
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setSubmitting(false);
    }
  }

  if (result) {
    return (
      <section className="panel approval-panel approval-complete">
        <p className="section-kicker">Authorization recorded</p>
        <h2>Migration run queued</h2>
        <p>
          Approval <code>{result.approval.id}</code> is immutable. Run{' '}
          <code>{result.run.id}</code> is waiting for the Stage 4 dispatcher.
        </p>
      </section>
    );
  }

  return (
    <section className="panel approval-panel">
      <p className="section-kicker">Mutation authorization boundary</p>
      <h2>Approve this exact snapshot</h2>
      <p className="approval-intro">
        Approval is bound to commit <code>{shortSha(repository.commitSha)}</code>,
        specification revision {specification.revision}, and impact report revision{' '}
        {impactReport?.revision ?? '—'}.
      </p>
      <pre className="approval-copy">{approval.renderedCopy}</pre>
      <div className="approval-limits">
        <span>
          <small>Allowed paths</small>
          <strong>{approval.authority.patchPolicy.allowedPaths.length}</strong>
        </span>
        <span>
          <small>Maximum patch</small>
          <strong>
            {Math.round(approval.authority.patchPolicy.maxPatchBytes / 1024)} KiB
          </strong>
        </span>
        <span>
          <small>Publication</small>
          <strong>Draft PR only</strong>
        </span>
      </div>
      <details className="approval-scope">
        <summary>Review the exact authorized paths and checks</summary>
        <div>
          <h3>Patch paths</h3>
          <ul>
            {approval.authority.patchPolicy.allowedPaths.map(path => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <h3>Verification profiles</h3>
          <ul>
            {approval.authority.verificationProfile.profiles.map(profile => (
              <li key={profile.profile}>
                <strong>{profileLabel(profile.profile)}</strong> —{' '}
                {profile.availability}
                {profile.commandIds.length > 0
                  ? ` (${profile.commandIds.join(', ')})`
                  : ''}
              </li>
            ))}
          </ul>
        </div>
      </details>
      {approval.blockers.length > 0 && (
        <div className="approval-blockers" role="status">
          <strong>Approval unavailable</strong>
          <ul>
            {approval.blockers.map(blocker => (
              <li key={blocker}>{approvalBlockerText(blocker)}</li>
            ))}
          </ul>
        </div>
      )}
      <form onSubmit={event => void submit(event)}>
        <ApprovalCheckbox
          checked={acknowledgements.sourceProcessing}
          label="I authorize processing this exact source snapshot with OpenAI."
          onChange={checked => updateAcknowledgement('sourceProcessing', checked)}
        />
        <ApprovalCheckbox
          checked={acknowledgements.verificationExecution}
          label="I authorize isolated execution of the named verification checks."
          onChange={checked => updateAcknowledgement('verificationExecution', checked)}
        />
        <ApprovalCheckbox
          checked={acknowledgements.draftPullRequest}
          label="I authorize a later stage to create a draft pull request."
          onChange={checked => updateAcknowledgement('draftPullRequest', checked)}
        />
        <ApprovalCheckbox
          checked={acknowledgements.humanReviewRequired}
          label="I understand that a human must review the result and the platform cannot merge it."
          onChange={checked => updateAcknowledgement('humanReviewRequired', checked)}
        />
        {error && <p className="error-message">{error}</p>}
        <button
          className="primary-button"
          disabled={!approval.eligible || !acknowledged || submitting}
          type="submit"
        >
          {submitting ? 'Recording authorization…' : 'Approve and queue migration'}
        </button>
      </form>
    </section>
  );
}

function ApprovalCheckbox({
  checked,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="approval-checkbox">
      <input
        checked={checked}
        type="checkbox"
        onChange={event => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function approvalBlockerText(blocker: string): string {
  const messages: Readonly<Record<string, string>> = {
    APPROVAL_ROLE_REQUIRED: 'Your workspace role cannot approve migrations.',
    CANDIDATE_NOT_OPEN: 'The candidate is no longer open.',
    REPOSITORY_NOT_MUTABLE: 'The repository or GitHub installation is unavailable.',
    CURRENT_IMPACT_REPORT_REQUIRED: 'A current impact report is required.',
    AFFECTED_USAGE_REQUIRED: 'The impact report did not establish affected usage.',
    PATCH_SCOPE_TOO_LARGE: 'The affected path set exceeds the approval limit.',
  };
  return messages[blocker] ?? 'The current evidence cannot be approved.';
}

function DescriptionRow({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="description-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function impactHeadline(outcome: 'affected' | 'not_affected' | 'inconclusive'): string {
  if (outcome === 'affected') return 'Repository usage is affected';
  if (outcome === 'not_affected') return 'No affected usage was found';
  return 'Impact remains inconclusive';
}

function profileLabel(profile: 'typescript_static' | 'typescript_unit'): string {
  return profile === 'typescript_static'
    ? 'TypeScript static checks'
    : 'TypeScript unit tests';
}

function DemoPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId } = useParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());

  async function start(): Promise<void> {
    if (!session || !orgId) return;
    setStarting(true);
    setError(null);
    try {
      const { run } = await createDemoRun(
        session.access_token,
        orgId,
        idempotencyKey.current,
      );
      await navigate(`/organisations/${orgId}/runs/${run.id}`);
    } catch (caught) {
      setError(errorText(caught));
      setStarting(false);
    }
  }

  return (
    <div className="page">
      <p className="eyebrow">Synthetic evidence lab</p>
      <div className="hero-grid">
        <section>
          <h1>OrbitChat 1.x → 2.0.0</h1>
          <p className="lede">
            Ask a real bounded agent to translate seven vendor-confirmed changes and one
            deliberate ambiguity into a structured migration plan.
          </p>
          <button
            className="primary-button"
            type="button"
            disabled={starting}
            onClick={() => void start()}
          >
            {starting ? 'Starting workflow…' : 'Run synthetic analysis'}
          </button>
          {error && <p className="error-message">{error}</p>}
        </section>
        <section className="boundary-card">
          <h2>Authority in this run</h2>
          <ul>
            <li>Read one 256 KiB-limited synthetic artifact</li>
            <li>Call OpenAI Responses through short-lived AWS identity</li>
            <li>Return a strict structured plan</li>
          </ul>
          <h3>Explicitly unavailable</h3>
          <p>Repositories, shell, general internet, database, GitHub, and mutation.</p>
        </section>
      </div>
    </div>
  );
}

function RunPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId, runId } = useParams();
  const [run, setRun] = useState<PublicAgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId || !runId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const data = await loadRun(session.access_token, orgId, runId);
        if (!active) return;
        setRun(data.run);
        setError(null);
        if (data.run.status === 'queued' || data.run.status === 'running') {
          timer = window.setTimeout(() => void poll(), 2_000);
        }
      } catch (caught) {
        if (active) setError(errorText(caught));
      }
    };
    void poll();
    return (): void => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [orgId, runId, session]);

  if (error) {
    return <FullPageMessage>{error}</FullPageMessage>;
  }
  if (!run) {
    return <FullPageMessage>Loading run evidence…</FullPageMessage>;
  }
  const steps = ['Queued', 'Running', run.status === 'failed' ? 'Failed' : 'Completed'];
  const activeStep = run.status === 'queued' ? 0 : run.status === 'running' ? 1 : 2;
  return (
    <div className="page">
      <div className="run-heading">
        <div>
          <p className="eyebrow">Agent run</p>
          <h1>OrbitChat migration plan</h1>
        </div>
        <span className={`status status-${run.status}`}>{run.status}</span>
      </div>
      <ol className="timeline" aria-label="Run timeline">
        {steps.map((step, index) => (
          <li className={index <= activeStep ? 'complete' : ''} key={step}>
            <span>{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      {run.status === 'failed' && (
        <section className="panel">
          <h2>Run stopped safely</h2>
          <p>
            Terminal state: {run.terminalCode}. Reference: {run.safeErrorCode}.
          </p>
        </section>
      )}
      {run.result && (
        <div className="result-grid">
          <section className="panel">
            <p className="eyebrow">Confirmed changes</p>
            <h2>{run.result.changes.length} evidence-bound transformations</h2>
            <div className="change-list">
              {run.result.changes.map(change => (
                <article key={change.changeId}>
                  <span>{change.changeId}</span>
                  <div>
                    <h3>{change.summary}</h3>
                    <p>
                      {change.category} · {change.certainty.replace('_', ' ')}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </section>
          <aside>
            <section className="panel warning-panel">
              <p className="eyebrow">Unresolved</p>
              {run.result.unresolved.map(item => (
                <p key={item}>{item}</p>
              ))}
            </section>
            <section className="panel">
              <p className="eyebrow">Recommended verification</p>
              <ul>
                {run.result.verificationRecommendations.map(profile => (
                  <li key={profile}>{profile}</li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      )}
      <p className="fine-print">
        This is synthetic evidence. No customer repository was accessed, changed, or
        published.
      </p>
    </div>
  );
}

function FullPageMessage({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return <main className="full-page-message">{children}</main>;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    return error.requestId
      ? `${error.message} Request ${error.requestId}.`
      : error.message;
  }
  return 'The request could not be completed.';
}
