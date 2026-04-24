/**
 * SessionAutoSaveCoordinator
 *
 * Owns periodic auto-save scheduling, per-session pending save timers, and
 * post-resume deferral windows. Persistence stays injected by the continuity
 * manager so this class is direct-testable without disk I/O.
 */

export interface AutoSaveConfig {
  autoSaveEnabled: boolean;
  autoSaveIntervalMs: number;
}

export interface SessionAutoSaveDeps {
  getDirtyIds: () => Iterable<string>;
  hasDirty: (instanceId: string) => boolean;
  isLocked: (instanceId: string) => boolean;
  saveState: (instanceId: string) => Promise<void>;
  onSaveError: (instanceId: string, error: unknown) => void;
  getNow?: () => number;
  getJitterDelayMs?: () => number;
}

export class SessionAutoSaveCoordinator {
  private globalTimer: NodeJS.Timeout | null = null;
  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private deferredUntil = 0;
  private config: AutoSaveConfig = {
    autoSaveEnabled: false,
    autoSaveIntervalMs: 60_000,
  };

  constructor(private readonly deps: SessionAutoSaveDeps) {}

  get pendingCount(): number {
    return this.pendingTimers.size;
  }

  get deferredUntilTimestamp(): number {
    return this.deferredUntil;
  }

  start(config: AutoSaveConfig): void {
    this.config = { ...config };
    if (!this.config.autoSaveEnabled || this.globalTimer !== null) {
      return;
    }

    this.globalTimer = setInterval(() => {
      this.scheduleDirtyStates();
    }, this.config.autoSaveIntervalMs);

    this.globalTimer.unref?.();
  }

  reconfigure(config: AutoSaveConfig): void {
    this.config = { ...config };
    this.stopGlobalTimer();
    this.clearPendingAutoSaveTimers();

    if (this.config.autoSaveEnabled) {
      this.start(this.config);
    }
  }

  stop(): void {
    this.stopGlobalTimer();
    this.clearPendingAutoSaveTimers();
  }

  defer(graceMs: number): number {
    const now = this.deps.getNow?.() ?? Date.now();
    this.deferredUntil = now + Math.max(0, graceMs);
    return this.deferredUntil;
  }

  getDeferralRemainingMs(now = this.deps.getNow?.() ?? Date.now()): number {
    return Math.max(0, this.deferredUntil - now);
  }

  queueAutoSave(instanceId: string, delayMs: number): void {
    if (this.pendingTimers.has(instanceId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(instanceId);

      if (!this.deps.hasDirty(instanceId)) {
        return;
      }

      const remainingDeferralMs = this.getDeferralRemainingMs();
      if (remainingDeferralMs > 0) {
        this.queueAutoSave(instanceId, remainingDeferralMs);
        return;
      }

      this.deps.saveState(instanceId).catch((error) => {
        this.deps.onSaveError(instanceId, error);
      });
    }, Math.max(0, Math.ceil(delayMs)));

    timer.unref?.();
    this.pendingTimers.set(instanceId, timer);
  }

  clearPendingAutoSaveTimer(instanceId: string): void {
    const timer = this.pendingTimers.get(instanceId);
    if (!timer) {
      return;
    }

    clearTimeout(timer);
    this.pendingTimers.delete(instanceId);
  }

  clearPendingAutoSaveTimers(): void {
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }

  private scheduleDirtyStates(): void {
    if (this.getDeferralRemainingMs() > 0) {
      return;
    }

    for (const instanceId of this.deps.getDirtyIds()) {
      if (this.deps.isLocked(instanceId)) {
        continue;
      }

      this.queueAutoSave(instanceId, this.deps.getJitterDelayMs?.() ?? Math.random() * 10_000);
    }
  }

  private stopGlobalTimer(): void {
    if (this.globalTimer === null) {
      return;
    }

    clearInterval(this.globalTimer);
    this.globalTimer = null;
  }
}
