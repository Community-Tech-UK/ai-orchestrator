import type { LoopState } from '../../shared/types/loop.types';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../shared/types/provider-quota.types';
import { getLogger } from '../logging/logger';
import {
  evaluateQuotaThrottle,
  type QuotaThrottleDecision,
} from './loop-quota-throttle';
import type {
  ProviderLimitResumeScheduleRequest,
  ProviderLimitResumeScheduler,
} from './loop-coordinator.types';

const logger = getLogger('LoopProviderLimitHandler');

export class LoopProviderLimitHandler {
  private quotaSnapshotProvider: (provider: ProviderId) => ProviderQuotaSnapshot | null = () => null;
  private allowOverage = false;
  private resumeCancellers = new Map<string, () => void>();
  private providerLimitResumeScheduler: ProviderLimitResumeScheduler | null = null;

  constructor(private readonly deps: {
    emit: (eventName: string, payload: unknown) => void;
    cloneStateForBroadcast: (state: LoopState) => LoopState;
    setConvergenceNote: (loopRunId: string, reason: string) => void;
    terminate: (state: LoopState, status: LoopState['status'], reason?: string) => void;
    resumeLoop: (loopRunId: string) => boolean;
  }) {}

  setQuotaSnapshotProvider(fn: (provider: ProviderId) => ProviderQuotaSnapshot | null): void {
    this.quotaSnapshotProvider = fn;
  }

  setAllowOverage(allow: boolean): void {
    this.allowOverage = allow;
  }

  setProviderLimitResumeScheduler(scheduler: ProviderLimitResumeScheduler | null): void {
    this.providerLimitResumeScheduler = scheduler;
  }

  clearResumeTimer(loopRunId: string): void {
    const cancel = this.resumeCancellers.get(loopRunId);
    if (!cancel) return;
    cancel();
    this.resumeCancellers.delete(loopRunId);
  }

  evaluateLoopQuotaThrottle(state: LoopState): QuotaThrottleDecision {
    let snapshot: ProviderQuotaSnapshot | null = null;
    try {
      snapshot = this.quotaSnapshotProvider(this.quotaIdForLoopProvider(state));
    } catch (err) {
      logger.debug('Quota snapshot provider threw; skipping throttle', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: 'continue' };
    }
    return evaluateQuotaThrottle(snapshot, { allowOverage: this.allowOverage });
  }

  deriveProviderLimitResume(state: LoopState): { resumeAt: number | null; windowId?: string } {
    let snapshot: ProviderQuotaSnapshot | null = null;
    try {
      snapshot = this.quotaSnapshotProvider(this.quotaIdForLoopProvider(state));
    } catch {
      snapshot = null;
    }
    if (!snapshot || !snapshot.ok) return { resumeAt: null };

    const now = Date.now();
    let best: { resetsAt: number; id: string } | null = null;
    let bestPct = -1;
    for (const w of snapshot.windows) {
      if (w.resetsAt == null || w.resetsAt <= now || w.limit <= 0) continue;
      const pct = (w.used / w.limit) * 100;
      if (pct > bestPct) {
        bestPct = pct;
        best = { resetsAt: w.resetsAt, id: w.id };
      }
    }
    return best ? { resumeAt: best.resetsAt, windowId: best.id } : { resumeAt: null };
  }

  handleProviderLimit(
    state: LoopState,
    opts: {
      reason: string;
      resumeAt: number | null;
      source: 'quota' | 'notice';
      action: QuotaThrottleDecision['action'] | 'notice';
      windowId?: string;
      mustStop?: boolean;
    },
  ): 'parked' | 'terminated' | 'skipped' {
    const now = Date.now();
    const reset = opts.resumeAt;

    if (!opts.mustStop) {
      if (reset != null && reset <= now) return 'skipped';
      if (opts.action === 'throttle' && (reset == null || reset <= now)) return 'skipped';
    }

    const willResume = typeof reset === 'number' && reset > now;
    this.deps.emit('loop:provider-limit', {
      loopRunId: state.id,
      reason: opts.reason,
      source: opts.source,
      action: opts.action,
      windowId: opts.windowId,
      resumeAt: willResume ? reset : null,
      willResume,
    });

    if (willResume) {
      state.status = 'paused';
      this.deps.setConvergenceNote(state.id, opts.reason);
      this.scheduleResume(state, {
        resumeAt: reset as number,
        reason: opts.reason,
        source: opts.source,
        action: opts.action,
        windowId: opts.windowId,
      });
      this.deps.emit('loop:state-changed', {
        loopRunId: state.id,
        state: this.deps.cloneStateForBroadcast(state),
      });
      logger.info('Loop parked on provider limit; will auto-resume at window reset', {
        loopRunId: state.id,
        resumeAt: reset,
        source: opts.source,
      });
      return 'parked';
    }

    this.deps.terminate(state, 'provider-limit', opts.reason);
    return 'terminated';
  }

  private quotaIdForLoopProvider(state: LoopState): ProviderId {
    return state.config.provider;
  }

  private scheduleResume(
    state: LoopState,
    opts: {
      resumeAt: number;
      reason: string;
      source: 'quota' | 'notice';
      action: QuotaThrottleDecision['action'] | 'notice';
      windowId?: string;
    },
  ): void {
    this.clearResumeTimer(state.id);
    const request: ProviderLimitResumeScheduleRequest = {
      loopRunId: state.id,
      chatId: state.chatId,
      workspaceCwd: state.config.workspaceCwd,
      provider: this.quotaIdForLoopProvider(state),
      resumeAt: opts.resumeAt,
      reason: opts.reason,
      source: opts.source,
      action: opts.action,
      windowId: opts.windowId,
    };

    let cancel: (() => void) | void = undefined;
    try {
      cancel = this.providerLimitResumeScheduler?.(request);
    } catch (err) {
      logger.warn('Provider-limit resume scheduler failed; falling back to in-process timer', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!cancel) cancel = this.scheduleInProcessResume(state.id, opts.resumeAt);
    this.resumeCancellers.set(state.id, cancel);
  }

  private scheduleInProcessResume(loopRunId: string, resumeAt: number): () => void {
    const delay = Math.max(0, resumeAt - Date.now()) + 5_000;
    const timer = setTimeout(() => {
      this.resumeCancellers.delete(loopRunId);
      const resumed = this.deps.resumeLoop(loopRunId);
      logger.info('Loop auto-resume timer fired after provider-limit park', {
        loopRunId,
        resumed,
      });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }
}
