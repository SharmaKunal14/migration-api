import OpenAI, { APIError as OpenAIApiError, OAuthError, type APIError } from 'openai';
import { z } from 'zod';

import { safeErrorCode } from '@migration/observability';

import { InvalidSpecificationOutputError } from './gateway.js';
import { ToolPolicyError } from './tools.js';

export interface FailureClassification {
  readonly safeErrorCode: string;
  readonly errorClass: string;
  readonly failureStage:
    | 'agent_runtime'
    | 'evidence_tool'
    | 'model_output'
    | 'openai_responses_api'
    | 'openai_token_exchange'
    | 'openai_transport';
  readonly httpStatus?: number;
  readonly upstreamRequestId?: string;
}

export function classifyChangeIntelligenceFailure(
  error: unknown,
): FailureClassification {
  if (error instanceof ToolPolicyError) {
    return {
      safeErrorCode: error.safeCode,
      errorClass: 'ToolPolicyError',
      failureStage: 'evidence_tool',
    };
  }
  if (error instanceof InvalidSpecificationOutputError) {
    return {
      safeErrorCode: error.safeCode,
      errorClass: 'InvalidSpecificationOutputError',
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
): FailureClassification {
  const upstreamRequestId =
    typeof error.requestID === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(error.requestID)
      ? error.requestID
      : undefined;
  return {
    safeErrorCode: code,
    errorClass,
    failureStage,
    ...(error.status === undefined ? {} : { httpStatus: error.status }),
    ...(upstreamRequestId ? { upstreamRequestId } : {}),
  };
}

function apiErrorClass(error: APIError): string {
  if (error instanceof OpenAI.AuthenticationError) {
    return 'AuthenticationError';
  }
  if (error instanceof OpenAI.PermissionDeniedError) {
    return 'PermissionDeniedError';
  }
  if (error instanceof OpenAI.RateLimitError) {
    return 'RateLimitError';
  }
  if (error instanceof OpenAI.BadRequestError) {
    return 'BadRequestError';
  }
  return 'APIError';
}
