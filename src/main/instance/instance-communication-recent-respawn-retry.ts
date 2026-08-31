/**
 * LT-023 — recent-respawn-suppression retry.
 *
 * A CLI exit landing inside the 5s "recent respawn" suppression window
 * (`RECENT_RESPAWN_SUPPRESS_MS` in instance-communication.ts) used to fall
 * straight through to a terminal `error` state: no `waitReason`, no further
 * attempt, and the circuit breaker's own backoff ladder — which lives inside
 * `respawnAfterUnexpectedExit` — never got a chance to run at all, because
 * the suppression sat in front of it and the normal auto-respawn call was
 * simply never made. Two rapid crashes left the session dead indefinitely
 * with no explanation.
 *
 * This defers the retry until the remainder of the suppression window
 * elapses, then routes it through the normal `onUnexpectedExit` path — so a
 * rapid-crash session is deferred rather than abandoned, and repeated
 * crashes still land on the circuit breaker's increasing backoff rather than
 * looping unbounded.
 *
 * Extracted out of instance-communication.ts to keep that file within its
 * size ceiling (`npm run check:ts-max-loc`) — mirrors why provider-limit
 * park handling already lives in instance-communication-provider-limit.ts.
 */

import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getLogger } from '../logging/logger';
import { redactRecoveryError } from './instance-recovery-redaction';

const logger = getLogger('InstanceCommunication');

export interface RecentRespawnSuppressionRetryDeps {
  getInstance: CommunicationDependencies['getInstance'];
  queueUpdate: CommunicationDependencies['queueUpdate'];
  onUnexpectedExit: NonNullable<CommunicationDependencies['onUnexpectedExit']>;
  transitionInstanceStatus: (instance: Instance, status: InstanceStatus) => void;
  buildCrashError: (reason: string) => ErrorInfo;
}

/**
 * Schedule a deferred auto-respawn retry for an exit suppressed only because
 * it landed inside the recent-respawn window. Transitions the instance to
 * `respawning` with a `backoff` waitReason immediately (so the UI shows why
 * it is waiting), then retries after `remainingSuppressMs`. Aborts quietly if
 * the instance moved on (terminated, manually restarted, or recovered some
 * other way) before the timer fires.
 */
export function scheduleSuppressedAutoRespawnRetry(
  deps: RecentRespawnSuppressionRetryDeps,
  instanceId: string,
  instance: Instance,
  remainingSuppressMs: number,
): void {
  deps.transitionInstanceStatus(instance, 'respawning');
  instance.processId = null;
  instance.restartCount++;
  logger.info('Deferring auto-respawn until the recent-respawn suppression window elapses', {
    instanceId,
    remainingSuppressMs,
    restartCount: instance.restartCount,
  });
  deps.queueUpdate(instanceId, 'respawning', undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, {
    kind: 'backoff',
    attempt: instance.restartCount,
    retryAt: Date.now() + remainingSuppressMs,
  });

  setTimeout(() => {
    const current = deps.getInstance(instanceId);
    if (!current || current.status !== 'respawning') {
      // The instance moved on while we waited (terminated, manually
      // restarted, or already recovering another way) — don't pile on.
      logger.info('Skipping deferred auto-respawn — instance moved on', {
        instanceId,
        status: current?.status,
      });
      return;
    }
    logger.info('Retrying auto-respawn after recent-respawn suppression window elapsed', { instanceId });
    deps.onUnexpectedExit(instanceId).catch((err) => {
      const safeError = redactRecoveryError(current, err);
      logger.error('Deferred auto-respawn failed', safeError, { instanceId });
      deps.transitionInstanceStatus(current, 'error');
      current.processId = null;
      deps.queueUpdate(
        instanceId,
        'error',
        undefined,
        undefined,
        undefined,
        deps.buildCrashError(`Auto-respawn failed: ${safeError.message}`)
      );
    });
  }, remainingSuppressMs);
}
