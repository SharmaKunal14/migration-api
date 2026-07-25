import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { Navigate, Outlet, Route, Routes, useNavigate, useParams } from 'react-router';

import type {
  PublicAgentRun,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicOrganisation,
  PublicRepository,
} from '@migration/contracts';

import {
  ApiError,
  completeGithubSetup,
  createDemoRun,
  createGithubInstallLink,
  createOrganisation,
  loadGithubInstallations,
  loadDependencies,
  loadMe,
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
    <div className="page page-narrow">
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
      <section className="panel settings-section">
        <h2>Selected repositories</h2>
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
              <article key={repository.id}>
                <div>
                  <strong>{repository.fullName}</strong>
                  <p>
                    {repository.visibility} · default branch {repository.defaultBranch}
                  </p>
                  {repository.latestScannedCommit && (
                    <p>
                      Inventoried commit{' '}
                      <code>{repository.latestScannedCommit.slice(0, 12)}</code>
                    </p>
                  )}
                  {repository.latestScanStatus &&
                    repository.latestScanStatus !== 'succeeded' && (
                      <p>
                        Scan status: {repository.latestScanStatus}
                        {repository.latestScanSafeErrorCode
                          ? ` · ${repository.latestScanSafeErrorCode}`
                          : ''}
                      </p>
                    )}
                  {(dependencies[repository.id] ?? []).length > 0 && (
                    <ul className="dependency-list">
                      {(dependencies[repository.id] ?? [])
                        .slice(0, 200)
                        .map(dependency => (
                          <li
                            key={`${dependency.manifestPath}:${dependency.packageName}:${dependency.dependencyKind}`}
                          >
                            <code>{dependency.packageName}</code>{' '}
                            {dependency.resolvedVersion ?? dependency.declaredRange}{' '}
                            <small>({dependency.dependencyKind})</small>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
                <div className="repository-actions">
                  <span
                    className={`status status-${
                      repository.enabled ? 'active' : 'removed'
                    }`}
                  >
                    {repository.archived
                      ? 'archived'
                      : repository.selected
                        ? 'selected'
                        : 'removed'}
                  </span>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={
                      !repository.enabled ||
                      ['queued', 'running'].includes(
                        repository.latestScanStatus ?? '',
                      ) ||
                      scanningRepositoryId === repository.id
                    }
                    onClick={() => void startScan(repository.id)}
                  >
                    {['queued', 'running'].includes(
                      repository.latestScanStatus ?? '',
                    ) || scanningRepositoryId === repository.id
                      ? 'Scanning…'
                      : 'Scan dependencies'}
                  </button>
                </div>
              </article>
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
        <p className="fine-print">
          <a href={`/organisations/${orgId}/demo`}>
            Open the Stage 1 OrbitChat evidence demo
          </a>
        </p>
      )}
    </div>
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
