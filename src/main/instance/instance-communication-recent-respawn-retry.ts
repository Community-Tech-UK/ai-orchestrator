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
 *
 * `deferExitToRecoveryOwner` (below) is the sibling case: an exit that lands
 * while a recovery owner is mid-respawn.
 */

import type { Instance, InstanceStatus } from '../../shared/types/instance.types';
import type { ErrorInfo } from '../../shared/types/ipc.types';
import type { CommunicationDependencies } from './instance-communication.types';
import { getLogger } from '../logging/logger';
import { errorDiagnostic } from '../logging/source-diagnostics';
import { getSessionMutex } from '../session/session-mutex';
import { redactRecoveryError } from './instance-recovery-redaction';

const logger = getLogger('InstanceCommunication');

/** Statuses a recovery owner settles an instance into; mirrors `shouldAbortRespawn`. */
const RECOVERY_SETTLED_STATUSES: ReadonlySet<InstanceStatus> = new Set<InstanceStatus>([
  'terminated',
  'failed',
  'superseded',
  'cancelled',
  'error',
]);

/**
 * An adapter that exits while its instance is `respawning` and the session
 * lock is held is a recovery owner's replacement dying mid-spawn: the
 * interrupt and unexpected-exit respawns both run `applyRecoveryRespawn`
 * under that lock. The owner observes the failure itself and has a fallback
 * ladder (native resume → fresh session with replay). Settling the exit here
 * first — `respawning` is not auto-respawn eligible, so exit code 0 became a
 * `terminated` with no error or message — tripped the owner's abort check and
 * skipped that fallback, leaving a silently dead session (Copilot `pogg12k15`,
 * 2026-09-28, whose native `session/load` died on stdout EAGAIN).
 *
 * Returns true when the exit was deferred. Once the owner releases the lock,
 * `replay` re-runs normal exit handling unless the owner already settled the
 * instance; the handler's own stale-adapter guard drops the replay if the
 * owner swapped in a fallback adapter.
 */
export function deferExitToRecoveryOwner(
  instanceId: string,
  getInstance: CommunicationDependencies['getInstance'],
  replay: () => void,
): boolean {
  const instance = getInstance(instanceId);
  const mutex = getSessionMutex();
  if (instance?.status !== 'respawning' || !mutex.isLocked(instanceId)) {
    return false;
  }
  logger.info('Adapter exited during a recovery respawn; deferring to the recovery owner', {
    instanceId,
    lockSource: mutex.getLockInfo(instanceId)?.source,
  });
  // Runs from a promise callback, so nothing may escape as an unhandled rejection.
  const settle = (release?: () => void): void => {
    try {
      release?.();
      const current = getInstance(instanceId);
      if (current !== instance || RECOVERY_SETTLED_STATUSES.has(current.status)) {
        logger.info('Deferred adapter exit already settled by the recovery owner', {
          instanceId,
          status: current?.status,
        });
        return;
      }
      replay();
    } catch (error) {
      logger.error('Deferred adapter exit handling failed', undefined, { instanceId, ...errorDiagnostic(redactRecoveryError(instance, error)) });
    }
  };
  // Acquire only to wait for the owner, then release at once. A timeout means
  // the owner is wedged: fall through to normal handling rather than drop it.
  mutex.acquire(instanceId, 'deferred-adapter-exit').then(settle, () => settle());
  return true;
}

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
      logger.error('Deferred auto-respawn failed', undefined, { instanceId, ...errorDiagnostic(safeError) });
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
