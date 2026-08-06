import { useEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router';

import type {
  PublicAgentRun,
  PublicCandidateNotification,
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationApprovalResult,
  PublicMigrationPatchReview,
  PublicMigrationRunDetail,
  PublicMigrationRunSummary,
  PublicMigrationSpecification,
  PublicMigrationSpecificationDetail,
  PublicPackageSourceCandidate,
  PublicPackageSourceMapping,
  PublicOrganisation,
  PublicPublicationNotification,
  PublicRepository,
} from '@migration/contracts';

import {
  ApiError,
  addPackageSourceCandidate,
  approveMigrationCandidate,
  cancelMigrationRun,
  completeGithubSetup,
  createDemoRun,
  createGithubInstallLink,
  createOrganisation,
  loadGithubInstallations,
  loadDependencies,
  loadMe,
  loadMigrationCandidate,
  loadMigrationCandidates,
  loadCandidateNotifications,
  loadMigrationRun,
  loadMigrationPatchReview,
  loadMigrationRuns,
  loadMigrationSpecification,
  loadMigrationSpecifications,
  loadPackageSourceMappings,
  loadPublicationNotifications,
  loadRepositories,
  loadRun,
  requestImpactAnalysis,
  requestPackageReleasePilotBackfill,
  requestPackageEvidenceRefresh,
  reviewPackageSourceCandidate,
  reviewMigrationSpecification,
  revokeMigrationApproval,
  startRepositoryScan,
  setPackageSourceMappingState,
  updateCandidateNotificationState,
} from './api.js';
import { useAuth } from './auth.js';
import {
  packageEvidenceRecommendations,
  packageSourceCandidatesForReview,
} from './package-evidence-recommendations.js';
import { supabase } from './supabase.js';

export function App(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallback />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/operator/package-sources" element={<PackageSourceReviewPage />} />
        <Route
          path="/operator/migration-specifications"
          element={<MigrationSpecificationReviewPage />}
        />
        <Route path="/github/setup/callback" element={<GithubSetupCallbackPage />} />
        <Route
          path="/organisations/:orgId/settings/github"
          element={<GithubSettingsPage />}
        />
        <Route path="/organisations/:orgId/demo" element={<DemoPage />} />
        <Route path="/organisations/:orgId/runs/:runId" element={<RunPage />} />
        <Route
          path="/organisations/:orgId/migration-runs/:runId"
          element={<MigrationRunPage />}
        />
        <Route
          path="/organisations/:orgId/migration-runs"
          element={<MigrationRunHistoryPage />}
        />
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
        <ProductBrand href="/onboarding" />
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

interface ProductBrandProps {
  readonly href?: string;
  readonly showTagline?: boolean;
}

function ProductBrand({
  href,
  showTagline = false,
}: ProductBrandProps): React.JSX.Element {
  const lockup = (
    <>
      <span className="brand-mark" aria-hidden="true">
        <span>U</span>
        <span className="brand-arrow">↗</span>
      </span>
      <span className="brand-copy">
        <span className="brand-name">Upversion</span>
        {showTagline && <span className="brand-tagline">Migration intelligence</span>}
      </span>
    </>
  );

  return href ? (
    <a className="brand" href={href} aria-label="Upversion home">
      {lockup}
    </a>
  ) : (
    <div className="brand">{lockup}</div>
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
        <div className="login-brand">
          <ProductBrand showTagline />
        </div>
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
  const [operatorAccess, setOperatorAccess] = useState(false);

  useEffect(() => {
    if (!session) return;
    void loadMe(session.access_token)
      .then(data => {
        setOrganisations(data.organisations);
        setOperatorAccess(data.operator.hasAccess);
      })
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
      {operatorAccess && (
        <nav className="operator-actions" aria-label="Platform operator tools">
          <Link className="operator-link" to="/operator/package-sources">
            Review package sources
          </Link>
          <Link className="operator-link" to="/operator/migration-specifications">
            Review migration guidance
          </Link>
        </nav>
      )}
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

type SpecificationQueueState = 'draft' | 'reviewed' | 'vendor_verified';

function MigrationSpecificationReviewPage(): React.JSX.Element {
  const { session } = useAuth();
  const [trustState, setTrustState] = useState<SpecificationQueueState>('draft');
  const [specifications, setSpecifications] = useState<PublicMigrationSpecification[]>(
    [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PublicMigrationSpecificationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void loadMigrationSpecifications(session.access_token, trustState)
      .then(result => {
        if (!active) return;
        setSpecifications(result.specifications);
        const nextSelectedId = result.specifications[0]?.id ?? null;
        setDetail(null);
        setDetailLoading(nextSelectedId !== null);
        setSelectedId(nextSelectedId);
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
  }, [generation, session, trustState]);

  useEffect(() => {
    if (!session || !selectedId) return;
    let active = true;
    void loadMigrationSpecification(session.access_token, selectedId)
      .then(result => {
        if (active) setDetail(result.specification);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorText(caught));
      })
      .finally(() => {
        if (active) setDetailLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [selectedId, session]);

  const ambiguousChanges =
    detail?.specification.changes.filter(change => change.certainty === 'ambiguous') ??
    [];

  async function review(): Promise<void> {
    if (!session || !detail || ambiguousChanges.length > 0) return;
    setReviewing(true);
    setError(null);
    try {
      await reviewMigrationSpecification(
        session.access_token,
        detail.id,
        crypto.randomUUID(),
        detail.revision,
      );
      setDetail(null);
      setSelectedId(null);
      setLoading(true);
      setGeneration(value => value + 1);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setReviewing(false);
    }
  }

  return (
    <div className="page specification-review-page">
      <Link to="/onboarding">← Workspaces</Link>
      <p className="eyebrow">Platform operator</p>
      <h1>Migration guidance</h1>
      <p className="lede">
        Review evidence-backed guidance before it can be matched to customer
        repositories. Drafts with ambiguous changes stay blocked.
      </p>
      <aside className="spec-review-explainer">
        <strong>Package-level guidance, not a repository impact report.</strong>
        <span>
          Reviewed guidance can be matched to repositories using this package. It cannot
          edit code, approve a migration, or publish a pull request.
        </span>
      </aside>
      <div className="queue-filters" aria-label="Migration guidance filters">
        {(
          [
            ['draft', 'To review'],
            ['reviewed', 'Reviewed'],
            ['vendor_verified', 'Vendor verified'],
          ] as const
        ).map(([value, label]) => (
          <button
            className="queue-filter"
            key={value}
            type="button"
            aria-pressed={trustState === value}
            onClick={() => {
              if (value === trustState) return;
              setLoading(true);
              setError(null);
              setDetail(null);
              setSelectedId(null);
              setTrustState(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && <p className="error-message">{error}</p>}
      {loading ? (
        <p>Loading migration guidance…</p>
      ) : specifications.length === 0 ? (
        <p className="panel empty-state">No specifications are in this state.</p>
      ) : (
        <div className="specification-review-layout">
          <div className="specification-review-list" aria-label="Specifications">
            {specifications.map(item => (
              <button
                className="specification-review-item"
                type="button"
                key={item.id}
                aria-pressed={selectedId === item.id}
                onClick={() => {
                  if (selectedId === item.id) return;
                  setError(null);
                  setDetail(null);
                  setDetailLoading(true);
                  setSelectedId(item.id);
                }}
              >
                <strong>{item.productIdentifier}</strong>
                <span>
                  {item.sourceCompatibility} → {item.targetVersion}
                </span>
                <small>{item.vendorName}</small>
              </button>
            ))}
          </div>
          <section className="panel specification-detail" aria-live="polite">
            {detailLoading || !detail ? (
              <p>Loading specification…</p>
            ) : (
              <>
                <header className="specification-detail-header">
                  <div>
                    <p className="eyebrow">{detail.vendorName}</p>
                    <h2>{detail.productIdentifier}</h2>
                    <p className="specification-version-route">
                      {detail.sourceCompatibility} → {detail.targetVersion}
                    </p>
                    <p className="specification-provenance">
                      Generated {formatTimestamp(detail.createdAt)} · evidence{' '}
                      <code title={detail.evidenceDigest}>
                        {detail.evidenceDigest.slice(0, 12)}…
                      </code>
                    </p>
                  </div>
                  <span className={`source-status source-status-${detail.trustState}`}>
                    {detail.trustState.replaceAll('_', ' ')}
                  </span>
                </header>
                <section>
                  <h3>What changes</h3>
                  <div className="spec-review-change-list">
                    {detail.specification.changes.map(change => (
                      <article
                        className="spec-review-change-card"
                        key={change.changeId}
                      >
                        <header className="spec-review-change-header">
                          <span className="spec-review-category">
                            {change.category}
                          </span>
                          <span
                            className={`spec-review-certainty spec-review-certainty-${change.certainty}`}
                          >
                            {change.certainty === 'vendor_confirmed'
                              ? 'Evidence confirmed'
                              : 'Ambiguous'}
                          </span>
                        </header>
                        <h4>{change.summary}</h4>
                        {change.transformations.length > 0 && (
                          <div className="spec-review-transformations">
                            {change.transformations.map((transformation, index) => (
                              <div key={`${change.changeId}-${String(index)}`}>
                                <code>{transformation.before}</code>
                                <span aria-hidden="true">→</span>
                                <code>{transformation.after}</code>
                                {transformation.condition && (
                                  <small>{transformation.condition}</small>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
                <section className="specification-two-column">
                  <div>
                    <h3>Preconditions</h3>
                    {detail.specification.preconditions.length === 0 ? (
                      <p className="muted-copy">None recorded.</p>
                    ) : (
                      <ul>
                        {detail.specification.preconditions.map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div>
                    <h3>Verification</h3>
                    <ul>
                      {detail.specification.verificationRecommendations.map(item => (
                        <li key={item}>{item.replaceAll('_', ' ')}</li>
                      ))}
                    </ul>
                  </div>
                </section>
                {detail.specification.uncertainties.length > 0 && (
                  <details className="specification-evidence">
                    <summary>Recorded uncertainties</summary>
                    <ul>
                      {detail.specification.uncertainties.map(item => (
                        <li key={item.code}>{item.summary}</li>
                      ))}
                    </ul>
                  </details>
                )}
                <details className="specification-evidence">
                  <summary>Evidence ({detail.specification.evidence.length})</summary>
                  <ul>
                    {detail.specification.evidence.map(item => (
                      <li key={item.evidenceId}>
                        <a href={item.sourceUrl} target="_blank" rel="noreferrer">
                          {item.sourceKey} ↗
                        </a>{' '}
                        — {item.summary}
                      </li>
                    ))}
                  </ul>
                </details>
                {detail.trustState === 'draft' && (
                  <footer className="specification-review-footer">
                    {ambiguousChanges.length > 0 && (
                      <p className="review-blocker">
                        Review is blocked: {ambiguousChanges.length}{' '}
                        {ambiguousChanges.length === 1 ? 'change is' : 'changes are'}
                        ambiguous. This draft cannot be promoted without stronger
                        evidence.
                      </p>
                    )}
                    <button
                      className="primary-button"
                      type="button"
                      disabled={reviewing || ambiguousChanges.length > 0}
                      aria-busy={reviewing}
                      onClick={() => void review()}
                    >
                      {reviewing ? 'Reviewing…' : 'Approve migration guidance'}
                    </button>
                    <p className="fine-print">
                      Approval makes this guidance eligible for repository matching. It
                      does not modify code or create a pull request.
                    </p>
                  </footer>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

type PackageSourceQueueStatus = 'needs_review' | 'mapped' | 'rejected' | 'disabled';

function PackageSourceReviewPage(): React.JSX.Element {
  const { session } = useAuth();
  const [status, setStatus] = useState<PackageSourceQueueStatus>('needs_review');
  const [mappings, setMappings] = useState<PublicPackageSourceMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const queueRequest =
      status === 'needs_review'
        ? Promise.all([
            loadPackageSourceMappings(session.access_token, 'needs_review'),
            loadPackageSourceMappings(session.access_token, 'mapped'),
          ]).then(([pending, mapped]) => ({
            mappings: [
              ...new Map(
                [...pending.mappings, ...mapped.mappings]
                  .filter(
                    mapping =>
                      packageSourceCandidatesForReview(mapping.candidates).length > 0,
                  )
                  .map(mapping => [mapping.id, mapping]),
              ).values(),
            ],
          }))
        : loadPackageSourceMappings(session.access_token, status).then(result => ({
            mappings:
              status === 'mapped'
                ? result.mappings.filter(
                    mapping =>
                      packageSourceCandidatesForReview(mapping.candidates).length === 0,
                  )
                : result.mappings,
          }));
    void queueRequest
      .then(mappingData => {
        if (active) {
          setMappings(mappingData.mappings);
        }
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
  }, [generation, session, status]);

  return (
    <div className="page package-source-page">
      <Link to="/onboarding">← Workspaces</Link>
      <p className="eyebrow">Platform operator</p>
      <h1>Update sources</h1>
      <p className="lede">
        Confirm where Upversion should watch for new package versions and release
        guidance. The npm registry is the standard version feed; confirm other sources
        only when you recognize the exact repository or documentation URL.
      </p>
      <div className="queue-filters" aria-label="Package source queue filters">
        {(
          [
            ['needs_review', 'To review'],
            ['mapped', 'Confirmed'],
            ['rejected', 'Not official'],
            ['disabled', 'Paused'],
          ] as const
        ).map(([value, label]) => (
          <button
            className="queue-filter"
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              if (value === status) return;
              setLoading(true);
              setError(null);
              setStatus(value);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {loading && <p>Loading package sources…</p>}
      {error && <p className="error-message">{error}</p>}
      {!loading && !error && mappings.length === 0 && (
        <p className="panel empty-state">No mappings are in this state.</p>
      )}
      <div className="package-source-list">
        {mappings.map(mapping => (
          <PackageSourceMappingCard
            key={mapping.id}
            mapping={mapping}
            token={session?.access_token ?? ''}
            onReviewed={() => {
              setLoading(true);
              setError(null);
              setGeneration(value => value + 1);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function PackageSourceMappingCard({
  mapping,
  token,
  onReviewed,
}: {
  readonly mapping: PublicPackageSourceMapping;
  readonly token: string;
  readonly onReviewed: () => void;
}): React.JSX.Element {
  const pollIntervalSeconds = 86_400;
  type CandidateReviewOperation =
    'queued_approve' | 'queued_reject' | 'approve' | 'reject';
  const [busyOperation, setBusyOperation] = useState<{
    readonly targetId: string;
    readonly action: 'add' | 'mapping' | 'backfill' | 'refresh';
  } | null>(null);
  const [candidateReviewOperations, setCandidateReviewOperations] = useState<
    Readonly<Record<string, CandidateReviewOperation>>
  >({});
  const reviewQueue = useRef<Promise<void>>(Promise.resolve());
  const queuedReviewCandidateIds = useRef<Set<string>>(new Set());
  const currentMappingVersion = useRef(mapping.version);
  const [newSourceKind, setNewSourceKind] = useState<
    'sdk_repository_release' | 'changelog' | 'release_feed' | 'migration_guide'
  >('migration_guide');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [newSourceNote, setNewSourceNote] = useState('');
  const [disabledReasonCode, setDisabledReasonCode] = useState<
    'OPERATOR_DISABLED' | 'PACKAGE_UNSUPPORTED' | 'SECURITY_CONCERN'
  >('OPERATOR_DISABLED');
  const [rejectingCandidateId, setRejectingCandidateId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  useEffect(() => {
    currentMappingVersion.current = Math.max(
      currentMappingVersion.current,
      mapping.version,
    );
  }, [mapping.version]);

  async function review(
    candidate: PublicPackageSourceCandidate,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    if (queuedReviewCandidateIds.current.has(candidate.id)) return;
    queuedReviewCandidateIds.current.add(candidate.id);
    setCandidateReviewOperations(current => ({
      ...current,
      [candidate.id]: decision === 'approve' ? 'queued_approve' : 'queued_reject',
    }));
    setError(null);
    const queuedReview = reviewQueue.current
      .catch(() => undefined)
      .then(async () => {
        setCandidateReviewOperations(current => ({
          ...current,
          [candidate.id]: decision,
        }));
        const result = await reviewPackageSourceCandidate(
          token,
          candidate.id,
          crypto.randomUUID(),
          decision === 'approve'
            ? {
                decision,
                expectedCandidateVersion: candidate.version,
                expectedMappingVersion: currentMappingVersion.current,
                pollIntervalSeconds,
              }
            : {
                decision,
                expectedCandidateVersion: candidate.version,
                expectedMappingVersion: currentMappingVersion.current,
                rejectionReasonCode: 'NOT_OFFICIAL',
              },
        );
        currentMappingVersion.current = result.review.mapping.version;
        onReviewed();
      })
      .catch((caught: unknown) => {
        setError(errorText(caught));
      })
      .finally(() => {
        queuedReviewCandidateIds.current.delete(candidate.id);
        setCandidateReviewOperations(current =>
          Object.fromEntries(
            Object.entries(current).filter(
              ([candidateId]) => candidateId !== candidate.id,
            ),
          ),
        );
      });
    reviewQueue.current = queuedReview;
    await queuedReview;
  }

  async function changeMappingState(): Promise<void> {
    setBusyOperation({ targetId: mapping.id, action: 'mapping' });
    setError(null);
    try {
      await setPackageSourceMappingState(
        token,
        mapping.id,
        crypto.randomUUID(),
        mapping.status === 'disabled'
          ? { action: 'enable', expectedMappingVersion: mapping.version }
          : {
              action: 'disable',
              expectedMappingVersion: mapping.version,
              disabledReasonCode,
            },
      );
      onReviewed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
  }

  async function addSourceCandidate(): Promise<void> {
    setBusyOperation({ targetId: mapping.id, action: 'add' });
    setError(null);
    try {
      await addPackageSourceCandidate(token, mapping.id, crypto.randomUUID(), {
        expectedMappingVersion: mapping.version,
        sourceKind: newSourceKind,
        canonicalUrl: newSourceUrl,
        proposalNote: newSourceNote,
      });
      setNewSourceUrl('');
      setNewSourceNote('');
      onReviewed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
  }

  async function refreshEvidence(): Promise<void> {
    setBusyOperation({ targetId: mapping.id, action: 'refresh' });
    setError(null);
    setRefreshResult(null);
    try {
      const result = await requestPackageEvidenceRefresh(
        token,
        mapping.id,
        crypto.randomUUID(),
        mapping.version,
      );
      setRefreshResult(
        `${result.refresh.sourceVersion} → ${result.refresh.targetVersion} queued with the newly confirmed evidence. The previous draft remains available for audit.`,
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
  }

  async function backfillCurrentRelease(): Promise<void> {
    setBusyOperation({ targetId: mapping.id, action: 'backfill' });
    setError(null);
    setBackfillResult(null);
    try {
      const result = await requestPackageReleasePilotBackfill(
        token,
        mapping.id,
        crypto.randomUUID(),
        mapping.version,
      );
      const route = `${result.backfill.sourceVersion} → ${result.backfill.targetVersion}`;
      setBackfillResult(
        result.backfill.queueState === 'completed'
          ? `${route} analysis is complete. Refresh Review migration guidance.`
          : result.backfill.queueState === 'in_progress'
            ? `${route} migration-guidance analysis is already running.`
            : `${route} queued for migration-guidance analysis.`,
      );
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
  }

  const candidatesNeedingReview = packageSourceCandidatesForReview(mapping.candidates);
  const pendingCount = candidatesNeedingReview.length;
  const confirmedCount = mapping.candidates.filter(
    candidate => candidate.canPromote && candidate.reviewState === 'approved',
  ).length;
  const displayStatus =
    mapping.status === 'mapped' && pendingCount > 0 ? 'needs_review' : mapping.status;
  const evidenceRecommendations = packageEvidenceRecommendations(mapping);

  return (
    <article className="panel package-source-card">
      <header className="package-source-header">
        <div>
          <div className="package-source-title-row">
            <h2>{mapping.packageName}</h2>
            <span className={`source-status source-status-${displayStatus}`}>
              {packageSourceMappingStatusLabel(displayStatus)}
            </span>
          </div>
          <p>
            {pendingCount > 0
              ? pendingCount === 1
                ? 'Review this migration source'
                : `Review the ${String(pendingCount)} most useful migration sources`
              : `${String(confirmedCount)} ${confirmedCount === 1 ? 'source' : 'sources'} confirmed`}
          </p>
        </div>
        <div className="package-source-facts" aria-label="Package summary">
          <span>
            Latest <strong>{mapping.latestVersion ?? 'unknown'}</strong>
          </span>
          <span>
            Used by <strong>{mapping.repositoryUsage.total}</strong>{' '}
            {mapping.repositoryUsage.total === 1 ? 'repository' : 'repositories'}
          </span>
          <a
            href={`https://www.npmjs.com/package/${mapping.packageName}`}
            target="_blank"
            rel="noreferrer"
          >
            Open on npm ↗
          </a>
        </div>
      </header>
      {error && <p className="error-message">{error}</p>}
      <div className="package-source-candidates">
        {candidatesNeedingReview.map(candidate => {
          const displayUrl = packageSourceDisplayUrl(candidate.canonicalUrl);
          const copy = packageSourceReviewCopy(candidate.sourceKind);
          const reviewOperation = candidateReviewOperations[candidate.id];
          const approving = reviewOperation === 'approve';
          const approveQueued = reviewOperation === 'queued_approve';
          const rejecting = reviewOperation === 'reject';
          const rejectQueued = reviewOperation === 'queued_reject';
          return (
            <section
              className={`package-source-candidate source-${candidate.reviewState}`}
              key={candidate.id}
            >
              <div className="source-review-copy">
                <span className="source-review-step">{copy.step}</span>
                <h3>{copy.title}</h3>
                <p>{copy.description}</p>
                <a
                  className="source-review-link"
                  href={candidate.canonicalUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  {displayUrl.hostname}
                  {displayUrl.path} ↗
                </a>
              </div>
              {mapping.status !== 'disabled' && (
                <div className="review-actions">
                  <div>
                    <button
                      className="source-confirm-button"
                      type="button"
                      disabled={!candidate.canPromote || reviewOperation !== undefined}
                      aria-busy={approving}
                      onClick={() => void review(candidate, 'approve')}
                    >
                      {approveQueued
                        ? 'Queued…'
                        : approving
                          ? 'Confirming…'
                          : 'Confirm source'}
                    </button>
                    <button
                      className="source-reject-button"
                      type="button"
                      disabled={reviewOperation !== undefined}
                      aria-expanded={rejectingCandidateId === candidate.id}
                      onClick={() =>
                        setRejectingCandidateId(current =>
                          current === candidate.id ? null : candidate.id,
                        )
                      }
                    >
                      Not official
                    </button>
                  </div>
                  {rejectingCandidateId === candidate.id && (
                    <div className="decision-confirmation">
                      <p>Mark this source as not official?</p>
                      <div>
                        <button
                          className="source-reject-confirm-button"
                          type="button"
                          disabled={reviewOperation !== undefined}
                          aria-busy={rejecting}
                          onClick={() => void review(candidate, 'reject')}
                        >
                          {rejectQueued
                            ? 'Queued…'
                            : rejecting
                              ? 'Saving…'
                              : 'Yes, reject'}
                        </button>
                        <button
                          className="text-button"
                          type="button"
                          disabled={reviewOperation !== undefined}
                          onClick={() => setRejectingCandidateId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {mapping.status === 'mapped' && (
        <section className="source-evidence-controls">
          <div>
            <h3>Migration resources</h3>
            <p>
              Check these three publisher-linked resources for the upgrade. Confirmed
              links are already trusted; suggested searches still need your review.
            </p>
          </div>
          <ul className="source-recommendation-list">
            {evidenceRecommendations.map(recommendation => (
              <li className="source-recommendation" key={recommendation.id}>
                <div className="source-recommendation-title">
                  <strong>{recommendation.title}</strong>
                  <span
                    className={`source-recommendation-status source-recommendation-${recommendation.verification}`}
                  >
                    {recommendation.verification === 'confirmed'
                      ? 'Confirmed'
                      : 'Verify'}
                  </span>
                </div>
                <a
                  className="secondary-button"
                  href={recommendation.href}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open ↗
                </a>
              </li>
            ))}
          </ul>
          {evidenceRecommendations.length < 3 && (
            <p className="source-recommendation-shortfall">
              Only {String(evidenceRecommendations.length)} credible{' '}
              {evidenceRecommendations.length === 1 ? 'resource was' : 'resources were'}{' '}
              found. Add another only if you can verify that the publisher owns it.
            </p>
          )}
          <details className="source-evidence-custom">
            <summary>Add another source</summary>
            <p>
              Paste an exact publisher-owned migration guide, changelog, or release
              page. It will require confirmation before the system trusts it.
            </p>
            <div className="source-evidence-addition">
              <select
                aria-label="Evidence source type"
                value={newSourceKind}
                onChange={event =>
                  setNewSourceKind(event.target.value as typeof newSourceKind)
                }
              >
                <option value="migration_guide">Migration guide</option>
                <option value="changelog">Changelog</option>
                <option value="release_feed">Release page or feed</option>
                <option value="sdk_repository_release">Source repository</option>
              </select>
              <input
                aria-label="Official evidence URL"
                type="url"
                placeholder="https://official-project.example/migration-guide"
                value={newSourceUrl}
                onChange={event => setNewSourceUrl(event.target.value)}
              />
              <input
                aria-label="How the source was verified"
                maxLength={500}
                placeholder="Why this URL belongs to the package publisher"
                value={newSourceNote}
                onChange={event => setNewSourceNote(event.target.value)}
              />
              <button
                className="secondary-button"
                type="button"
                disabled={
                  busyOperation !== null || !newSourceUrl || !newSourceNote.trim()
                }
                aria-busy={busyOperation?.action === 'add'}
                onClick={() => void addSourceCandidate()}
              >
                {busyOperation?.action === 'add' ? 'Adding…' : 'Add for confirmation'}
              </button>
            </div>
          </details>
        </section>
      )}
      {mapping.status === 'mapped' && mapping.guidanceRefreshAvailable && (
        <section className="source-evidence-refresh">
          <div>
            <h3>Regenerate blocked guidance</h3>
            <p>
              After confirming a new changelog or migration guide, create a new
              immutable evidence revision and analyse it again.
            </p>
            {refreshResult && <p className="success-message">{refreshResult}</p>}
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={busyOperation !== null}
            aria-busy={busyOperation?.action === 'refresh'}
            onClick={() => void refreshEvidence()}
          >
            {busyOperation?.action === 'refresh'
              ? 'Queuing…'
              : 'Regenerate with confirmed sources'}
          </button>
        </section>
      )}
      {mapping.status === 'mapped' && pendingCount === 0 && (
        <section
          className="pilot-release-backfill"
          aria-labelledby={`pilot-${mapping.id}`}
        >
          <div>
            <h3 id={`pilot-${mapping.id}`}>Pilot an existing release</h3>
            <p>
              Use the installed version from the latest selected repository scan and the
              current npm release evidence. No version or source URL can be entered
              manually.
            </p>
            {backfillResult && <p className="success-message">{backfillResult}</p>}
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={
              busyOperation !== null ||
              mapping.repositoryUsage.direct === 0 ||
              mapping.latestDeprecated !== false
            }
            aria-busy={
              busyOperation?.targetId === mapping.id &&
              busyOperation.action === 'backfill'
            }
            onClick={() => void backfillCurrentRelease()}
          >
            {busyOperation?.targetId === mapping.id &&
            busyOperation.action === 'backfill'
              ? 'Queuing…'
              : 'Ingest current release'}
          </button>
        </section>
      )}
      <details className="package-source-technical">
        <summary>Technical details and controls</summary>
        <div className="package-source-technical-content">
          <dl className="package-source-metadata">
            <div>
              <dt>Registry checked</dt>
              <dd>
                {mapping.resolvedAt ? formatTimestamp(mapping.resolvedAt) : 'Unknown'}
              </dd>
            </div>
            <div>
              <dt>Deprecated</dt>
              <dd>
                {mapping.latestDeprecated === null
                  ? 'Unknown'
                  : mapping.latestDeprecated
                    ? 'Yes'
                    : 'No'}
              </dd>
            </div>
            <div>
              <dt>Evidence digest</dt>
              <dd>
                <code>{mapping.evidenceDigest ?? 'Unavailable'}</code>
              </dd>
            </div>
            <div>
              <dt>Dependency use</dt>
              <dd>
                {mapping.repositoryUsage.direct} direct ·{' '}
                {mapping.repositoryUsage.development} development ·{' '}
                {mapping.repositoryUsage.optional} optional ·{' '}
                {mapping.repositoryUsage.peer} peer
              </dd>
            </div>
            <div>
              <dt>Internal revision</dt>
              <dd>{mapping.version}</dd>
            </div>
            {mapping.status === 'disabled' && (
              <div>
                <dt>Paused</dt>
                <dd>
                  {mapping.disabledReasonCode?.replaceAll('_', ' ').toLowerCase()} ·{' '}
                  {mapping.disabledAt
                    ? formatTimestamp(mapping.disabledAt)
                    : 'Unknown time'}
                </dd>
              </div>
            )}
          </dl>
          <div className="mapping-state-controls">
            {mapping.status !== 'disabled' && (
              <select
                aria-label="Pause reason"
                value={disabledReasonCode}
                onChange={event =>
                  setDisabledReasonCode(event.target.value as typeof disabledReasonCode)
                }
              >
                <option value="OPERATOR_DISABLED">Pause monitoring</option>
                <option value="PACKAGE_UNSUPPORTED">Package unsupported</option>
                <option value="SECURITY_CONCERN">Security concern</option>
              </select>
            )}
            <button
              className="secondary-button"
              type="button"
              disabled={busyOperation !== null}
              aria-busy={
                busyOperation?.targetId === mapping.id &&
                busyOperation.action === 'mapping'
              }
              onClick={() => void changeMappingState()}
            >
              {busyOperation?.targetId === mapping.id &&
              busyOperation.action === 'mapping'
                ? 'Updating…'
                : mapping.status === 'disabled'
                  ? 'Resume monitoring'
                  : 'Pause monitoring'}
            </button>
          </div>
        </div>
      </details>
    </article>
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
        Install the Upversion GitHub App on an organisation or account. Choose only the
        repositories you want this workspace to see.
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
          className="primary-button link-button"
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
  const [notifications, setNotifications] = useState<PublicPublicationNotification[]>(
    [],
  );
  const [candidateNotifications, setCandidateNotifications] = useState<
    PublicCandidateNotification[]
  >([]);
  const [notificationActionId, setNotificationActionId] = useState<string | null>(null);
  const [notificationError, setNotificationError] = useState<string | null>(null);
  const [showDismissedNotifications, setShowDismissedNotifications] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId) return;
    let active = true;
    void Promise.all([
      loadMigrationCandidates(session.access_token, orgId),
      loadPublicationNotifications(session.access_token, orgId),
      loadCandidateNotifications(session.access_token, orgId),
    ])
      .then(([candidateData, notificationData, candidateNotificationData]) => {
        if (active) {
          setCandidates(candidateData.candidates);
          setNotifications(notificationData.notifications);
          setCandidateNotifications(candidateNotificationData.notifications);
        }
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

  const visibleCandidateNotifications = candidateNotifications.filter(
    notification => showDismissedNotifications || notification.dismissedAt === null,
  );
  const unreadCandidateNotifications = candidateNotifications.filter(
    notification => notification.readAt === null && notification.dismissedAt === null,
  ).length;

  async function setCandidateNotificationState(
    notification: PublicCandidateNotification,
    action: 'mark_read' | 'dismiss',
  ): Promise<void> {
    if (!session || !orgId || notificationActionId !== null) return;
    setNotificationActionId(notification.notificationId);
    setNotificationError(null);
    try {
      const { state } = await updateCandidateNotificationState(
        session.access_token,
        orgId,
        notification.notificationId,
        { action },
      );
      setCandidateNotifications(current =>
        current.map(candidateNotification =>
          candidateNotification.notificationId === state.notificationId
            ? { ...candidateNotification, ...state }
            : candidateNotification,
        ),
      );
    } catch (caught) {
      setNotificationError(errorText(caught));
    } finally {
      setNotificationActionId(null);
    }
  }

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
          <div className="heading-actions">
            <a
              className="secondary-button link-button"
              href={`/organisations/${orgId}/migration-runs`}
            >
              Run history
            </a>
            <a
              className="secondary-button link-button"
              href={`/organisations/${orgId}/settings/github`}
            >
              Repository settings
            </a>
          </div>
        )}
      </div>
      {candidateNotifications.length > 0 && (
        <section
          className="panel candidate-notifications"
          aria-labelledby="dependency-updates-heading"
        >
          <div className="candidate-notification-heading">
            <div>
              <p className="section-kicker">Dependency updates</p>
              <h2 id="dependency-updates-heading">Updates ready to review</h2>
              <p>
                Each update has a trusted registry source, reviewed migration guidance,
                and a dependency match in this workspace.
              </p>
            </div>
            <div className="candidate-notification-summary">
              <span className="dependency-count">
                {unreadCandidateNotifications} unread
              </span>
              {candidateNotifications.some(
                notification => notification.dismissedAt !== null,
              ) && (
                <button
                  className="text-button"
                  type="button"
                  onClick={() => setShowDismissedNotifications(current => !current)}
                >
                  {showDismissedNotifications ? 'Hide dismissed' : 'Show dismissed'}
                </button>
              )}
            </div>
          </div>
          {notificationError && (
            <p className="error-message" role="alert">
              {notificationError}
            </p>
          )}
          {visibleCandidateNotifications.length === 0 ? (
            <p className="candidate-notification-empty">
              All dependency notifications are dismissed.
            </p>
          ) : (
            <ul className="candidate-notification-list">
              {visibleCandidateNotifications.map(notification => {
                const busy = notificationActionId === notification.notificationId;
                const actionable = notification.candidateStatus === 'open';
                return (
                  <li
                    className={notification.readAt === null ? 'is-unread' : undefined}
                    key={notification.notificationId}
                  >
                    <div className="candidate-notification-copy">
                      <div className="candidate-notification-title">
                        <strong>{notification.packageName}</strong>
                        {notification.readAt === null && (
                          <span className="unread-marker">New</span>
                        )}
                        {notification.dismissedAt !== null && (
                          <span className="notification-state">Dismissed</span>
                        )}
                      </div>
                      <p>
                        {notification.repositoryFullName} ·{' '}
                        {notification.currentVersion} → {notification.targetVersion}
                      </p>
                      <div className="candidate-notification-facts">
                        <span>Trusted npm source</span>
                        <span>Guidance reviewed</span>
                        <span>
                          {notification.impactStatus === 'ready'
                            ? `${notification.riskCategory ?? 'unknown'} risk · ${String(notification.uncertaintyCount ?? 0)} uncertainties`
                            : 'Impact analysis pending'}
                        </span>
                        {!actionable && (
                          <span className="notification-not-actionable">
                            No longer actionable
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="candidate-notification-actions">
                      {actionable && (
                        <Link
                          to={`/organisations/${orgId ?? ''}/migrations/${notification.candidateId}`}
                        >
                          Review update
                        </Link>
                      )}
                      {notification.readAt === null && (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={notificationActionId !== null}
                          aria-busy={busy}
                          onClick={() =>
                            void setCandidateNotificationState(
                              notification,
                              'mark_read',
                            )
                          }
                        >
                          {busy ? 'Saving…' : 'Mark as read'}
                        </button>
                      )}
                      {notification.dismissedAt === null && (
                        <button
                          className="text-button"
                          type="button"
                          disabled={notificationActionId !== null}
                          aria-busy={busy}
                          onClick={() =>
                            void setCandidateNotificationState(notification, 'dismiss')
                          }
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
      {notifications.length > 0 && (
        <section className="panel publication-notifications">
          <div className="patch-review-heading">
            <div>
              <p className="section-kicker">Ready for human review</p>
              <h2>Published draft pull requests</h2>
              <p>
                These notifications are visible only to the reviewer who approved the
                migration.
              </p>
            </div>
            <span className="dependency-count">
              {notifications.length}{' '}
              {notifications.length === 1 ? 'notification' : 'notifications'}
            </span>
          </div>
          <ul>
            {notifications.map(notification => (
              <li key={notification.id}>
                <div>
                  <strong>{notification.repositoryFullName}</strong>
                  <p>
                    Pull request #{String(notification.pullRequestNumber)} ·{' '}
                    {notification.pullRequestState === 'open' && notification.isDraft
                      ? 'draft'
                      : notification.pullRequestState}
                  </p>
                </div>
                <div className="publication-notification-actions">
                  <Link
                    to={`/organisations/${orgId ?? ''}/migration-runs/${notification.migrationRunId}`}
                  >
                    View evidence
                  </Link>
                  <a
                    href={notification.pullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open on GitHub
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
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
        Candidates remain read-only until a reviewer grants the explicit migration
        authority shown in their approval contract. Published pull requests always
        require human review; the platform cannot merge them.
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

      <ImpactAnalysisAction
        detail={detail}
        organisationId={orgId ?? ''}
        token={session?.access_token ?? ''}
        onUpdated={setDetail}
      />

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
        Stage 5 acquires the approved snapshot and may produce a policy-validated patch
        artifact. It does not execute repository code, write to GitHub, create a branch,
        or open a pull request.
      </p>
    </div>
  );
}

function ImpactAnalysisAction({
  detail,
  organisationId,
  token,
  onUpdated,
}: {
  readonly detail: PublicMigrationCandidateDetail;
  readonly organisationId: string;
  readonly token: string;
  readonly onUpdated: (detail: PublicMigrationCandidateDetail) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState<
    'idle' | 'submitting' | 'queued' | 'completed' | 'polling_failed'
  >('idle');
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(`impact:${crypto.randomUUID()}`);
  const baselineReportId = useRef<string | null>(null);
  const requestedCorrelationId = useRef<string | null>(null);
  const report = detail.impactReport;
  const isCurrent = report?.freshness === 'current';
  const roleBlocked = detail.approval.blockers.includes('APPROVAL_ROLE_REQUIRED');
  const isBusy = status === 'submitting' || status === 'queued';
  const canRequest =
    Boolean(token) &&
    detail.candidate.status === 'open' &&
    !isCurrent &&
    !roleBlocked &&
    !isBusy;

  useEffect(() => {
    if (status !== 'queued') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async (): Promise<void> => {
      attempts += 1;
      try {
        const response = await loadMigrationCandidate(
          token,
          organisationId,
          detail.candidate.id,
        );
        if (!active) return;
        const updatedReport = response.candidate.impactReport;
        onUpdated(response.candidate);
        if (
          updatedReport?.freshness === 'current' &&
          updatedReport.id !== baselineReportId.current
        ) {
          idempotencyKey.current = `impact:${crypto.randomUUID()}`;
          setStatus('completed');
          return;
        }
        if (
          response.candidate.impactAnalysis?.status === 'failed' &&
          response.candidate.impactAnalysis.correlationId ===
            requestedCorrelationId.current
        ) {
          idempotencyKey.current = `impact:${crypto.randomUUID()}`;
          setError(
            `Impact analysis stopped safely${
              response.candidate.impactAnalysis.safeErrorCode
                ? ` (${response.candidate.impactAnalysis.safeErrorCode})`
                : ''
            }. You can retry it.`,
          );
          setStatus('polling_failed');
          return;
        }
      } catch (caught) {
        if (!active) return;
        idempotencyKey.current = `impact:${crypto.randomUUID()}`;
        setError(
          `${errorText(caught)} The analysis request may still be running; refresh this page to check it.`,
        );
        setStatus('polling_failed');
        return;
      }
      if (attempts >= 132) {
        idempotencyKey.current = `impact:${crypto.randomUUID()}`;
        setError(
          'The analysis is taking longer than expected. Refresh this page to check its latest state.',
        );
        setStatus('polling_failed');
        return;
      }
      timer = setTimeout(() => void poll(), 5_000);
    };
    timer = setTimeout(() => void poll(), 2_000);
    return (): void => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [detail.candidate.id, onUpdated, organisationId, status, token]);

  async function requestAnalysis(): Promise<void> {
    if (!canRequest) return;
    baselineReportId.current = report?.id ?? null;
    setStatus('submitting');
    setError(null);
    try {
      const response = await requestImpactAnalysis(
        token,
        organisationId,
        detail.candidate.id,
        idempotencyKey.current,
      );
      requestedCorrelationId.current = response.analysis.correlationId;
      setStatus('queued');
    } catch (caught) {
      setError(errorText(caught));
      setStatus('idle');
    }
  }

  const label = isCurrent
    ? 'Impact report current'
    : report
      ? 'Refresh impact analysis'
      : 'Run impact analysis';
  return (
    <section className="panel detail-section impact-analysis-control">
      <div>
        <p className="section-kicker">Read-only analysis control</p>
        <h2>{isCurrent ? 'Impact evidence is current' : 'Impact evidence required'}</h2>
        <p>
          Analysis reads the exact repository snapshot shown below without executing or
          modifying repository code.
        </p>
      </div>
      <div className="impact-analysis-actions">
        <button
          aria-busy={isBusy}
          className="secondary-button"
          disabled={!canRequest}
          type="button"
          onClick={() => void requestAnalysis()}
        >
          {status === 'submitting'
            ? 'Queuing analysis…'
            : status === 'queued'
              ? 'Analysis running…'
              : label}
        </button>
        <p aria-live="polite" className={error ? 'form-error' : 'fine-print'}>
          {error ??
            (status === 'queued'
              ? 'Analysis is queued. This page will update automatically.'
              : status === 'completed'
                ? 'The current impact report is ready.'
                : roleBlocked
                  ? 'Your workspace role cannot request impact analysis.'
                  : detail.impactAnalysis?.status === 'failed'
                    ? `The last analysis stopped safely${
                        detail.impactAnalysis.safeErrorCode
                          ? ` (${detail.impactAnalysis.safeErrorCode})`
                          : ''
                      }.`
                    : '')}
        </p>
      </div>
    </section>
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
          <code>{result.run.id}</code> has entered the durable migration workflow.
        </p>
        <Link
          className="primary-button"
          to={`/organisations/${organisationId}/migration-runs/${result.run.id}`}
        >
          View run timeline
        </Link>
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

function MigrationRunPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId, runId } = useParams();
  const [run, setRun] = useState<PublicMigrationRunDetail | null>(null);
  const [patchReview, setPatchReview] = useState<PublicMigrationPatchReview | null>(
    null,
  );
  const [patchReviewLoading, setPatchReviewLoading] = useState(false);
  const [patchReviewError, setPatchReviewError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [confirmingRevocation, setConfirmingRevocation] = useState(false);
  const cancellationKey = useRef(`cancel:${crypto.randomUUID()}`);
  const revocationKey = useRef(`revoke:${crypto.randomUUID()}`);
  const patchReviewRequest = useRef<string | null>(null);

  useEffect(() => {
    if (!session || !orgId || !runId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const response = await loadMigrationRun(session.access_token, orgId, runId);
        if (!active) return;
        setRun(response.run);
        setError(null);
        if (
          response.run.status === 'queued' ||
          response.run.status === 'running' ||
          response.run.publication?.notification?.status === 'queued'
        ) {
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

  const patchProposed =
    run?.events.some(event => event.eventType === 'patch_proposed') ?? false;
  useEffect(() => {
    if (
      !session ||
      !orgId ||
      !runId ||
      !patchProposed ||
      patchReview !== null ||
      patchReviewRequest.current === runId
    ) {
      return;
    }
    let active = true;
    patchReviewRequest.current = runId;
    setPatchReviewLoading(true);
    void loadMigrationPatchReview(session.access_token, orgId, runId)
      .then(review => {
        if (active) {
          setPatchReview(review.patchReview);
          setPatchReviewError(null);
        }
      })
      .catch((caught: unknown) => {
        if (active) setPatchReviewError(errorText(caught));
      })
      .finally(() => {
        if (active) setPatchReviewLoading(false);
      });
    return (): void => {
      active = false;
    };
  }, [orgId, patchProposed, patchReview, runId, session]);

  async function cancel(): Promise<void> {
    if (!session || !orgId || !runId || !run) return;
    setCancelling(true);
    setError(null);
    try {
      const response = await cancelMigrationRun(
        session.access_token,
        orgId,
        runId,
        cancellationKey.current,
        {
          expectedVersion: run.version,
          reasonCode: 'USER_REQUESTED',
        },
      );
      setRun(response.run);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setCancelling(false);
    }
  }

  async function revoke(): Promise<void> {
    if (!session || !orgId || !runId || !run) return;
    setRevoking(true);
    setError(null);
    try {
      const response = await revokeMigrationApproval(
        session.access_token,
        orgId,
        runId,
        revocationKey.current,
        {
          expectedVersion: run.version,
          reasonCode: 'USER_REQUESTED',
        },
      );
      setRun(response.run);
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setRevoking(false);
    }
  }

  if (error && !run) return <FullPageMessage>{error}</FullPageMessage>;
  if (!run) return <FullPageMessage>Loading migration run…</FullPageMessage>;
  const active = run.status === 'queued' || run.status === 'running';
  const canCancel = active && run.cancellationRequestedAt === null;
  const canRevoke = canCancel && run.approval.revokedAt === null;
  const outcome = migrationRunOutcome(run.safeErrorCode);
  return (
    <div className="page migration-run-page">
      <a className="back-link" href={`/organisations/${orgId ?? ''}/migration-runs`}>
        ← Run history
      </a>
      <div className="run-heading">
        <div>
          <p className="eyebrow">Durable migration run</p>
          <h1>{run.repositoryFullName}</h1>
          <p className="lede">
            {run.packageName} → {run.targetVersion} from commit{' '}
            <code>{shortSha(run.baseCommitSha)}</code>
          </p>
        </div>
        <span className={`status status-${run.status}`}>{run.status}</span>
      </div>

      <section className="panel migration-run-summary">
        <div>
          <span>Current stage</span>
          <strong>{run.currentStage.replaceAll('_', ' ')}</strong>
        </div>
        <div>
          <span>Run version</span>
          <strong>{run.version}</strong>
        </div>
        <div>
          <span>Execution</span>
          <code title={run.workflowExecutionArn ?? undefined}>
            {run.workflowExecutionArn ? 'Recorded' : 'Pending'}
          </code>
        </div>
        {canCancel && (
          <div className="run-actions">
            <button
              className="secondary-button"
              disabled={cancelling || revoking}
              type="button"
              onClick={() => void cancel()}
            >
              {cancelling ? 'Requesting cancellation…' : 'Cancel run'}
            </button>
            {canRevoke && (
              <button
                className="danger-button"
                disabled={cancelling || revoking}
                type="button"
                onClick={() => setConfirmingRevocation(true)}
              >
                Revoke approval
              </button>
            )}
          </div>
        )}
      </section>

      {error && <p className="error-message">{error}</p>}
      {canRevoke && confirmingRevocation && (
        <section className="panel revocation-confirmation" role="alert">
          <div>
            <p className="section-kicker">Permanent authorization change</p>
            <h2>Revoke this immutable approval?</h2>
            <p>
              The approval record remains in the audit trail, but this run will be
              stopped and the authorization cannot be restored.
            </p>
          </div>
          <div className="run-actions">
            <button
              className="danger-button"
              disabled={revoking}
              type="button"
              onClick={() => void revoke()}
            >
              {revoking ? 'Revoking approval…' : 'Confirm revocation'}
            </button>
            <button
              className="secondary-button"
              disabled={revoking}
              type="button"
              onClick={() => setConfirmingRevocation(false)}
            >
              Keep approval
            </button>
          </div>
        </section>
      )}
      {active && run.cancellationRequestedAt && (
        <section className="panel warning-panel">
          <p className="section-kicker">Stop requested</p>
          <h2>Waiting for the next safe workflow boundary</h2>
          <p>
            The control plane has recorded the request and will not silently continue
            into another authorized stage.
          </p>
        </section>
      )}
      <section className="panel approval-audit-card">
        <div>
          <p className="section-kicker">Immutable authorization</p>
          <h2>
            Approved by {run.approval.approvedByDisplayName ?? 'a workspace reviewer'}
          </h2>
          <p>
            {run.approval.approvedByRole} ·{' '}
            {new Date(run.approval.approvedAt).toLocaleString()}
          </p>
        </div>
        <span
          className={`status ${
            run.approval.revokedAt ? 'status-stale' : 'status-succeeded'
          }`}
        >
          {run.approval.revokedAt ? 'revoked' : 'active'}
        </span>
        {run.approval.revokedAt && (
          <p className="approval-revocation-note">
            Revoked by {run.approval.revokedByDisplayName ?? 'a workspace reviewer'} (
            {run.approval.revokedByRole}) on{' '}
            {new Date(run.approval.revokedAt).toLocaleString()}.
          </p>
        )}
      </section>
      {(patchReviewLoading || patchReviewError !== null || patchReview !== null) && (
        <PatchReviewPanel
          error={patchReviewError}
          loading={patchReviewLoading}
          review={patchReview}
        />
      )}
      {run.verificationAttempts.length > 0 && (
        <VerificationEvidencePanel attempts={run.verificationAttempts} />
      )}
      {run.publication && <PublicationPanel publication={run.publication} />}
      <section className="panel">
        <p className="section-kicker">Persisted workflow evidence</p>
        <h2>Run timeline</h2>
        <ol className="migration-event-list">
          {run.events.map(event => (
            <li key={event.sequence}>
              <span>{event.sequence}</span>
              <div>
                <strong>{migrationRunEventLabel(event.eventType)}</strong>
                <p>
                  {event.stage.replaceAll('_', ' ')} ·{' '}
                  {new Date(event.createdAt).toLocaleString()}
                </p>
                <small>
                  {event.actorType === 'system'
                    ? 'Migration control plane'
                    : (event.actorDisplayName ?? 'Workspace member')}
                </small>
                {event.safeErrorCode && <code>{event.safeErrorCode}</code>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      {outcome && (
        <section className="panel warning-panel">
          <p className="section-kicker">{outcome.kicker}</p>
          <h2>{outcome.title}</h2>
          <p>{outcome.body}</p>
        </section>
      )}
      {run.status === 'cancelled' && (
        <section className="panel">
          <h2>Cancellation completed</h2>
          <p>The run stopped at a safe control boundary without repository mutation.</p>
        </section>
      )}
    </div>
  );
}

function PublicationPanel({
  publication,
}: {
  readonly publication: NonNullable<PublicMigrationRunDetail['publication']>;
}): React.JSX.Element {
  const pullRequest = publication.pullRequest;
  return (
    <section className="panel publication-panel">
      <div className="patch-review-heading">
        <div>
          <p className="section-kicker">Stage 7 publication</p>
          <h2>
            {pullRequest
              ? `Draft pull request #${String(pullRequest.number)}`
              : 'Draft pull request publication'}
          </h2>
          <p>
            The platform created one deterministic branch for this run. It has no
            permission to merge the pull request.
          </p>
        </div>
        <span className={`status status-${publicationStatus(publication)}`}>
          {pullRequest
            ? pullRequest.state === 'open' && pullRequest.isDraft
              ? 'draft'
              : pullRequest.state
            : publication.status.replaceAll('_', ' ')}
        </span>
      </div>

      <div className="publication-grid">
        <div>
          <span>Base</span>
          <strong>{publication.baseBranch}</strong>
          <code>{shortSha(publication.baseCommitSha)}</code>
        </div>
        <div>
          <span>Migration branch</span>
          <strong title={publication.headBranch}>{publication.headBranch}</strong>
          {pullRequest && <code>{shortSha(pullRequest.commitSha)}</code>}
        </div>
        <div>
          <span>Reviewer notification</span>
          <strong>
            {publication.notification?.status.replaceAll('_', ' ') ?? 'not queued'}
          </strong>
          <small>
            {publication.notification?.deliveredAt
              ? new Date(publication.notification.deliveredAt).toLocaleString()
              : 'In-app delivery'}
          </small>
        </div>
      </div>

      {pullRequest && (
        <div className="publication-action">
          <a
            className="primary-button"
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
          >
            Open draft pull request
          </a>
          <small>
            GitHub state reconciled{' '}
            {new Date(pullRequest.lastReconciledAt).toLocaleString()}
          </small>
        </div>
      )}
      {publication.safeErrorCode && <code>{publication.safeErrorCode}</code>}
      {publication.notification?.safeErrorCode === 'OUTBOX_DELIVERY_FAILED' && (
        <p className="error-message">
          The reviewer notification could not be delivered. The pull request state above
          is unaffected.
        </p>
      )}
    </section>
  );
}

function publicationStatus(
  publication: NonNullable<PublicMigrationRunDetail['publication']>,
): 'running' | 'succeeded' | 'failed' | 'stale' {
  if (publication.status === 'stale') return 'stale';
  if (publication.status === 'failed' || publication.status === 'cancelled') {
    return 'failed';
  }
  if (publication.status !== 'succeeded') return 'running';
  return publication.pullRequest?.state === 'closed' ? 'failed' : 'succeeded';
}

function VerificationEvidencePanel({
  attempts,
}: {
  readonly attempts: PublicMigrationRunDetail['verificationAttempts'];
}): React.JSX.Element {
  return (
    <section className="panel patch-review">
      <div className="patch-review-heading">
        <div>
          <p className="section-kicker">Stage 6 verification</p>
          <h2>Credential-free verification evidence</h2>
          <p>
            Each attempt is bound to one immutable patch. Only a complete passed result
            is displayed as passed.
          </p>
        </div>
        <span className="dependency-count">
          {attempts.length} {attempts.length === 1 ? 'attempt' : 'attempts'} recorded
        </span>
      </div>
      <ol className="patch-attempts">
        {attempts.map(attempt => {
          const outcome = attempt.outcome ?? 'running';
          return (
            <li key={attempt.id}>
              <div>
                <strong>Verification attempt {attempt.attemptNumber}</strong>
                <span className={`status status-${verificationStatus(outcome)}`}>
                  {outcome.replaceAll('_', ' ')}
                </span>
              </div>
              <p>
                Policy <code>{attempt.policyVersion}</code>
                {attempt.completedAt
                  ? ` · completed ${new Date(attempt.completedAt).toLocaleString()}`
                  : ' · in progress'}
              </p>
              <div className="tag-row">
                {attempt.profiles.map(profile => (
                  <span className="dependency-kind" key={profile.profile}>
                    {profile.profile.replaceAll('_', ' ')} · {profile.availability}
                  </span>
                ))}
              </div>
              {attempt.commands.length > 0 && (
                <ul className="validation-checks">
                  {attempt.commands.map(command => (
                    <li key={command.commandId}>
                      <span
                        className={`validation-dot validation-${
                          command.status === 'passed' ? 'passed' : 'failed'
                        }`}
                        aria-hidden="true"
                      />
                      <code>{command.commandId}</code>
                      <strong>{command.status.replaceAll('_', ' ')}</strong>
                    </li>
                  ))}
                </ul>
              )}
              {attempt.safeErrorCode && <code>{attempt.safeErrorCode}</code>}
              {attempt.resultDigest && (
                <small title={attempt.resultDigest}>
                  Result evidence {attempt.resultDigest.slice(0, 12)}…
                </small>
              )}
            </li>
          );
        })}
      </ol>
      <p className="approval-revocation-note">
        Failed checks may trigger at most two evidence-driven repair attempts.
        Unavailable, partial, timed-out, policy-rejected, and infrastructure outcomes
        stop without being relabelled as passed.
      </p>
    </section>
  );
}

function verificationStatus(
  outcome:
    PublicMigrationRunDetail['verificationAttempts'][number]['outcome'] | 'running',
): 'running' | 'succeeded' | 'failed' {
  if (outcome === 'running') return 'running';
  return outcome === 'passed' ? 'succeeded' : 'failed';
}

function PatchReviewPanel({
  error,
  loading,
  review,
}: {
  readonly error: string | null;
  readonly loading: boolean;
  readonly review: PublicMigrationPatchReview | null;
}): React.JSX.Element {
  if (loading && !review) {
    return (
      <section className="panel patch-review">
        <p className="section-kicker">Stage 5 patch review</p>
        <h2>Loading validated patch evidence…</h2>
      </section>
    );
  }
  if (error && !review) {
    return (
      <section className="panel warning-panel">
        <p className="section-kicker">Patch review unavailable</p>
        <h2>The validated artifacts could not be displayed</h2>
        <p>{error}</p>
      </section>
    );
  }
  if (!review) return <></>;
  const selectedAttempt = review.attempts.find(attempt => attempt.selected);
  return (
    <section className="panel patch-review">
      <div className="patch-review-heading">
        <div>
          <p className="section-kicker">Stage 5 patch review</p>
          <h2>Proposed migration changes</h2>
          <p>
            Generated from commit <code>{shortSha(review.baseCommitSha)}</code>. No
            branch, commit, or remote repository file has been created.
          </p>
        </div>
        <span
          className={`status status-${review.validation.status === 'accepted' ? 'succeeded' : 'failed'}`}
        >
          {review.validation.status}
        </span>
      </div>

      <div className="patch-review-metrics">
        <div>
          <span>Changed files</span>
          <strong>{review.manifest.changedFiles}</strong>
        </div>
        <div>
          <span>Patch size</span>
          <strong>{formatBytes(review.manifest.patchBytes)}</strong>
        </div>
        <div>
          <span>Line delta</span>
          <strong>
            <ins>+{review.manifest.addedLines}</ins>{' '}
            <del>−{review.manifest.deletedLines}</del>
          </strong>
        </div>
        <div>
          <span>Remote modified</span>
          <strong>No</strong>
        </div>
      </div>

      <div className="patch-review-grid">
        <div>
          <h3>Migration plan</h3>
          <p>{review.plan.summary}</p>
          <ol className="patch-plan-files">
            {review.plan.files.map(file => (
              <li key={file.path}>
                <div>
                  <code>{file.path}</code>
                  <span>{file.changeCategory.replaceAll('_', ' ')}</span>
                </div>
                <p>{file.rationale}</p>
                <small>
                  Evidence: {file.evidenceChangeIds.join(', ')}
                  {file.transformationIds.length > 0
                    ? ` · Transformations: ${file.transformationIds.join(', ')}`
                    : ''}
                </small>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h3>Trusted validation</h3>
          <ul className="validation-checks">
            {review.validation.checks.map(check => (
              <li key={check.check}>
                <span
                  className={`validation-dot validation-${check.outcome}`}
                  aria-hidden="true"
                />
                <span>{check.check.replaceAll('_', ' ')}</span>
                <strong>{check.outcome}</strong>
              </li>
            ))}
          </ul>
          <dl className="patch-limits">
            <div>
              <dt>Files</dt>
              <dd>
                {review.manifest.changedFiles} / {review.policy.maxChangedFiles}
              </dd>
            </div>
            <div>
              <dt>Bytes</dt>
              <dd>
                {formatBytes(review.manifest.patchBytes)} /{' '}
                {formatBytes(review.policy.maxPatchBytes)}
              </dd>
            </div>
            <div>
              <dt>Added</dt>
              <dd>
                {review.manifest.addedLines} / {review.policy.maxAddedLines}
              </dd>
            </div>
            <div>
              <dt>Deleted</dt>
              <dd>
                {review.manifest.deletedLines} / {review.policy.maxDeletedLines}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      {(review.plan.unresolved.length > 0 ||
        review.plan.verificationProfiles.length > 0) && (
        <div className="patch-review-grid patch-review-notes">
          <div>
            <h3>Unresolved decisions</h3>
            {review.plan.unresolved.length === 0 ? (
              <p>None recorded by the migration agent.</p>
            ) : (
              <ul>
                {review.plan.unresolved.map(item => (
                  <li key={item.code}>
                    <strong>{item.code}</strong> — {item.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3>Suggested verification</h3>
            <div className="tag-row">
              {review.plan.verificationProfiles.map(profile => (
                <span className="dependency-kind" key={profile}>
                  {profile.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="patch-diff-heading">
        <div>
          <h3>Unified diff</h3>
          <p>
            Rendered as inert text. Repository content is never interpreted as HTML.
          </p>
        </div>
        {selectedAttempt && <span>Attempt {selectedAttempt.attemptNumber}</span>}
      </div>
      <pre className="patch-diff" tabIndex={0}>
        <code>
          {review.patch.split('\n').map((line, index) => (
            <span className={diffLineClass(line)} key={`${String(index)}:${line}`}>
              {line || ' '}
              {'\n'}
            </span>
          ))}
        </code>
      </pre>

      <div className="patch-review-grid patch-review-footer">
        <div>
          <h3>Reviewed vendor evidence</h3>
          {review.evidence.length === 0 ? (
            <p>No directly referenced vendor evidence was returned.</p>
          ) : (
            <ul className="evidence-list">
              {review.evidence.map(item => (
                <li key={item.evidenceId}>
                  <a href={item.sourceUrl} rel="noreferrer" target="_blank">
                    {item.evidenceId}
                  </a>
                  <p>{item.summary}</p>
                  <code title={item.digest}>{item.digest.slice(0, 12)}…</code>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3>Patch attempts</h3>
          <ol className="patch-attempts">
            {review.attempts.map(attempt => (
              <li key={attempt.id}>
                <div>
                  <strong>Attempt {attempt.attemptNumber}</strong>
                  {attempt.selected && <span>Displayed</span>}
                </div>
                <p>
                  {attempt.status} · {attempt.changedFiles} files ·{' '}
                  {formatBytes(attempt.patchBytes)}
                </p>
                {attempt.safeErrorCode && <code>{attempt.safeErrorCode}</code>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith('diff --git')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+') && !line.startsWith('+++')) return 'diff-added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'diff-deleted';
  return 'diff-context';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function MigrationRunHistoryPage(): React.JSX.Element {
  const { session } = useAuth();
  const { orgId } = useParams();
  const [runs, setRuns] = useState<PublicMigrationRunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId) return;
    let active = true;
    void loadMigrationRuns(session.access_token, orgId)
      .then(response => {
        if (active) setRuns(response.runs);
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
    <div className="page migration-run-history-page">
      <a className="back-link" href={`/organisations/${orgId ?? ''}/migrations`}>
        ← Migration inbox
      </a>
      <div className="migration-page-heading">
        <div>
          <p className="eyebrow">Workflow history</p>
          <h1>Migration runs and approvals.</h1>
          <p className="lede">
            The most recent 100 runs are bound to immutable approvals, repository
            commits, and persisted workflow timelines.
          </p>
        </div>
      </div>
      {loading ? (
        <section className="panel empty-state">Loading migration runs…</section>
      ) : error ? (
        <section className="panel empty-state error-message">{error}</section>
      ) : runs.length === 0 ? (
        <section className="panel empty-state">
          <h2>No migration runs</h2>
          <p>Approved migration candidates will appear here.</p>
        </section>
      ) : (
        <div className="migration-run-list">
          {runs.map(run => (
            <Link
              className="panel migration-run-row"
              key={run.id}
              to={`/organisations/${orgId ?? ''}/migration-runs/${run.id}`}
            >
              <div>
                <span className="package-pill">{run.packageName}</span>
                <h2>{run.repositoryFullName}</h2>
                <p>
                  Commit <code>{shortSha(run.baseCommitSha)}</code> · target{' '}
                  {run.targetVersion}
                </p>
              </div>
              <div className="migration-run-row-state">
                <span className={`status status-${run.status}`}>{run.status}</span>
                <small>{run.currentStage.replaceAll('_', ' ')}</small>
                <small>{new Date(run.createdAt).toLocaleString()}</small>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function migrationRunOutcome(safeErrorCode: string | null): {
  readonly kicker: string;
  readonly title: string;
  readonly body: string;
} | null {
  if (!safeErrorCode) return null;
  const outcomes: Readonly<
    Record<
      string,
      { readonly kicker: string; readonly title: string; readonly body: string }
    >
  > = {
    MIGRATION_ACQUISITION_NOT_IMPLEMENTED: {
      kicker: 'Expected Stage 4 boundary',
      title: 'Stopped before repository acquisition',
      body: 'The approval and orchestration controls worked. Stage 5 will add bounded snapshot acquisition and patch generation; this run changed no repository content.',
    },
    MIGRATION_APPROVAL_STALE: {
      kicker: 'Approval no longer current',
      title: 'The approved evidence changed',
      body: 'The run stopped because its repository, installation, specification, impact report, or approval no longer matched the immutable authorization. Review the current candidate before approving again.',
    },
    MIGRATION_APPROVAL_REVOKED: {
      kicker: 'Authorization withdrawn',
      title: 'The approval was revoked',
      body: 'The run stopped at a safe boundary after a reviewer withdrew authorization. This run changed no repository content.',
    },
    MIGRATION_REPAIR_BUDGET_EXHAUSTED: {
      kicker: 'Bounded workflow stopped',
      title: 'The repair limit was reached',
      body: 'The workflow stopped rather than continuing with unbounded repair attempts. Review the persisted evidence before starting another run.',
    },
  };
  return (
    outcomes[safeErrorCode] ?? {
      kicker: 'Workflow stopped safely',
      title: 'The migration could not continue',
      body: 'The control plane stopped this run without exposing internal error details. Use the request and run identifiers when reviewing operator logs.',
    }
  );
}

function migrationRunEventLabel(
  eventType: PublicMigrationRunDetail['events'][number]['eventType'],
): string {
  const labels: Record<
    PublicMigrationRunDetail['events'][number]['eventType'],
    string
  > = {
    run_requested: 'Run requested',
    approval_validated: 'Approval revalidated',
    stage_entered: 'Stage entered',
    source_acquired: 'Exact source snapshot acquired',
    cancellation_requested: 'Cancellation requested',
    run_cancelled: 'Run cancelled',
    run_failed: 'Run stopped',
    run_stale: 'Approval became stale',
    run_completed: 'Run completed',
    plan_created: 'Migration plan created',
    patch_proposed: 'Patch proposed',
    patch_validated: 'Patch validated',
    verification_prepared: 'Verification evidence bound',
    verification_started: 'Verification started',
    verification_completed: 'Verification completed',
    repair_requested: 'Bounded repair requested',
    publication_prepared: 'Publication evidence bound',
    publication_started: 'Draft pull request publication started',
    publication_reconciled: 'Draft pull request reconciled',
    notification_queued: 'Publication notification queued',
  };
  return labels[eventType];
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

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function packageSourceMappingStatusLabel(
  status: PublicPackageSourceMapping['status'],
): string {
  const labels: Record<typeof status, string> = {
    needs_review: 'To review',
    mapped: 'Monitoring',
    rejected: 'No source',
    disabled: 'Paused',
  };
  return labels[status];
}

function packageSourceReviewCopy(kind: PublicPackageSourceCandidate['sourceKind']): {
  readonly step: string;
  readonly title: string;
  readonly description: string;
} {
  const copy: Partial<
    Record<
      PublicPackageSourceCandidate['sourceKind'],
      { readonly step: string; readonly title: string; readonly description: string }
    >
  > = {
    package_registry_release: {
      step: '1 · Detect updates',
      title: 'npm version feed',
      description: 'Tells Upversion when this package publishes a new version.',
    },
    changelog: {
      step: '2 · Understand changes',
      title: 'Official changelog',
      description: 'Explains breaking changes and relevant release differences.',
    },
    migration_guide: {
      step: '3 · Apply the upgrade',
      title: 'Official migration guide',
      description: 'Provides the concrete steps needed to update application code.',
    },
    release_feed: {
      step: 'Fallback · Release notes',
      title: 'Official release page',
      description: 'Use when the package does not publish a useful changelog.',
    },
    sdk_repository_release: {
      step: 'Fallback · Project source',
      title: 'Official source repository',
      description: 'Use to locate package-owned upgrade documentation.',
    },
  };
  return (
    copy[kind] ?? {
      step: 'Migration source',
      title: 'Official package guidance',
      description: 'Provides package-owned evidence for the migration.',
    }
  );
}

function packageSourceDisplayUrl(value: string): {
  readonly hostname: string;
  readonly path: string;
} {
  try {
    const url = new URL(value);
    let path = url.pathname || '/';
    try {
      path = decodeURIComponent(path);
    } catch {
      // The canonical URL remains authoritative when its path is not decodable.
    }
    return { hostname: url.hostname, path };
  } catch {
    return { hostname: 'Source URL', path: value };
  }
}
