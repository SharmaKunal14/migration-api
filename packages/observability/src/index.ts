const MAX_LOG_BYTES = 16 * 1024;

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly event: string;
  readonly requestId?: string;
  readonly correlationId?: string;
  readonly organisationId?: string;
  readonly agentRunId?: string;
  readonly repositoryId?: string;
  readonly repositoryScanId?: string;
  readonly outcome?: string;
  readonly durationMs?: number;
  readonly safeErrorCode?: string;
  readonly errorClass?: string;
  readonly failureStage?: string;
  readonly httpStatus?: number;
  readonly upstreamErrorCode?: string;
  readonly upstreamRequestId?: string;
  readonly failureReason?: string;
  readonly responseStatus?: string;
  readonly incompleteReason?: string;
  readonly validationIssuePaths?: readonly string[];
}

const forbiddenKeys =
  /authorization|cookie|credential|database.*url|jwt|password|presigned|prompt|secret|source|token/i;

export function writeLog(level: LogLevel, context: LogContext): void {
  const safeContext = Object.fromEntries(
    Object.entries(context).filter(
      ([key, value]) => value !== undefined && !forbiddenKeys.test(key),
    ),
  );
  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: process.env.AWS_LAMBDA_FUNCTION_NAME ?? 'migration-api',
    ...safeContext,
  });
  const bounded =
    Buffer.byteLength(event, 'utf8') <= MAX_LOG_BYTES
      ? event
      : JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          event: 'log_event_rejected',
          safeErrorCode: 'LOG_EVENT_TOO_LARGE',
        });
  process.stdout.write(`${bounded}\n`);
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof Error && 'safeCode' in error) {
    const code = error.safeCode;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
      return code;
    }
  }
  return 'INTERNAL_ERROR';
}
