import type { CliRateLimitInfo } from '../../shared/types/cli.types';
import { isProviderNotice } from '../cli/provider-notice';
import { extractProviderErrorDiagnostics } from './instance-communication.diagnostics';

/**
 * A turn that stopped on a provider rate/session limit, with the reset time (if
 * the provider told us one) and a short human reason. Returned by the detectors
 * below; `null` means "not a provider limit — handle normally".
 *
 * Extracted from InstanceCommunicationManager to keep that file within its size
 * ceiling and to unit-test the classification in isolation.
 */
export interface ProviderLimitTurnSignal {
  resetAtHint: number | null;
  reason: string;
}

/**
 * Reset time (epoch ms) from the CLI's own rate-limit telemetry
 * (`rate_limit_event`), or null when there is no active throttle window. The
 * raw `resetsAt` is in seconds; a past reset means the window already rolled
 * over, so stale telemetry from an earlier throttle never contributes.
 */
function telemetryResetAtMs(telemetry: CliRateLimitInfo | null | undefined): number | null {
  if (typeof telemetry?.resetsAt !== 'number') return null;
  const resetsAtMs = telemetry.resetsAt * 1000;
  return resetsAtMs > Date.now() ? resetsAtMs : null;
}

/**
 * Latest rate-limit telemetry from the adapter, when the concrete adapter
 * exposes it (currently the Claude adapter's `getLastRateLimitInfo()`); null
 * for adapters without telemetry, which keeps the text-based detection intact.
 */
export function readAdapterRateLimitTelemetry(adapter: unknown): CliRateLimitInfo | null {
  const candidate = adapter as { getLastRateLimitInfo?: () => CliRateLimitInfo | null } | null;
  return typeof candidate?.getLastRateLimitInfo === 'function'
    ? candidate.getLastRateLimitInfo()
    : null;
}

/** Classify a thrown adapter error as a provider limit (or not). */
export function detectErrorProviderLimit(
  error: unknown,
  errorMessage: string,
  telemetry?: CliRateLimitInfo | null,
): ProviderLimitTurnSignal | null {
  const diagnostics = extractProviderErrorDiagnostics(error);
  const telemetryResetAt = telemetryResetAtMs(telemetry);
  // A live "rejected" window means the provider is actively refusing turns, so
  // an errored turn is a limit stop even when the error text itself is generic
  // (e.g. a bare stream close after the CLI's rate_limit_event).
  const rejectedByTelemetry = telemetry?.status === 'rejected' && telemetryResetAt !== null;
  const looksLikeLimit =
    diagnostics.rateLimit !== undefined
    || diagnostics.quota !== undefined
    || isProviderNotice(errorMessage)
    || rejectedByTelemetry;
  if (!looksLikeLimit) return null;
  return {
    resetAtHint:
      diagnostics.rateLimit?.resetAt
      ?? diagnostics.quota?.resetAt
      ?? telemetryResetAt,
    reason: `provider limit on turn: ${errorMessage.slice(0, 160)}`,
  };
}

/**
 * Classify a *completed* turn (exit 0) whose assistant content is actually a
 * provider limit notice ("You've hit your session limit · resets 6:30pm").
 */
export function detectCompletionProviderLimit(
  response: { content?: string; metadata?: unknown },
  telemetry?: CliRateLimitInfo | null,
): ProviderLimitTurnSignal | null {
  if (!isProviderNotice(response.content)) return null;
  const diagnostics = extractProviderErrorDiagnostics(response.metadata);
  return {
    resetAtHint:
      diagnostics.rateLimit?.resetAt
      ?? diagnostics.quota?.resetAt
      ?? telemetryResetAtMs(telemetry),
    reason: `provider limit notice on completed turn: ${(response.content ?? '').slice(0, 160)}`,
  };
}
