import OpenAI, { OAuthError } from 'openai';
import { describe, expect, it } from 'vitest';

import {
  classifyAgentFailure,
  createClassifiedFailure,
} from '../workers/agent/src/failure.js';

describe('agent failure classification', () => {
  it('classifies OAuth exchange errors without retaining the response body', () => {
    const sensitiveDescription = 'mapping rejected secret-value';
    const error = new OAuthError(
      401,
      {
        error: 'invalid_subject_token',
        error_description: sensitiveDescription,
      },
      new Headers({ 'x-request-id': 'req_oauth_123' }),
    );

    const failure = classifyAgentFailure(error);

    expect(failure).toEqual({
      terminalCode: 'upstream_permanent',
      safeErrorCode: 'MODEL_IDENTITY_EXCHANGE_FAILED',
      diagnostics: {
        failureStage: 'openai_token_exchange',
        errorClass: 'OAuthError',
        httpStatus: 401,
        upstreamErrorCode: 'invalid_subject_token',
        upstreamRequestId: 'req_oauth_123',
      },
    });
    expect(JSON.stringify(failure)).not.toContain(sensitiveDescription);
  });

  it('classifies rejected model requests separately from authentication', () => {
    const error = new OpenAI.BadRequestError(
      400,
      { code: 'model_not_found', message: 'sensitive upstream detail' },
      undefined,
      new Headers({ 'x-request-id': 'req_model_123' }),
    );

    expect(classifyAgentFailure(error)).toEqual({
      terminalCode: 'upstream_permanent',
      safeErrorCode: 'MODEL_REQUEST_REJECTED',
      diagnostics: {
        failureStage: 'openai_responses_api',
        errorClass: 'BadRequestError',
        httpStatus: 400,
        upstreamErrorCode: 'model_not_found',
        upstreamRequestId: 'req_model_123',
      },
    });
  });

  it('classifies connection timeouts as transient without an HTTP status', () => {
    const error = new OpenAI.APIConnectionTimeoutError();

    expect(classifyAgentFailure(error)).toEqual({
      terminalCode: 'upstream_transient',
      safeErrorCode: 'MODEL_UPSTREAM_TRANSIENT',
      diagnostics: {
        failureStage: 'openai_transport',
        errorClass: 'APIConnectionTimeoutError',
      },
    });
  });

  it('records the measured failure duration in the result envelope', () => {
    const failure = classifyAgentFailure(new OpenAI.APIConnectionTimeoutError());

    const result = createClassifiedFailure(
      'fb88f567-56f6-4151-8a42-c84981f49ec6',
      'ba1cf050-aded-4226-abbf-85d18d3a0fae',
      'gpt-5.6-sol',
      1_234,
      failure,
    );

    expect(result.usage.durationMs).toBe(1_234);
  });

  it('drops malformed upstream identifiers from diagnostics', () => {
    const error = new OpenAI.BadRequestError(
      400,
      { code: 'unsafe value with spaces' },
      undefined,
      new Headers({ 'x-request-id': 'unsafe request' }),
    );

    expect(classifyAgentFailure(error).diagnostics).toEqual({
      failureStage: 'openai_responses_api',
      errorClass: 'BadRequestError',
      httpStatus: 400,
    });
  });
});
