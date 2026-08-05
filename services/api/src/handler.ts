import { createHash, randomUUID } from 'node:crypto';

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';

import {
  bearerToken,
  createTokenVerifier,
  type TokenVerifier,
} from '@migration/authorization';
import {
  agentResultEnvelopeSchema,
  candidateNotificationStateRequestSchema,
  cancelMigrationRunRequestSchema,
  createMigrationApprovalRequestSchema,
  demoRunRequestSchema,
  githubInstallLinkRequestSchema,
  githubInstallationVerificationSchema,
  githubSetupCompletionRequestSchema,
  impactAnalysisWorkflowInputSchema,
  migrationSpecificationReviewRequestSchema,
  packageReleasePilotBackfillRequestSchema,
  packageSourceCandidateReviewRequestSchema,
  packageSourceCandidateReplacementRequestSchema,
  packageSourceMappingStateRequestSchema,
  repositoryScanRequestSchema,
  revokeMigrationApprovalRequestSchema,
  type GithubInstallationVerification,
  type MigrationPlan,
  type PublicAgentRun,
} from '@migration/contracts';
import { apiConfigSchema, parseConfig, type ApiConfig } from '@migration/config';
import { createDatabase } from '@migration/database';
import { DomainError, requireIdempotencyKey } from '@migration/domain';
import { safeErrorCode, writeLog } from '@migration/observability';

import {
  ApiRepository,
  type AgentRunRecord,
  type ApiRepositoryPort,
} from './repository.js';
import { loadPublicMigrationPatchReview } from './patch-review.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
type JsonResponse = Exclude<APIGatewayProxyResultV2, string>;

const organisationBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/u),
  })
  .strict();

export interface ApiDependencies {
  readonly config: ApiConfig;
  readonly repository: ApiRepositoryPort;
  readonly tokenVerifier: TokenVerifier;
  readonly installationVerifier: GithubInstallationVerifier;
  readonly s3: S3Client;
  readonly stepFunctions: WorkflowStarter;
}

export interface GithubInstallationVerifier {
  verify(installationId: string): Promise<GithubInstallationVerification>;
}

interface LambdaInvoker {
  send(command: InvokeCommand): Promise<{
    readonly FunctionError?: string;
    readonly Payload?: Uint8Array;
  }>;
}

export interface WorkflowStarter {
  send(command: StartExecutionCommand): Promise<unknown>;
}

let cachedDependencies: ApiDependencies | undefined;

async function dependencies(): Promise<ApiDependencies> {
  if (cachedDependencies) {
    return cachedDependencies;
  }
  const config = parseConfig(apiConfigSchema);
  const database = await createDatabase(config.AWS_REGION, config.DATABASE_SECRET_ARN);
  const lambda = new LambdaClient({ region: config.AWS_REGION });
  cachedDependencies = {
    config,
    repository: new ApiRepository(database),
    tokenVerifier: createTokenVerifier({
      audience: config.SUPABASE_JWT_AUDIENCE,
      issuer: config.SUPABASE_JWT_ISSUER,
      jwksUrl: config.SUPABASE_JWKS_URL,
    }),
    installationVerifier: createGithubInstallationVerifier(
      lambda,
      config.GITHUB_TOKEN_BROKER_FUNCTION_NAME,
    ),
    s3: new S3Client({ region: config.AWS_REGION }),
    stepFunctions: new SFNClient({ region: config.AWS_REGION }),
  };
  return cachedDependencies;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  return handleRequest(event, await dependencies());
}

