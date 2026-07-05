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

/** Classify a thrown adapter error as a provider limit (or not). */
export function detectErrorProviderLimit(
  error: unknown,
  errorMessage: string,
): ProviderLimitTurnSignal | null {
  const diagnostics = extractProviderErrorDiagnostics(error);
  const looksLikeLimit =
    diagnostics.rateLimit !== undefined
    || diagnostics.quota !== undefined
    || isProviderNotice(errorMessage);
  if (!looksLikeLimit) return null;
  return {
    resetAtHint: diagnostics.rateLimit?.resetAt ?? diagnostics.quota?.resetAt ?? null,
    reason: `provider limit on turn: ${errorMessage.slice(0, 160)}`,
  };
}

/**
 * Classify a *completed* turn (exit 0) whose assistant content is actually a
 * provider limit notice ("You've hit your session limit · resets 6:30pm").
 */
export function detectCompletionProviderLimit(
  response: { content?: string; metadata?: unknown },
): ProviderLimitTurnSignal | null {
  if (!isProviderNotice(response.content)) return null;
  const diagnostics = extractProviderErrorDiagnostics(response.metadata);
  return {
    resetAtHint: diagnostics.rateLimit?.resetAt ?? diagnostics.quota?.resetAt ?? null,
    reason: `provider limit notice on completed turn: ${(response.content ?? '').slice(0, 160)}`,
  };
}
