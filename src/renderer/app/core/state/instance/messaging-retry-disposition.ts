/**
 * Retry disposition for queued instance sends.
 *
 * Extracted from `instance-messaging.store.ts` so the store stays inside its
 * LOC ceiling. Behaviour matches the previous private method, plus the
 * LT-652 `retryAfterMs` / `maxRetries` fields.
 */

import type { InstanceStatus } from './instance.types';
import { isInterruptRecoveryStatus } from './instance-messaging-queue-utils';

/** Spacing for an ordinary transient send failure (the previous hard-coded value). */
export const DEFAULT_SEND_RETRY_DELAY_MS = 2_000;
/**
 * LT-652: spacing while the provider is running its own compaction turn.
 * Codex rejects input with `ActiveTurnNotSteerable { turn_kind: Compact }`
 * for the whole auto-compact, not just a brief settle. A large-context compact
 * outlives any sub-second or 2 s retry budget, so a send that races one must
 * wait it out instead of burning its retries in under a second.
 */
export const COMPACT_TURN_RETRY_DELAY_MS = 15_000;
/** Attempts while waiting out a provider compaction (12 × 15 s ≈ the 180 s init-wait ceiling). */
export const MAX_COMPACT_TURN_RETRIES = 12;

export interface SendRetryDisposition {
  shouldRetry: boolean;
  nextStatus?: InstanceStatus;
  /** Earliest sensible re-attempt. Default `DEFAULT_SEND_RETRY_DELAY_MS`. */
  retryAfterMs?: number;
  /** Retry budget for this failure class. Default `MAX_QUEUE_RETRIES`. */
  maxRetries?: number;
}

/**
 * LT-652: Codex's app-server runs auto-compaction as an internal
 * `turn_kind: Compact` turn and refuses new input for its whole duration.
 * Recognised here so the send is held for the compact instead of being
 * retried immediately and dropped.
 *
 * Deliberately narrow: the signature is the `turn_kind: Compact` payload. A
 * bare `failed to submit turn input`, or `ActiveTurnNotSteerable` for any
 * other `turn_kind`, is an ordinary transient rejection and must stay on the
 * fast 2 s × 5 path — routing it here would hide a real failure for ~180 s
 * and steal the `nextStatus: 'busy'` park an active-turn collision needs.
 */
export function isProviderCompactingRejection(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('turn_kind: compact')
    || (normalized.includes('activeturnnotsteerable') && normalized.includes('compact'));
}

export function getRetryDisposition(
  status: InstanceStatus | undefined,
  errorMessage: string,
): SendRetryDisposition {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('send input timed out')) {
    return { shouldRetry: false, nextStatus: 'idle' };
  }

  if (isProviderCompactingRejection(errorMessage)) {
    // No `nextStatus`: the instance is already idle at the AIO layer (a
    // `turn_kind: Compact` is invisible to our turn tracking — that is half of
    // LT-652). Parking it on `busy` would make `processMessageQueue` refuse to
    // drain at all; the `retryAfterAt` gate is what holds the send instead.
    return {
      shouldRetry: true,
      retryAfterMs: COMPACT_TURN_RETRY_DELAY_MS,
      maxRetries: MAX_COMPACT_TURN_RETRIES,
    };
  }

  if (normalized.includes('codex app-server runtime already has an active turn')
    || normalized.includes('previous turn is still running')) {
    return { shouldRetry: true, nextStatus: 'busy' };
  }

  if (
    isInterruptRecoveryStatus(status)
    || normalized.includes('respawning')
    || normalized.includes('interrupt recovery')
    || normalized.includes('recovering from interrupt')
  ) {
    return {
      shouldRetry: true,
      nextStatus: isInterruptRecoveryStatus(status) ? status : 'respawning',
    };
  }

  if (status === 'initializing' || status === 'waking') {
    return { shouldRetry: true, nextStatus: status };
  }

  if (normalized.includes('not ready') || normalized.includes('not spawned')) {
    return { shouldRetry: true };
  }

  if (status === 'error' || status === 'failed' || normalized.includes('error state') || normalized.includes('inconsistent state')) {
    return { shouldRetry: false, nextStatus: status === 'failed' ? 'failed' : 'error' };
  }

  if (status === 'terminated' || normalized.includes('terminated')) {
    return { shouldRetry: false, nextStatus: 'terminated' };
  }

  if (normalized.includes('instance') && normalized.includes('not found')) {
    return { shouldRetry: false, nextStatus: 'terminated' };
  }

  return { shouldRetry: true };
}

export function canRestartForTerminalSend(status: InstanceStatus): boolean {
  return status === 'terminated'
    || status === 'failed'
    || status === 'error'
    || status === 'cancelled';
}
