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
  PublicDependencyObservation,
  PublicGithubInstallation,
  PublicMigrationCandidate,
  PublicMigrationCandidateDetail,
  PublicMigrationApprovalResult,
  PublicMigrationPatchReview,
  PublicMigrationRunDetail,
  PublicMigrationRunSummary,
  PublicPackageSourceCandidate,
  PublicPackageSourceCatalogEntry,
  PublicPackageSourceMapping,
  PublicPackageSourceVendor,
  PublicOrganisation,
  PublicPublicationNotification,
  PublicRepository,
} from '@migration/contracts';

import {
  ApiError,
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
  loadMigrationRun,
  loadMigrationPatchReview,
  loadMigrationRuns,
  loadPackageSourceMappings,
  loadPackageSourceCatalog,
  loadPublicationNotifications,
  loadRepositories,
  loadRun,
  requestImpactAnalysis,
  reviewPackageSourceCandidate,
  replacePackageSourceCandidate,
  revokeMigrationApproval,
  startRepositoryScan,
  setPackageSourceMappingState,
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
        <Route path="/operator/package-sources" element={<PackageSourceReviewPage />} />
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
        <Link className="operator-link" to="/operator/package-sources">
          Review package source candidates
        </Link>
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

type PackageSourceQueueStatus = 'needs_review' | 'mapped' | 'rejected' | 'disabled';

function PackageSourceReviewPage(): React.JSX.Element {
  const { session } = useAuth();
  const [status, setStatus] = useState<PackageSourceQueueStatus>('needs_review');
  const [mappings, setMappings] = useState<PublicPackageSourceMapping[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<
    PublicPackageSourceCatalogEntry[]
  >([]);
  const [catalogVendors, setCatalogVendors] = useState<PublicPackageSourceVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!session) return;
    let active = true;
    void Promise.all([
      loadPackageSourceMappings(session.access_token, status),
      loadPackageSourceCatalog(session.access_token),
    ])
      .then(([mappingData, catalogData]) => {
        if (active) {
          setMappings(mappingData.mappings);
          setCatalogProducts(catalogData.products);
          setCatalogVendors(catalogData.vendors);
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
      <h1>Package source review</h1>
      <p className="lede">
        Promote only evidence that you have independently verified as an official
        package registry or SDK repository source. Approval trusts the exact URL shown.
      </p>
      <div className="queue-filters" aria-label="Package source queue filters">
        {(['needs_review', 'mapped', 'rejected', 'disabled'] as const).map(value => (
          <button
            className={status === value ? 'primary-button' : 'secondary-button'}
            key={value}
            type="button"
            onClick={() => {
              if (value === status) return;
              setLoading(true);
              setError(null);
              setStatus(value);
            }}
          >
            {value.replace('_', ' ')}
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
            catalogProducts={catalogProducts}
            catalogVendors={catalogVendors}
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
  catalogProducts,
  catalogVendors,
  onReviewed,
}: {
  readonly mapping: PublicPackageSourceMapping;
  readonly token: string;
  readonly catalogProducts: readonly PublicPackageSourceCatalogEntry[];
  readonly catalogVendors: readonly PublicPackageSourceVendor[];
  readonly onReviewed: () => void;
}): React.JSX.Element {
  const [catalogMode, setCatalogMode] = useState<
    'existing_product' | 'existing_vendor' | 'new_vendor'
  >(mapping.apiProductId ? 'existing_product' : 'new_vendor');
  const [selectedProductId, setSelectedProductId] = useState(
    mapping.apiProductId ?? '',
  );
  const [selectedVendorId, setSelectedVendorId] = useState(mapping.vendorId ?? '');
  const [vendorSlug, setVendorSlug] = useState(mapping.vendorSlug ?? '');
  const [vendorName, setVendorName] = useState(mapping.vendorName ?? '');
  const [officialDomains, setOfficialDomains] = useState('');
  const [approveCandidateDomain, setApproveCandidateDomain] = useState(false);
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(86_400);
  const [rejectionReasonCode, setRejectionReasonCode] = useState<
    'NOT_OFFICIAL' | 'DUPLICATE' | 'UNSUPPORTED_SOURCE'
  >('NOT_OFFICIAL');
  const [busyOperation, setBusyOperation] = useState<{
    readonly targetId: string;
    readonly action: 'approve' | 'reject' | 'replace' | 'mapping';
  } | null>(null);
  const [replacementKind, setReplacementKind] = useState<
    'sdk_repository_release' | 'changelog' | 'release_feed' | 'migration_guide'
  >('sdk_repository_release');
  const [replacementUrl, setReplacementUrl] = useState('');
  const [replacementNote, setReplacementNote] = useState('');
  const [disabledReasonCode, setDisabledReasonCode] = useState<
    'OPERATOR_DISABLED' | 'PACKAGE_UNSUPPORTED' | 'SECURITY_CONCERN'
  >('OPERATOR_DISABLED');
  const [error, setError] = useState<string | null>(null);
  const selectedCatalogDomains =
    catalogMode === 'existing_product'
      ? catalogProducts.find(product => product.apiProductId === selectedProductId)
          ?.officialDomains
      : catalogMode === 'existing_vendor'
        ? catalogVendors.find(vendor => vendor.vendorId === selectedVendorId)
            ?.officialDomains
        : undefined;

  async function review(
    candidate: PublicPackageSourceCandidate,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    setBusyOperation({ targetId: candidate.id, action: decision });
    setError(null);
    try {
      await reviewPackageSourceCandidate(
        token,
        candidate.id,
        crypto.randomUUID(),
        decision === 'approve'
          ? {
              decision,
              expectedCandidateVersion: candidate.version,
              expectedMappingVersion: mapping.version,
              catalog:
                catalogMode === 'existing_product'
                  ? { mode: catalogMode, apiProductId: selectedProductId }
                  : catalogMode === 'existing_vendor'
                    ? { mode: catalogMode, vendorId: selectedVendorId }
                    : {
                        mode: catalogMode,
                        vendorSlug,
                        vendorName,
                        officialDomains: officialDomains
                          .split(',')
                          .map(value => value.trim().toLowerCase())
                          .filter(Boolean),
                      },
              approveCandidateDomain:
                candidate.sourceKind === 'package_registry_release'
                  ? false
                  : approveCandidateDomain,
              pollIntervalSeconds,
            }
          : {
              decision,
              expectedCandidateVersion: candidate.version,
              expectedMappingVersion: mapping.version,
              rejectionReasonCode,
            },
      );
      onReviewed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
  }

  async function replace(candidate: PublicPackageSourceCandidate): Promise<void> {
    setBusyOperation({ targetId: candidate.id, action: 'replace' });
    setError(null);
    try {
      await replacePackageSourceCandidate(token, candidate.id, crypto.randomUUID(), {
        expectedCandidateVersion: candidate.version,
        expectedMappingVersion: mapping.version,
        sourceKind: replacementKind,
        canonicalUrl: replacementUrl,
        proposalNote: replacementNote,
      });
      onReviewed();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusyOperation(null);
    }
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

  return (
    <article className="panel package-source-card">
      <header>
        <div>
          <span className="eyebrow">{mapping.status.replace('_', ' ')}</span>
          <h2>{mapping.packageName}</h2>
        </div>
        <div className="mapping-state-controls">
          <code>v{mapping.version}</code>
          {mapping.status !== 'disabled' && (
            <select
              aria-label="Disable reason"
              value={disabledReasonCode}
              onChange={event =>
                setDisabledReasonCode(event.target.value as typeof disabledReasonCode)
              }
            >
              <option value="OPERATOR_DISABLED">Operator disabled</option>
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
              ? 'Updating mapping…'
              : mapping.status === 'disabled'
                ? 'Enable mapping'
                : 'Disable mapping'}
          </button>
        </div>
      </header>
      <dl className="package-source-metadata">
        <div>
          <dt>Latest npm version</dt>
          <dd>{mapping.latestVersion ?? 'Unknown'}</dd>
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
          <dt>Registry evidence retrieved</dt>
          <dd>
            {mapping.resolvedAt ? formatTimestamp(mapping.resolvedAt) : 'Unknown'}
          </dd>
        </div>
        <div>
          <dt>npm package page</dt>
          <dd>
            <a
              href={`https://www.npmjs.com/package/${mapping.packageName}`}
              target="_blank"
              rel="noreferrer"
            >
              View package
            </a>
          </dd>
        </div>
        <div>
          <dt>Repositories using package</dt>
          <dd>
            {mapping.repositoryUsage.total} total · {mapping.repositoryUsage.direct}{' '}
            direct · {mapping.repositoryUsage.development} development ·{' '}
            {mapping.repositoryUsage.optional} optional · {mapping.repositoryUsage.peer}{' '}
            peer
          </dd>
        </div>
        {mapping.status === 'disabled' && (
          <div>
            <dt>Disabled</dt>
            <dd>
              {mapping.disabledReasonCode?.replaceAll('_', ' ').toLowerCase()} ·{' '}
              {mapping.disabledAt
                ? formatTimestamp(mapping.disabledAt)
                : 'Unknown time'}
            </dd>
          </div>
        )}
      </dl>
      <div className="source-coverage" aria-label="Proposed source coverage">
        {(
          [
            ['package_registry_release', 'npm registry'],
            ['sdk_repository_release', 'repository'],
            ['changelog', 'changelog'],
            ['release_feed', 'release feed'],
            ['migration_guide', 'migration documentation'],
          ] as const
        ).map(([sourceKind, label]) => (
          <span key={sourceKind}>
            {label}:{' '}
            {mapping.candidates.some(candidate => candidate.sourceKind === sourceKind)
              ? 'proposed'
              : 'not proposed'}
          </span>
        ))}
      </div>
      {mapping.status !== 'disabled' &&
        mapping.candidates.some(
          candidate => candidate.reviewState === 'pending_review',
        ) && (
          <div className="package-source-vendor-fields">
            <label>
              Catalog binding
              <select
                value={catalogMode}
                onChange={event =>
                  setCatalogMode(event.target.value as typeof catalogMode)
                }
              >
                <option value="new_vendor">Create vendor and product</option>
                <option value="existing_vendor">Existing vendor, new product</option>
                <option value="existing_product">Existing product</option>
              </select>
            </label>
            {catalogMode === 'existing_product' && (
              <label>
                Existing API product
                <select
                  required
                  value={selectedProductId}
                  onChange={event => setSelectedProductId(event.target.value)}
                >
                  <option value="">Select product</option>
                  {catalogProducts
                    .filter(
                      product =>
                        product.packageName === mapping.packageName &&
                        product.productStatus === 'active' &&
                        product.vendorTrustState !== 'disabled',
                    )
                    .map(product => (
                      <option key={product.apiProductId} value={product.apiProductId}>
                        {product.vendorName} · {product.packageName}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {catalogMode === 'existing_vendor' && (
              <label>
                Existing vendor
                <select
                  required
                  value={selectedVendorId}
                  onChange={event => setSelectedVendorId(event.target.value)}
                >
                  <option value="">Select vendor</option>
                  {catalogVendors
                    .filter(vendor => vendor.vendorTrustState !== 'disabled')
                    .map(vendor => (
                      <option key={vendor.vendorId} value={vendor.vendorId}>
                        {vendor.vendorName} · {vendor.vendorSlug}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {catalogMode === 'new_vendor' && (
              <>
                <label>
                  Vendor slug
                  <input
                    required
                    pattern="[a-z][a-z0-9-]{1,62}"
                    value={vendorSlug}
                    onChange={event => setVendorSlug(event.target.value)}
                  />
                </label>
                <label>
                  Official vendor domains
                  <input
                    required
                    placeholder="vendor.example, docs.vendor.example"
                    value={officialDomains}
                    onChange={event => setOfficialDomains(event.target.value)}
                  />
                </label>
              </>
            )}
            {selectedCatalogDomains && (
              <p className="catalog-domain-summary">
                Approved domains: {selectedCatalogDomains.join(', ')}
              </p>
            )}
            {catalogMode === 'new_vendor' && (
              <label>
                Vendor name
                <input
                  required
                  maxLength={120}
                  value={vendorName}
                  onChange={event => setVendorName(event.target.value)}
                />
              </label>
            )}
            <label>
              Poll interval (seconds)
              <input
                required
                type="number"
                min={3600}
                max={2592000}
                value={pollIntervalSeconds}
                onChange={event => setPollIntervalSeconds(Number(event.target.value))}
              />
            </label>
            <label>
              Rejection reason
              <select
                value={rejectionReasonCode}
                onChange={event =>
                  setRejectionReasonCode(
                    event.target.value as typeof rejectionReasonCode,
                  )
                }
              >
                <option value="NOT_OFFICIAL">Not official</option>
                <option value="DUPLICATE">Duplicate</option>
                <option value="UNSUPPORTED_SOURCE">Unsupported source</option>
              </select>
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={approveCandidateDomain}
                onChange={event => setApproveCandidateDomain(event.target.checked)}
              />
              Explicitly add the candidate domain to the selected vendor
            </label>
          </div>
        )}
      <div className="package-source-candidates">
        {mapping.candidates.map(candidate => (
          <section key={candidate.id}>
            <div>
              <strong>{candidate.sourceKind.replaceAll('_', ' ')}</strong>
              <span>{candidate.reviewState.replace('_', ' ')}</span>
            </div>
            <a href={candidate.canonicalUrl} target="_blank" rel="noreferrer">
              {candidate.canonicalUrl}
            </a>
            <p className="fine-print">
              Proposed because:{' '}
              {packageSourceProposalText(candidate.proposalReasonCode)}
              {candidate.proposalNote ? ` · ${candidate.proposalNote}` : ''}
            </p>
            {candidate.reviewState === 'pending_review' &&
              mapping.status !== 'disabled' && (
                <div className="review-actions">
                  <button
                    className="review-decision-button"
                    type="button"
                    disabled={
                      !candidate.canPromote ||
                      busyOperation !== null ||
                      (catalogMode === 'existing_product' && !selectedProductId) ||
                      (catalogMode === 'existing_vendor' && !selectedVendorId) ||
                      (catalogMode === 'new_vendor' &&
                        (!vendorSlug || !vendorName || !officialDomains.trim()))
                    }
                    aria-busy={
                      busyOperation?.targetId === candidate.id &&
                      busyOperation.action === 'approve'
                    }
                    onClick={() => void review(candidate, 'approve')}
                  >
                    {busyOperation?.targetId === candidate.id &&
                    busyOperation.action === 'approve'
                      ? 'Approving…'
                      : 'Approve exact source'}
                  </button>
                  <button
                    className="review-decision-button"
                    type="button"
                    disabled={busyOperation !== null}
                    aria-busy={
                      busyOperation?.targetId === candidate.id &&
                      busyOperation.action === 'reject'
                    }
                    onClick={() => void review(candidate, 'reject')}
                  >
                    {busyOperation?.targetId === candidate.id &&
                    busyOperation.action === 'reject'
                      ? 'Rejecting…'
                      : 'Reject'}
                  </button>
                  {candidate.sourceKind !== 'package_registry_release' && (
                    <div className="replacement-controls">
                      <select
                        aria-label="Replacement source type"
                        value={replacementKind}
                        onChange={event =>
                          setReplacementKind(
                            event.target.value as typeof replacementKind,
                          )
                        }
                      >
                        <option value="sdk_repository_release">SDK repository</option>
                        <option value="changelog">Changelog</option>
                        <option value="release_feed">Release feed</option>
                        <option value="migration_guide">Migration documentation</option>
                      </select>
                      <input
                        aria-label="Replacement URL"
                        type="url"
                        placeholder="https://vendor.example/releases"
                        value={replacementUrl}
                        onChange={event => setReplacementUrl(event.target.value)}
                      />
                      <input
                        aria-label="Replacement reason"
                        maxLength={500}
                        placeholder="Why this is the official replacement"
                        value={replacementNote}
                        onChange={event => setReplacementNote(event.target.value)}
                      />
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={
                          busyOperation !== null ||
                          !replacementUrl ||
                          !replacementNote.trim()
                        }
                        aria-busy={
                          busyOperation?.targetId === candidate.id &&
                          busyOperation.action === 'replace'
                        }
                        onClick={() => void replace(candidate)}
                      >
                        {busyOperation?.targetId === candidate.id &&
                        busyOperation.action === 'replace'
                          ? 'Replacing…'
                          : 'Replace candidate'}
                      </button>
                    </div>
                  )}
                </div>
              )}
          </section>
        ))}
      </div>
      {error && <p className="error-message">{error}</p>}
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session || !orgId) return;
    let active = true;
    void Promise.all([
      loadMigrationCandidates(session.access_token, orgId),
      loadPublicationNotifications(session.access_token, orgId),
    ])
      .then(([candidateData, notificationData]) => {
        if (active) {
          setCandidates(candidateData.candidates);
          setNotifications(notificationData.notifications);
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

function packageSourceProposalText(
  code: PublicPackageSourceCandidate['proposalReasonCode'],
): string {
  const descriptions: Record<typeof code, string> = {
    NPM_REGISTRY_AUTHORITATIVE: 'the fixed-origin npm registry supplied version data',
    NPM_REPOSITORY_DECLARATION: 'npm metadata declared this repository',
    NPM_HOMEPAGE_DECLARATION: 'npm metadata declared this homepage',
    NPM_BUGS_DECLARATION: 'npm metadata declared this issue tracker',
    OPERATOR_REPLACEMENT: 'a platform operator proposed a reviewed replacement',
  };
  return descriptions[code];
}
