import { getLogger } from '../logging/logger';

const logger = getLogger('SessionMutex');

const LONG_HOLD_WARNING_MS = 30_000;
/** Default maximum wait time for a new acquisition before giving up. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;

interface LockInfo {
  source: string;
  acquiredAt: number;
  owner?: {
    operation?: string;
    recoveryReason?: string;
    turnId?: string;
    adapterGeneration?: number;
  };
  warningTimer?: NodeJS.Timeout;
}

export interface SessionLockOwnerMetadata {
  operation?: string;
  recoveryReason?: string;
  turnId?: string;
  adapterGeneration?: number;
}

/** Thrown when a SessionMutex.acquire() call exceeds its timeout. */
export class SessionMutexTimeoutError extends Error {
  constructor(
    public readonly instanceId: string,
    public readonly waitingSource: string,
    public readonly timeoutMs: number,
    public readonly holderInfo?: { source: string; acquiredAt: number; durationMs: number; owner?: SessionLockOwnerMetadata },
  ) {
    super(
      `SessionMutex acquire timeout after ${timeoutMs}ms waiting for "${instanceId}" ` +
        `(caller: "${waitingSource}", holder: "${holderInfo?.source ?? 'unknown'}", ` +
        `held for ${holderInfo?.durationMs ?? '?'}ms)`,
    );
    this.name = 'SessionMutexTimeoutError';
  }
}

export function isSessionMutexTimeout(err: unknown): err is SessionMutexTimeoutError {
  return err instanceof SessionMutexTimeoutError;
}

export class SessionMutex {
  private chains = new Map<string, Promise<void>>();
  private holders = new Map<string, LockInfo>();
  private forceResolvers = new Map<string, () => void>();

  /**
   * Acquire a lock for `instanceId`.
   *
   * @param timeoutMs Maximum wait time before rejecting (default 120 s).
   *   Pass `0` to wait indefinitely (not recommended — prefer a large value).
   *   On timeout a `SessionMutexTimeoutError` is thrown; the stale holder's
   *   info is included for diagnostics.  Callers that know the previous holder
   *   is dead can call `forceRelease()` and retry.
   */
  async acquire(
    instanceId: string,
    source: string,
    owner?: SessionLockOwnerMetadata,
    timeoutMs = DEFAULT_ACQUIRE_TIMEOUT_MS,
  ): Promise<() => void> {
    const prev = this.chains.get(instanceId) ?? Promise.resolve();

    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // Chain: wait for previous holder, then register ourselves.
    // The chain settles when the previous holder calls its release function.
    const acquisition = prev.then(() => {
      const info: LockInfo = {
        source,
        acquiredAt: Date.now(),
        owner,
      };

      info.warningTimer = setTimeout(() => {
        logger.warn('Lock held for >30s', {
          instanceId,
          source,
          owner,
          durationMs: Date.now() - info.acquiredAt,
        });
      }, LONG_HOLD_WARNING_MS);
      if (info.warningTimer.unref) info.warningTimer.unref();

      this.holders.set(instanceId, info);

      // Store force-resolver so forceRelease can unblock
      this.forceResolvers.set(instanceId, releaseFn);
    });

    this.chains.set(instanceId, next);

    if (timeoutMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const holderInfo = this.getLockInfo(instanceId);
          const err = new SessionMutexTimeoutError(
            instanceId,
            source,
            timeoutMs,
            holderInfo ?? undefined,
          );
          logger.warn('SessionMutex acquire timed out', {
            instanceId,
            source,
            owner,
            timeoutMs,
            holderSource: holderInfo?.source,
            holderDurationMs: holderInfo?.durationMs,
            holderOwner: holderInfo?.owner,
          });
          reject(err);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();

        acquisition.then(() => {
          clearTimeout(timer);
          resolve();
        }, reject);
      });
    } else {
      await acquisition;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      const info = this.holders.get(instanceId);
      if (info?.warningTimer) clearTimeout(info.warningTimer);
      this.holders.delete(instanceId);
      this.forceResolvers.delete(instanceId);

      releaseFn();
    };
  }

  forceRelease(instanceId: string): void {
    const info = this.holders.get(instanceId);
    if (info?.warningTimer) clearTimeout(info.warningTimer);
    this.holders.delete(instanceId);

    const resolver = this.forceResolvers.get(instanceId);
    if (resolver) {
      this.forceResolvers.delete(instanceId);
      logger.warn('Force-released lock', { instanceId, source: info?.source, owner: info?.owner });
      resolver();
    }
  }

  isLocked(instanceId: string): boolean {
    return this.holders.has(instanceId);
  }

  getLockInfo(instanceId: string): {
    source: string;
    acquiredAt: number;
    durationMs: number;
    owner?: SessionLockOwnerMetadata;
  } | null {
    const info = this.holders.get(instanceId);
    if (!info) return null;
    return {
      source: info.source,
      acquiredAt: info.acquiredAt,
      durationMs: Date.now() - info.acquiredAt,
      owner: info.owner,
    };
  }
}

// Singleton
let instance: SessionMutex | null = null;

export function getSessionMutex(): SessionMutex {
  if (!instance) {
    instance = new SessionMutex();
  }
  return instance;
}

export function _resetSessionMutexForTesting(): void {
  instance = null;
}
