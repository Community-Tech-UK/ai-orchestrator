import { getLogger } from '../logging/logger';

const logger = getLogger('SessionMutex');

const LONG_HOLD_WARNING_MS = 30_000;

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

export class SessionMutex {
  private chains = new Map<string, Promise<void>>();
  private holders = new Map<string, LockInfo>();
  private forceResolvers = new Map<string, () => void>();

  async acquire(
    instanceId: string,
    source: string,
    owner?: SessionLockOwnerMetadata,
  ): Promise<() => void> {
    const prev = this.chains.get(instanceId) ?? Promise.resolve();

    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // Chain: wait for previous holder, then register ourselves
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

    await acquisition;

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
