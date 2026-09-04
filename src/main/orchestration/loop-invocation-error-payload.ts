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
  // An adapter that estimated usage for a failed turn also knows which model
  // burned it; use that only when the caller could not name one itself.
  const model = params.model?.trim() || extractPartialModel(params.error);
  return {
    error: message,
    ...metadata,
    ...(params.provider ? { provider: params.provider } : {}),
    ...(model ? { model } : {}),
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
    partialUsage?: unknown;
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
  const partialUsage = sanitizePartialUsage(shaped?.partialUsage);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(headers ? { headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(partialUsage ? { partialUsage } : {}),
  };
}

function extractPartialModel(error: unknown): string | undefined {
  const value = (error as { partialModel?: unknown } | null | undefined)?.partialModel;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * A failed provider attempt reaches us as a thrown `Error` that an adapter
 * decorated with its own estimate, so the shape is untrusted. Keep only finite,
 * non-negative token counts — anything else is dropped rather than coerced, and
 * an attempt with no positive count yields `undefined` so the coordinator
 * charges nothing rather than inventing a zero-token "iteration".
 */
function sanitizePartialUsage(value: unknown): LoopChildInvocationError['partialUsage'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const shaped = value as Record<string, unknown>;
  const inputTokens = asNonNegativeNumber(shaped['inputTokens']);
  const outputTokens = asNonNegativeNumber(shaped['outputTokens']);
  const cacheReadTokens = asNonNegativeNumber(shaped['cacheReadTokens']);
  const cacheWriteTokens = asNonNegativeNumber(shaped['cacheWriteTokens']);
  const reasoningTokens = asNonNegativeNumber(shaped['reasoningTokens']);
  const totalTokens = asNonNegativeNumber(shaped['totalTokens']);
  const counts = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens];
  if (!counts.some((count) => count !== undefined && count > 0)) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(shaped['isEstimated'] === true ? { isEstimated: true } : {}),
  };
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
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
