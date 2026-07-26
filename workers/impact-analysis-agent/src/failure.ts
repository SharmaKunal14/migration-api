import OpenAI, { APIError as OpenAIApiError, OAuthError, type APIError } from 'openai';
import { z } from 'zod';

import { safeErrorCode } from '@migration/observability';

import { InvalidImpactOutputError } from './gateway.js';
import { RepositoryToolError } from './tools.js';

export interface ImpactFailureClassification {
  readonly safeErrorCode: string;
  readonly errorClass: string;
  readonly failureStage:
    | 'agent_runtime'
    | 'model_output'
    | 'openai_responses_api'
    | 'openai_token_exchange'
    | 'openai_transport'
    | 'repository_snapshot';
  readonly httpStatus?: number;
  readonly upstreamErrorCode?: string;
  readonly upstreamRequestId?: string;
}

export function classifyImpactAnalysisFailure(
  error: unknown,
): ImpactFailureClassification {
  if (error instanceof RepositoryToolError) {
    return {
      safeErrorCode: error.safeCode,
      errorClass: 'RepositoryToolError',
      failureStage: 'repository_snapshot',
    };
  }
  if (error instanceof InvalidImpactOutputError) {
    return {
      safeErrorCode: error.safeCode,
      errorClass: 'InvalidImpactOutputError',
      failureStage: 'model_output',
    };
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return {
      safeErrorCode: 'INVALID_EXTERNAL_PAYLOAD',
      errorClass: error instanceof z.ZodError ? 'ZodError' : 'SyntaxError',
      failureStage: 'agent_runtime',
    };
  }
  if (error instanceof OAuthError) {
    return apiFailure(
      error,
      'MODEL_IDENTITY_EXCHANGE_FAILED',
      'OAuthError',
      'openai_token_exchange',
      error.error_code,
    );
  }
  if (
    error instanceof OpenAI.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIConnectionError
  ) {
    return {
      safeErrorCode: 'MODEL_UPSTREAM_TRANSIENT',
      errorClass:
        error instanceof OpenAI.APIConnectionTimeoutError
          ? 'APIConnectionTimeoutError'
          : 'APIConnectionError',
      failureStage: 'openai_transport',
    };
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return {
      safeErrorCode: 'MODEL_REQUEST_ABORTED',
      errorClass: 'APIUserAbortError',
      failureStage: 'openai_responses_api',
    };
  }
  if (isOpenAIApiError(error)) {
    const transient =
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      (error.status !== undefined && error.status >= 500);
    return apiFailure(
      error,
      transient ? 'MODEL_UPSTREAM_TRANSIENT' : 'MODEL_REQUEST_REJECTED',
      apiErrorClass(error),
      'openai_responses_api',
      error.code,
    );
  }
  return {
    safeErrorCode: safeErrorCode(error),
    errorClass: error instanceof Error ? 'Error' : 'UnknownError',
    failureStage: 'agent_runtime',
  };
}

function isOpenAIApiError(error: unknown): error is APIError {
  return error instanceof OpenAIApiError;
}

function apiFailure(
  error: APIError,
  code: string,
  errorClass: string,
  failureStage: 'openai_responses_api' | 'openai_token_exchange',
  preferredErrorCode?: string | null,
): ImpactFailureClassification {
  const upstreamErrorCode = safeUpstreamValue(preferredErrorCode ?? error.code);
  const upstreamRequestId = safeUpstreamValue(error.requestID);
  return {
    safeErrorCode: code,
    errorClass,
    failureStage,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    ...(upstreamErrorCode === undefined ? {} : { upstreamErrorCode }),
    ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
  };
}

function apiErrorClass(error: APIError): string {
  if (error instanceof OpenAI.AuthenticationError) return 'AuthenticationError';
  if (error instanceof OpenAI.PermissionDeniedError) return 'PermissionDeniedError';
  if (error instanceof OpenAI.RateLimitError) return 'RateLimitError';
  if (error instanceof OpenAI.BadRequestError) return 'BadRequestError';
  return 'APIError';
}

function safeUpstreamValue(value: string | null | undefined): string | undefined {
  return value !== undefined &&
    value !== null &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)
    ? value
    : undefined;
}
