/**
 * Provider error diagnostics helpers for InstanceCommunicationManager.
 * Pure functions with no dependency on manager state.
 */

import type {
  ProviderQuotaDiagnostics,
  ProviderRateLimitDiagnostics,
} from '@contracts/types/provider-runtime-events';

export interface ProviderErrorDiagnostics {
  requestId?: string;
  stopReason?: string;
  rateLimit?: ProviderRateLimitDiagnostics;
  quota?: ProviderQuotaDiagnostics;
}

export function extractProviderErrorDiagnostics(error: unknown): ProviderErrorDiagnostics {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  if (!record) {
    return {};
  }

  const requestId = readDiagnosticString(record, ['requestId', 'request_id', 'x-request-id', 'anthropic-request-id']);
  const stopReason = readDiagnosticString(record, ['stopReason', 'stop_reason']);
  const rateLimit = normalizeRateLimitDiagnostics(record['rateLimit'] ?? record['rate_limit']);
  const quota = normalizeQuotaDiagnostics(record['quota']);
  return {
    ...(requestId !== undefined ? { requestId } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(rateLimit !== undefined ? { rateLimit } : {}),
    ...(quota !== undefined ? { quota } : {}),
  };
}

function normalizeRateLimitDiagnostics(value: unknown): ProviderRateLimitDiagnostics | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return undefined;
  }

  const rateLimit: ProviderRateLimitDiagnostics = {};
  const limit = readDiagnosticNumber(record, ['limit']);
  const remaining = readDiagnosticNumber(record, ['remaining']);
  const resetAt = readDiagnosticNumber(record, ['resetAt', 'reset_at']);
  if (limit !== undefined) rateLimit.limit = limit;
  if (remaining !== undefined) rateLimit.remaining = remaining;
  if (resetAt !== undefined) rateLimit.resetAt = resetAt;
  return Object.keys(rateLimit).length > 0 ? rateLimit : undefined;
}

function normalizeQuotaDiagnostics(value: unknown): ProviderQuotaDiagnostics | undefined {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  if (!record) {
    return undefined;
  }

  const quota: ProviderQuotaDiagnostics = {};
  if (typeof record['exhausted'] === 'boolean') quota.exhausted = record['exhausted'];
  const resetAt = readDiagnosticNumber(record, ['resetAt', 'reset_at']);
  const message = readDiagnosticString(record, ['message']);
  if (resetAt !== undefined) quota.resetAt = resetAt;
  if (message !== undefined) quota.message = message;
  return Object.keys(quota).length > 0 ? quota : undefined;
}

function readDiagnosticNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

function readDiagnosticString(record: Record<string, unknown>, keys: string[], maxLength = 300): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      const trimmed = value.trim();
      return trimmed.length <= maxLength ? trimmed : undefined;
    }
  }
  return undefined;
}
