/**
 * Retry disposition for queued instance sends.
 *
 * Extracted from `instance-messaging.store.ts` so the store stays inside its
 * LOC ceiling. Behaviour matches the previous private method.
 */

import type { InstanceStatus } from './instance.types';
import { isInterruptRecoveryStatus } from './instance-messaging-queue-utils';

export function getRetryDisposition(
  status: InstanceStatus | undefined,
  errorMessage: string,
): { shouldRetry: boolean; nextStatus?: InstanceStatus } {
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes('send input timed out')) {
    return { shouldRetry: false, nextStatus: 'idle' };
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
