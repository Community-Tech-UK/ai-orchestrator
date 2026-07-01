import { coerceToFailoverError } from '../core/failover-error';
import { getLogger } from '../logging/logger';
import { redactLogOutput } from '../security/secret-redaction';
import type { LoopChildInvocationError } from './loop-coordinator.types';

const logger = getLogger('DefaultInvokers');

export interface InvocationFailureParams {
  correlationId: string;
  invocation: string;
  error: unknown;
  eventName?: string;
  provider?: string;
  model?: string;
  instanceId?: string;
}

export function logInvocationFailure(params: InvocationFailureParams): string {
  const failoverErr = coerceToFailoverError(params.error, {
    provider: params.provider,
    model: params.model,
    instanceId: params.instanceId,
  });
  if (failoverErr) {
    logger.warn(`${params.invocation} failed (classified)`, {
      correlationId: params.correlationId,
      eventName: params.eventName,
      reason: failoverErr.reason,
      retryable: failoverErr.retryable,
    });
  }

  const message = params.error instanceof Error ? params.error.message : String(params.error);
  logger.error(`${params.invocation} failed`, params.error instanceof Error ? params.error : undefined, {
    correlationId: params.correlationId,
    eventName: params.eventName,
    provider: params.provider,
    model: params.model,
    instanceId: params.instanceId,
  });
  return message;
}

export function buildLoopInvocationErrorPayload(params: InvocationFailureParams): LoopChildInvocationError {
  const message = logInvocationFailure(params);
  const metadata = extractLoopInvocationErrorMetadata(params.error);
  return {
    error: message,
    ...metadata,
    ...(params.provider ? { provider: params.provider } : {}),
    ...(params.model ? { model: params.model } : {}),
    ...(params.instanceId ? { instanceId: params.instanceId } : {}),
  };
}

function extractLoopInvocationErrorMetadata(error: unknown): Omit<LoopChildInvocationError, 'error' | 'provider' | 'model' | 'instanceId'> {
  const shaped = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    headers?: unknown;
    body?: unknown;
    response?: {
      status?: unknown;
      statusCode?: unknown;
      headers?: unknown;
      body?: unknown;
      data?: unknown;
    };
  } | null | undefined;
  const status = asNumber(shaped?.status ?? shaped?.response?.status);
  const statusCode = asNumber(shaped?.statusCode ?? shaped?.response?.statusCode);
  const code = asStringOrNumber(shaped?.code);
  const headers = sanitizeLoopErrorHeaders(shaped?.headers ?? shaped?.response?.headers);
  const body = sanitizeLoopErrorBody(shaped?.body ?? shaped?.response?.body ?? shaped?.response?.data);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === 'string' || typeof value === 'number') return value;
  return undefined;
}

const LOOP_ERROR_HEADER_ALLOWLIST = new Set([
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
]);
const SENSITIVE_LOOP_ERROR_BODY_KEY = /(?:^|[_-])(api[_-]?key|authorization|client[_-]?secret|password|refresh[_-]?token|secret|token)(?:$|[_-])/i;

function sanitizeLoopErrorHeaders(headers: unknown): Record<string, string | readonly string[] | undefined> | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  const out: Record<string, string | readonly string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (!LOOP_ERROR_HEADER_ALLOWLIST.has(lower)) continue;
    if (typeof value === 'string') out[lower] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) out[lower] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeLoopErrorBody(body: unknown, depth = 0): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return redactLogOutput(body.slice(0, 8_000), { fullMask: false });
  if (typeof body === 'number' || typeof body === 'boolean') return body;
  if (Array.isArray(body)) {
    if (depth >= 3) return '[truncated]';
    return body.slice(0, 20).map((item) => sanitizeLoopErrorBody(item, depth + 1));
  }
  if (typeof body === 'object') {
    if (depth >= 3) return '[truncated]';
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body as Record<string, unknown>).slice(0, 50)) {
      if (SENSITIVE_LOOP_ERROR_BODY_KEY.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeLoopErrorBody(value, depth + 1);
    }
    return out;
  }
  return redactLogOutput(String(body).slice(0, 8_000), { fullMask: false });
}
