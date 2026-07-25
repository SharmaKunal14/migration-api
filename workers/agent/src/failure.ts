import OpenAI, { APIError as OpenAIAPIError, OAuthError, type APIError } from 'openai';
import { z } from 'zod';

import { ToolPolicyError } from '@migration/agent-tools';
import {
  agentResultEnvelopeSchema,
  type AgentResultEnvelope,
} from '@migration/contracts';
import { safeErrorCode } from '@migration/observability';

type FailureStage =
  | 'agent_runtime'
  | 'openai_responses_api'
  | 'openai_token_exchange'
  | 'openai_transport';

export interface FailureDiagnostics {
  readonly errorClass: string;
  readonly failureStage: FailureStage;
  readonly httpStatus?: number;
  readonly upstreamErrorCode?: string;
  readonly upstreamRequestId?: string;
}

export interface AgentFailure {
  readonly terminalCode:
    | 'invalid_model_output'
    | 'policy_rejected'
    | 'upstream_transient'
    | 'upstream_permanent'
    | 'infrastructure_failed';
  readonly safeErrorCode: string;
  readonly diagnostics: FailureDiagnostics;
}

export function createClassifiedFailure(
  organisationId: string,
  agentRunId: string,
  requestedModel: string,
  durationMs: number,
  failure: AgentFailure,
): AgentResultEnvelope {
  return agentResultEnvelopeSchema.parse({
    schemaVersion: '1.0',
    organisationId,
    agentRunId,
    model: {
      provider: 'openai',
      requestedModel,
      returnedModel: requestedModel,
      reasoningEffort: 'medium',
      requestId: null,
    },
    usage: {
      modelCalls: 0,
      toolCalls: 0,
      iterations: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs,
    },
    actions: [],
    terminal: {
      code: failure.terminalCode,
      safeErrorCode: failure.safeErrorCode,
    },
    result: null,
  });
}

export function classifyAgentFailure(error: unknown): AgentFailure {
  if (error instanceof ToolPolicyError) {
    return failure('policy_rejected', error.safeCode, 'ToolPolicyError');
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return failure(
      'invalid_model_output',
      'INVALID_EXTERNAL_PAYLOAD',
      error instanceof z.ZodError ? 'ZodError' : 'SyntaxError',
    );
  }
  if (error instanceof OAuthError) {
    return {
      terminalCode: 'upstream_permanent',
      safeErrorCode: 'MODEL_IDENTITY_EXCHANGE_FAILED',
      diagnostics: apiDiagnostics(
        error,
        'openai_token_exchange',
        'OAuthError',
        error.error_code,
      ),
    };
  }
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIConnectionError
  ) {
    return {
      terminalCode: 'upstream_transient',
      safeErrorCode: 'MODEL_UPSTREAM_TRANSIENT',
      diagnostics: {
        failureStage: 'openai_transport',
        errorClass:
          error instanceof OpenAI.APIConnectionTimeoutError
            ? 'APIConnectionTimeoutError'
            : 'APIConnectionError',
      },
    };
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return {
      terminalCode: 'upstream_transient',
      safeErrorCode: 'MODEL_REQUEST_ABORTED',
      diagnostics: {
        failureStage: 'openai_responses_api',
        errorClass: 'APIUserAbortError',
      },
    };
  }
  if (error instanceof OpenAI.RateLimitError) {
    return {
      terminalCode: 'upstream_transient',
      safeErrorCode: 'MODEL_UPSTREAM_TRANSIENT',
      diagnostics: apiDiagnostics(error, 'openai_responses_api', 'RateLimitError'),
    };
  }
  if (
    error instanceof OpenAI.AuthenticationError ||
    error instanceof OpenAI.PermissionDeniedError
  ) {
    return {
      terminalCode: 'upstream_permanent',
      safeErrorCode: 'MODEL_AUTHENTICATION_FAILED',
      diagnostics: apiDiagnostics(
        error,
        'openai_responses_api',
        error instanceof OpenAI.AuthenticationError
          ? 'AuthenticationError'
          : 'PermissionDeniedError',
      ),
    };
  }
  if (isOpenAIAPIError(error)) {
    const isTransient =
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500);
    return {
      terminalCode: isTransient ? 'upstream_transient' : 'upstream_permanent',
      safeErrorCode: isTransient
        ? 'MODEL_UPSTREAM_TRANSIENT'
        : 'MODEL_REQUEST_REJECTED',
      diagnostics: apiDiagnostics(error, 'openai_responses_api', apiErrorClass(error)),
    };
  }
  return {
    terminalCode: 'infrastructure_failed',
    safeErrorCode: safeErrorCode(error),
    diagnostics: {
      failureStage: 'agent_runtime',
      errorClass: error instanceof Error ? 'Error' : 'UnknownError',
    },
  };
}

function failure(
  terminalCode: AgentFailure['terminalCode'],
  code: string,
  errorClass: string,
): AgentFailure {
  return {
    terminalCode,
    safeErrorCode: code,
    diagnostics: {
      failureStage: 'agent_runtime',
      errorClass,
    },
  };
}

function apiDiagnostics(
  error: APIError,
  failureStage: Extract<FailureStage, 'openai_responses_api' | 'openai_token_exchange'>,
  errorClass: string,
  preferredErrorCode?: string,
): FailureDiagnostics {
  const upstreamErrorCode = safeUpstreamValue(preferredErrorCode ?? error.code);
  const upstreamRequestId = safeUpstreamValue(error.requestID);
  return {
    failureStage,
    errorClass,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    ...(upstreamErrorCode === undefined ? {} : { upstreamErrorCode }),
    ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
  };
}

function isOpenAIAPIError(error: unknown): error is APIError {
  return error instanceof OpenAIAPIError;
}

function apiErrorClass(error: APIError): string {
  if (error instanceof OpenAI.BadRequestError) {
    return 'BadRequestError';
  }
  if (error instanceof OpenAI.NotFoundError) {
    return 'NotFoundError';
  }
  if (error instanceof OpenAI.ConflictError) {
    return 'ConflictError';
  }
  if (error instanceof OpenAI.UnprocessableEntityError) {
    return 'UnprocessableEntityError';
  }
  if (error instanceof OpenAI.InternalServerError) {
    return 'InternalServerError';
  }
  return 'APIError';
}

function safeUpstreamValue(value: string | null | undefined): string | undefined {
  return value !== undefined &&
    value !== null &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)
    ? value
    : undefined;
}