export async function handleRequest(
  event: APIGatewayProxyEventV2,
  dependency: ApiDependencies,
): Promise<JsonResponse> {
  const started = Date.now();
  const requestId = requestIdentifier(event.requestContext.requestId);
  try {
    const actor = await dependency.tokenVerifier.verify(
      bearerToken(event.headers.authorization),
    );
    const repository = dependency.repository;
    const userId = await repository.ensureUser(actor);
    const method = event.requestContext.http.method;
    const path = normalizePath(event.rawPath);

    let response: JsonResponse;
    if (method === 'GET' && path === '/v1/me') {
      response = json(200, {
        user: { id: userId },
        organisations: await repository.listOrganisations(userId),
        operator: {
          hasAccess: await repository.hasPlatformOperatorAccess(userId),
        },
      });
    } else if (method === 'GET' && path === '/v1/organisations') {
      response = json(200, {
        organisations: await repository.listOrganisations(userId),
      });
    } else if (method === 'POST' && path === '/v1/organisations') {
      const input = organisationBodySchema.parse(parseBody(event));
      const organisation = await repository.createOrganisation(userId, {
        ...input,
        requestId,
      });
      response = json(201, { organisation });
    } else {
      const createMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/demo-runs$/u.exec(path)
          : null;
      const readMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/runs\/([0-9a-f-]{36})$/u.exec(path)
          : null;
      const installationsMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/github\/installations$/u.exec(path)
          : null;
      const installLinkMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/github\/install-link$/u.exec(path)
          : null;
      const repositoriesMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/repositories$/u.exec(path)
          : null;
      const dependenciesMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/repositories\/([0-9a-f-]{36})\/dependencies$/u.exec(
              path,
            )
          : null;
      const scanMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/repositories\/([0-9a-f-]{36})\/scans$/u.exec(
              path,
            )
          : null;
      const candidatesMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-candidates$/u.exec(path)
          : null;
      const candidateMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-candidates\/([0-9a-f-]{36})$/u.exec(
              path,
            )
          : null;
      const impactAnalysisMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-candidates\/([0-9a-f-]{36})\/impact-analysis$/u.exec(
              path,
            )
          : null;
      const approveCandidateMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-candidates\/([0-9a-f-]{36})\/approvals$/u.exec(
              path,
            )
          : null;
      const migrationRunMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-runs\/([0-9a-f-]{36})$/u.exec(
              path,
            )
          : null;
      const migrationPatchReviewMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-runs\/([0-9a-f-]{36})\/patch-review$/u.exec(
              path,
            )
          : null;
      const migrationRunsMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-runs$/u.exec(path)
          : null;
      const publicationNotificationsMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/notifications$/u.exec(path)
          : null;
      const candidateNotificationsMatch =
        method === 'GET'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/dependency-notifications$/u.exec(
              path,
            )
          : null;
      const candidateNotificationStateMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/dependency-notifications\/([0-9a-f-]{36})\/state$/u.exec(
              path,
            )
          : null;
      const cancelMigrationRunMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-runs\/([0-9a-f-]{36})\/cancellation$/u.exec(
              path,
            )
          : null;
      const revokeMigrationApprovalMatch =
        method === 'POST'
          ? /^\/v1\/organisations\/([0-9a-f-]{36})\/migration-runs\/([0-9a-f-]{36})\/approval-revocation$/u.exec(
              path,
            )
          : null;
      const reviewSpecificationMatch =
        method === 'POST'
          ? /^\/v1\/operator\/migration-specifications\/([0-9a-f-]{36})\/review$/u.exec(
              path,
            )
          : null;
      const operatorSpecificationMatch =
        method === 'GET'
          ? /^\/v1\/operator\/migration-specifications\/([0-9a-f-]{36})$/u.exec(path)
          : null;
      const packageSourceReviewMatch =
        method === 'POST'
          ? /^\/v1\/operator\/package-source-candidates\/([0-9a-f-]{36})\/review$/u.exec(
              path,
            )
          : null;
      const packageSourceReplacementMatch =
        method === 'POST'
          ? /^\/v1\/operator\/package-source-candidates\/([0-9a-f-]{36})\/replacement$/u.exec(
              path,
            )
          : null;
      const packageSourceMappingStateMatch =
        method === 'POST'
          ? /^\/v1\/operator\/package-source-mappings\/([0-9a-f-]{36})\/state$/u.exec(
              path,
            )
          : null;
      const packageReleasePilotBackfillMatch =
        method === 'POST'
          ? /^\/v1\/operator\/package-source-mappings\/([0-9a-f-]{36})\/pilot-backfill$/u.exec(
              path,
            )
          : null;
      if (method === 'POST' && path === '/v1/github/setup/callback') {
        const input = githubSetupCompletionRequestSchema.parse(parseBody(event));
        await repository.validateGithubInstallState(userId, input.state);
        const verified = await dependency.installationVerifier.verify(
          input.installationId,
        );
        response = json(
          200,
          await repository.completeGithubInstallation(userId, {
            ...input,
            requestId,
            verified,
          }),
        );
      } else if (installLinkMatch?.[1]) {
        githubInstallLinkRequestSchema.parse(parseBody(event));
        const organisationId = z.uuid().parse(installLinkMatch[1]);
        const link = await repository.createGithubInstallLink(userId, organisationId);
        response = json(201, {
          installLink: {
            installationUrl: githubInstallationUrl(
              dependency.config.GITHUB_APP_SLUG,
              link.state,
            ),
            expiresAt: link.expiresAt.toISOString(),
          },
        });
      } else if (installationsMatch?.[1]) {
        const organisationId = z.uuid().parse(installationsMatch[1]);
        response = json(200, {
          installations: await repository.listGithubInstallations(
            userId,
            organisationId,
          ),
        });
      } else if (repositoriesMatch?.[1]) {
        const organisationId = z.uuid().parse(repositoriesMatch[1]);
        response = json(200, {
          repositories: await repository.listRepositories(userId, organisationId),
        });
      } else if (dependenciesMatch?.[1] && dependenciesMatch[2]) {
        const organisationId = z.uuid().parse(dependenciesMatch[1]);
        const repositoryId = z.uuid().parse(dependenciesMatch[2]);
        response = json(200, {
          dependencies: await repository.listDependencies(
            userId,
            organisationId,
            repositoryId,
          ),
        });
      } else if (scanMatch?.[1] && scanMatch[2]) {
        repositoryScanRequestSchema.parse(parseBody(event));
        const scan = await repository.createRepositoryScan(userId, {
          organisationId: z.uuid().parse(scanMatch[1]),
          repositoryId: z.uuid().parse(scanMatch[2]),
          idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
          requestId,
        });
        response = json(202, { scan });
      } else if (method === 'GET' && path === '/v1/operator/package-source-mappings') {
        const status = z
          .enum(['needs_review', 'mapped', 'rejected', 'disabled'])
          .default('needs_review')
          .parse(event.queryStringParameters?.status);
        response = json(200, {
          mappings: await repository.listPackageSourceMappings(userId, status),
        });
      } else if (packageSourceReviewMatch?.[1]) {
        const input = packageSourceCandidateReviewRequestSchema.parse(parseBody(event));
        response = json(200, {
          review: await repository.reviewPackageSourceCandidate(userId, {
            ...input,
            candidateId: z.uuid().parse(packageSourceReviewMatch[1]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (packageSourceReplacementMatch?.[1]) {
        const input = packageSourceCandidateReplacementRequestSchema.parse(
          parseBody(event),
        );
        response = json(201, {
          review: await repository.replacePackageSourceCandidate(userId, {
            ...input,
            candidateId: z.uuid().parse(packageSourceReplacementMatch[1]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (packageSourceMappingStateMatch?.[1]) {
        const input = packageSourceMappingStateRequestSchema.parse(parseBody(event));
        response = json(200, {
          review: await repository.setPackageSourceMappingState(userId, {
            ...input,
            mappingId: z.uuid().parse(packageSourceMappingStateMatch[1]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (packageReleasePilotBackfillMatch?.[1]) {
        const input = packageReleasePilotBackfillRequestSchema.parse(parseBody(event));
        response = json(202, {
          backfill: await repository.requestPackageReleasePilotBackfill(userId, {
            mappingId: z.uuid().parse(packageReleasePilotBackfillMatch[1]),
            expectedMappingVersion: input.expectedMappingVersion,
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (method === 'GET' && path === '/v1/operator/package-source-catalog') {
        response = json(200, await repository.listPackageSourceCatalog(userId));
      } else if (method === 'GET' && path === '/v1/operator/migration-specifications') {
        const trustState = z
          .enum(['draft', 'reviewed', 'vendor_verified'])
          .default('draft')
          .parse(event.queryStringParameters?.trustState);
        response = json(200, {
          specifications: await repository.listMigrationSpecifications(
            userId,
            trustState,
          ),
        });
      } else if (reviewSpecificationMatch?.[1]) {
        const input = migrationSpecificationReviewRequestSchema.parse(parseBody(event));
        response = json(200, {
          review: await repository.reviewMigrationSpecification(userId, {
            specificationId: z.uuid().parse(reviewSpecificationMatch[1]),
            expectedRevision: input.expectedRevision,
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (operatorSpecificationMatch?.[1]) {
        response = json(200, {
          specification: await repository.getMigrationSpecification(
            userId,
            z.uuid().parse(operatorSpecificationMatch[1]),
          ),
        });
      } else if (candidatesMatch?.[1]) {
        const organisationId = z.uuid().parse(candidatesMatch[1]);
        response = json(200, {
          candidates: await repository.listMigrationCandidates(userId, organisationId),
        });
      } else if (candidateMatch?.[1] && candidateMatch[2]) {
        const organisationId = z.uuid().parse(candidateMatch[1]);
        response = json(200, {
          candidate: await repository.getMigrationCandidate(
            userId,
            organisationId,
            z.uuid().parse(candidateMatch[2]),
          ),
        });
      } else if (impactAnalysisMatch?.[1] && impactAnalysisMatch[2]) {
        repositoryScanRequestSchema.parse(parseBody(event));
        const analysis = await repository.requestImpactAnalysis(userId, {
          organisationId: z.uuid().parse(impactAnalysisMatch[1]),
          candidateId: z.uuid().parse(impactAnalysisMatch[2]),
          idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
          requestId,
        });
        await startImpactAnalysis(
          dependency.stepFunctions,
          dependency.config.IMPACT_ANALYSIS_STATE_MACHINE_ARN,
          analysis,
        );
        response = json(202, { analysis });
      } else if (approveCandidateMatch?.[1] && approveCandidateMatch[2]) {
        const input = createMigrationApprovalRequestSchema.parse(parseBody(event));
        response = json(
          202,
          await repository.createMigrationApproval(userId, {
            ...input,
            organisationId: z.uuid().parse(approveCandidateMatch[1]),
            candidateId: z.uuid().parse(approveCandidateMatch[2]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        );
      } else if (migrationPatchReviewMatch?.[1] && migrationPatchReviewMatch[2]) {
        const reviewRecord = await repository.getMigrationPatchReview(
          userId,
          z.uuid().parse(migrationPatchReviewMatch[1]),
          z.uuid().parse(migrationPatchReviewMatch[2]),
        );
        response = json(200, {
          patchReview:
            reviewRecord === null
              ? null
              : await loadPublicMigrationPatchReview(
                  dependency.s3,
                  dependency.config.ARTIFACT_BUCKET,
                  dependency.config.APP_ENVIRONMENT,
                  reviewRecord,
                ),
        });
      } else if (migrationRunMatch?.[1] && migrationRunMatch[2]) {
        response = json(200, {
          run: await repository.getMigrationRun(
            userId,
            z.uuid().parse(migrationRunMatch[1]),
            z.uuid().parse(migrationRunMatch[2]),
          ),
        });
      } else if (migrationRunsMatch?.[1]) {
        response = json(200, {
          runs: await repository.listMigrationRuns(
            userId,
            z.uuid().parse(migrationRunsMatch[1]),
          ),
        });
      } else if (publicationNotificationsMatch?.[1]) {
        response = json(200, {
          notifications: await repository.listPublicationNotifications(
            userId,
            z.uuid().parse(publicationNotificationsMatch[1]),
          ),
        });
      } else if (candidateNotificationsMatch?.[1]) {
        response = json(200, {
          notifications: await repository.listCandidateNotifications(
            userId,
            z.uuid().parse(candidateNotificationsMatch[1]),
          ),
        });
      } else if (
        candidateNotificationStateMatch?.[1] &&
        candidateNotificationStateMatch[2]
      ) {
        const input = candidateNotificationStateRequestSchema.parse(parseBody(event));
        response = json(200, {
          state: await repository.updateCandidateNotificationState(userId, {
            ...input,
            organisationId: z.uuid().parse(candidateNotificationStateMatch[1]),
            notificationId: z.uuid().parse(candidateNotificationStateMatch[2]),
            requestId,
          }),
        });
      } else if (cancelMigrationRunMatch?.[1] && cancelMigrationRunMatch[2]) {
        const input = cancelMigrationRunRequestSchema.parse(parseBody(event));
        response = json(202, {
          run: await repository.cancelMigrationRun(userId, {
            ...input,
            organisationId: z.uuid().parse(cancelMigrationRunMatch[1]),
            migrationRunId: z.uuid().parse(cancelMigrationRunMatch[2]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (revokeMigrationApprovalMatch?.[1] && revokeMigrationApprovalMatch[2]) {
        const input = revokeMigrationApprovalRequestSchema.parse(parseBody(event));
        response = json(202, {
          run: await repository.revokeMigrationApproval(userId, {
            ...input,
            organisationId: z.uuid().parse(revokeMigrationApprovalMatch[1]),
            migrationRunId: z.uuid().parse(revokeMigrationApprovalMatch[2]),
            idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
            requestId,
          }),
        });
      } else if (createMatch?.[1]) {
        const input = demoRunRequestSchema.parse(parseBody(event));
        const run = await repository.createDemoRun(userId, {
          organisationId: z.uuid().parse(createMatch[1]),
          idempotencyKey: requireIdempotencyKey(event.headers['idempotency-key']),
          requestId,
          scenarioId: input.scenarioId,
          requestedModel: dependency.config.OPENAI_MODEL,
        });
        response = json(202, { run: await publicRun(run, dependency) });
      } else if (readMatch?.[1] && readMatch[2]) {
        const run = await repository.getRun(
          userId,
          z.uuid().parse(readMatch[1]),
          z.uuid().parse(readMatch[2]),
        );
        response = json(200, { run: await publicRun(run, dependency) });
      } else {
        throw new DomainError('ROUTE_NOT_FOUND', 'The route was not found.', 404);
      }
    }
    writeLog('info', {
      event: 'api_request_completed',
      requestId,
      durationMs: Date.now() - started,
      outcome: String(response.statusCode),
    });
    return withRequestId(response, requestId);
  } catch (error) {
    const status =
      error instanceof DomainError
        ? error.httpStatus
        : error instanceof z.ZodError
          ? 400
          : 500;
    const code = error instanceof z.ZodError ? 'INVALID_REQUEST' : safeErrorCode(error);
    writeLog(status >= 500 ? 'error' : 'warn', {
      event: 'api_request_failed',
      requestId,
      durationMs: Date.now() - started,
      safeErrorCode: code,
      outcome: String(status),
      ...(error instanceof ResultArtifactError
        ? {
            errorClass: 'ResultArtifactError',
            failureStage: 'result_artifact_validation',
          }
        : {}),
    });
    return withRequestId(
      json(status, {
        error: {
          code,
          message:
            status >= 500
              ? 'The request could not be completed.'
              : publicMessage(error),
          requestId,
        },
      }),
      requestId,
    );
  }
}

async function startImpactAnalysis(
  stepFunctions: WorkflowStarter,
  stateMachineArn: string,
  analysis: {
    readonly candidateId: string;
    readonly correlationId: string;
  },
): Promise<void> {
  const workflow = impactAnalysisWorkflowInputSchema.parse({
    schemaVersion: '1.0',
    candidateId: analysis.candidateId,
    correlationId: analysis.correlationId,
  });
  try {
    await stepFunctions.send(
      new StartExecutionCommand({
        stateMachineArn,
        name: `impact-${analysis.correlationId}`,
        input: JSON.stringify(workflow),
      }),
    );
  } catch (error) {
    if (!(error instanceof ExecutionAlreadyExists)) throw error;
  }
}

export function createGithubInstallationVerifier(
  lambda: LambdaInvoker,
  functionName: string,
): GithubInstallationVerifier {
  return {
    async verify(installationId): Promise<GithubInstallationVerification> {
      let response;
      try {
        response = await lambda.send(
          new InvokeCommand({
            FunctionName: functionName,
            InvocationType: 'RequestResponse',
            Payload: Buffer.from(
              JSON.stringify({
                operation: 'verify_installation',
                installationId,
              }),
            ),
          }),
        );
      } catch {
        throw new DomainError(
          'GITHUB_INSTALLATION_VERIFICATION_FAILED',
          'The GitHub installation could not be verified.',
          502,
        );
      }
      if (response.FunctionError || !response.Payload) {
        throw new DomainError(
          'GITHUB_INSTALLATION_VERIFICATION_FAILED',
          'The GitHub installation could not be verified.',
          502,
        );
      }
      try {
        return githubInstallationVerificationSchema.parse(
          JSON.parse(Buffer.from(response.Payload).toString('utf8')),
        );
      } catch {
        throw new DomainError(
          'GITHUB_INSTALLATION_VERIFICATION_FAILED',
          'The GitHub installation could not be verified.',
          502,
        );
      }
    },
  };
}

function githubInstallationUrl(appSlug: string, state: string): string {
  const url = new URL(`https://github.com/apps/${appSlug}/installations/new`);
  url.searchParams.set('state', state);
  return url.toString();
}

async function publicRun(
  run: AgentRunRecord,
  dependency: ApiDependencies,
): Promise<PublicAgentRun> {
  let result: PublicAgentRun['result'] = null;
  if (
    run.status === 'succeeded' &&
    run.resultObjectKey &&
    run.resultDigest &&
    run.resultBytes !== null
  ) {
    const response = await dependency.s3.send(
      new GetObjectCommand({
        Bucket: dependency.config.ARTIFACT_BUCKET,
        Key: run.resultObjectKey,
      }),
    );
    const bytes = await response.Body?.transformToByteArray();
    result = validateResultArtifact(
      {
        id: run.id,
        organisationId: run.organisationId,
        resultBytes: run.resultBytes,
        resultDigest: run.resultDigest,
      },
      bytes,
    );
  }
  return {
    id: run.id,
    organisationId: run.organisationId,
    scenarioId: run.scenarioId,
    status: run.status,
    terminalCode: run.terminalCode,
    safeErrorCode: run.safeErrorCode,
    result,
    version: run.version,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

type ResultArtifactFailureCode =
  | 'RESULT_ARTIFACT_METADATA_INVALID'
  | 'RESULT_ARTIFACT_TOO_LARGE'
  | 'RESULT_ARTIFACT_READ_FAILED'
  | 'RESULT_ARTIFACT_SIZE_MISMATCH'
  | 'RESULT_ARTIFACT_DIGEST_MISMATCH'
  | 'RESULT_ARTIFACT_SCHEMA_INVALID'
  | 'RESULT_ARTIFACT_OWNERSHIP_MISMATCH';

class ResultArtifactError extends Error {
  public constructor(public readonly safeCode: ResultArtifactFailureCode) {
    super('The result artifact failed validation.');
    this.name = 'ResultArtifactError';
  }
}

interface ResultArtifactMetadata {
  readonly id: string;
  readonly organisationId: string;
  readonly resultBytes: string;
  readonly resultDigest: string;
}

export function validateResultArtifact(
  run: ResultArtifactMetadata,
  bytes: Uint8Array | undefined,
): MigrationPlan {
  const expectedBytes = parseResultArtifactBytes(run.resultBytes);
  if (!bytes) {
    throw new ResultArtifactError('RESULT_ARTIFACT_READ_FAILED');
  }
  if (bytes.byteLength !== expectedBytes) {
    throw new ResultArtifactError('RESULT_ARTIFACT_SIZE_MISMATCH');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== run.resultDigest) {
    throw new ResultArtifactError('RESULT_ARTIFACT_DIGEST_MISMATCH');
  }

  let envelope;
  try {
    envelope = agentResultEnvelopeSchema.parse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
  } catch {
    throw new ResultArtifactError('RESULT_ARTIFACT_SCHEMA_INVALID');
  }
  if (
    envelope.organisationId !== run.organisationId ||
    envelope.agentRunId !== run.id
  ) {
    throw new ResultArtifactError('RESULT_ARTIFACT_OWNERSHIP_MISMATCH');
  }
  if (!envelope.result) {
    throw new ResultArtifactError('RESULT_ARTIFACT_SCHEMA_INVALID');
  }
  return envelope.result;
}

function parseResultArtifactBytes(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new ResultArtifactError('RESULT_ARTIFACT_METADATA_INVALID');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ResultArtifactError('RESULT_ARTIFACT_METADATA_INVALID');
  }
  if (parsed < 1 || parsed > MAX_RESULT_BYTES) {
    throw new ResultArtifactError('RESULT_ARTIFACT_TOO_LARGE');
  }
  return parsed;
}

function parseBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    throw new DomainError('INVALID_REQUEST', 'A JSON request body is required.', 400);
  }
  const bytes = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64')
    : Buffer.from(event.body, 'utf8');
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new DomainError('REQUEST_TOO_LARGE', 'The request body is too large.', 413);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new DomainError('INVALID_JSON', 'The request body is not valid JSON.', 400);
  }
}

function normalizePath(rawPath: string): string {
  const path = rawPath.startsWith('/api/') ? rawPath.slice(4) : rawPath;
  return path.length > 1 ? path.replace(/\/+$/u, '') : path;
}

function requestIdentifier(value: string): string {
  return z.uuid().safeParse(value).data ?? randomUUID();
}

function publicMessage(error: unknown): string {
  if (error instanceof DomainError) {
    return error.message;
  }
  if (error instanceof z.ZodError) {
    return 'The request is invalid.';
  }
  return 'The request could not be completed.';
}

function json(statusCode: number, body: unknown): JsonResponse {
  return {
    statusCode,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    },
    body: JSON.stringify(body),
  };
}

function withRequestId(response: JsonResponse, requestId: string): JsonResponse {
  return {
    ...response,
    headers: { ...response.headers, 'x-request-id': requestId },
  };
}
