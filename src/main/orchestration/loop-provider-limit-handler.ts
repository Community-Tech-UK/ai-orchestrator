import type { LoopState } from '../../shared/types/loop.types';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../shared/types/provider-quota.types';
import type { ProviderLimitLedger } from '../core/system/provider-limit-ledger';
import { EARLY_RESUME_PROBE_MS } from '../instance/instance-provider-limit-handler';
import { getLogger } from '../logging/logger';
import {
  evaluateQuotaThrottle,
  isParkingDecision,
  type QuotaThrottleDecision,
} from './loop-quota-throttle';
import type {
  ProviderLimitResumeScheduleRequest,
  ProviderLimitResumeScheduler,
} from './loop-coordinator.types';

const logger = getLogger('LoopProviderLimitHandler');

export class LoopProviderLimitHandler {
  private quotaSnapshotProvider: (provider: ProviderId) => ProviderQuotaSnapshot | null = () => null;
  private quotaSnapshotRefresher: ((provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>) | null = null;
  private allowOverageProvider: () => boolean = () => false;
  private providerLimitLedger: Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive'> | null = null;
  private resumeCancellers = new Map<string, () => void>();
  private providerLimitResumeScheduler: ProviderLimitResumeScheduler | null = null;
  /**
   * Loops whose next throttle evaluation is skipped because the user pressed
   * Resume. See {@link overrideThrottleOnce}.
   */
  private throttleOverrides = new Set<string>();

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

  setQuotaSnapshotRefresher(fn: ((provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>) | null): void {
    this.quotaSnapshotRefresher = fn;
  }

  /**
   * Pass a function for production wiring: the throttle is evaluated once per
   * iteration, so reading the setting lazily keeps a mid-run toggle from being
   * ignored until the next app start.
   */
  setAllowOverage(allow: boolean | (() => boolean)): void {
    this.allowOverageProvider = typeof allow === 'function' ? allow : () => allow;
  }

  private get allowOverage(): boolean {
    try {
      return this.allowOverageProvider();
    } catch {
      // A settings read must never decide a loop's fate by throwing; the safe
      // default is the conservative one (never ride paid overage).
      return false;
    }
  }

  setProviderLimitLedger(ledger: Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive'> | null): void {
    this.providerLimitLedger = ledger;
  }

  /**
   * Override of the durable known-limit gate (mirrors the instance handler's
   * clearKnownLimitGate). Called on a manual loop resume and on an early-lift
   * probe hit: without it, the next iteration's preflight
   * ({@link maybeParkKnownProviderLimit}) re-parks the loop off the same —
   * possibly stale — ledger row. If the provider is in fact still limited,
   * the next failed iteration re-records a fresh gate.
   */
  clearKnownLimitGate(provider: ProviderId, model: string | null): void {
    const ledger = this.providerLimitLedger;
    if (!ledger) return;
    try {
      const cleared = ledger.clearActive({ provider, model });
      if (cleared > 0) {
        logger.info('Cleared active provider-limit gate for loop resume (user/probe override)', {
          provider,
          model,
          cleared,
        });
      }
    } catch (err) {
      logger.warn('Failed to clear provider-limit gate for loop resume', {
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  setProviderLimitResumeScheduler(scheduler: ProviderLimitResumeScheduler | null): void {
    this.providerLimitResumeScheduler = scheduler;
  }

  /**
   * Drop everything armed for this loop's park: the scheduled auto-resume, the
   * early-lift probe, and any unconsumed one-shot throttle override. Grouping
   * them means no caller can disarm the timer while leaving an override behind
   * for a later, unrelated iteration to spend against.
   */
  clearResumeTimer(loopRunId: string): void {
    this.throttleOverrides.delete(loopRunId);
    const cancel = this.resumeCancellers.get(loopRunId);
    if (!cancel) return;
    cancel();
    this.resumeCancellers.delete(loopRunId);
  }

  /**
   * Everything a user-initiated resume must override, in one call.
   *
   * A park has two independent gates and clearing only one leaves the button
   * looking dead. The durable ledger row is re-read by the pre-flight's
   * `maybeParkKnownProviderLimit`; the live quota snapshot is re-read by the
   * throttle immediately after. Until this cleared both, a manual resume was
   * undone 1-3 ms later by the same snapshot that parked the loop.
   *
   * The throttle override is deliberately one-shot: if the provider really is
   * out of quota the next iteration fails and re-parks, so an override can
   * never strand a loop spending against an exhausted window. Recorded reset
   * times likewise go stale when the user buys quota or applies a reset
   * credit, which is why the ledger clear is provider-wide.
   */
  applyManualResumeOverride(provider: ProviderId, loopRunId: string): void {
    this.clearKnownLimitGate(provider, null);
    this.throttleOverrides.add(loopRunId);
  }

  evaluateLoopQuotaThrottle(state: LoopState): QuotaThrottleDecision {
    if (this.throttleOverrides.delete(state.id)) {
      logger.info('Quota throttle skipped for one iteration by manual resume', {
        loopRunId: state.id,
      });
      return { action: 'continue' };
    }
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
    return this.deriveResumeFromSnapshot(this.readQuotaSnapshot(state));
  }

  /**
   * Avoid rediscovering an active limit observed by another runtime. A loop
   * has no persisted resolved model, so model-scoped lookup is used only for
   * an active downshift; the normal lookup safely consults account scope.
   */
  maybeParkKnownProviderLimit(
    state: LoopState,
    model: string | null = null,
  ): 'parked' | 'terminated' | 'skipped' {
    const knownLimit = this.providerLimitLedger?.getActive({
      provider: this.quotaIdForLoopProvider(state),
      model,
      now: Date.now(),
    });
    if (!knownLimit) return 'skipped';

    return this.handleProviderLimit(state, {
      reason: `Parked on a recorded provider limit from ${knownLimit.source}`,
      resumeAt: knownLimit.resumeAt,
      source: 'quota',
      action: 'throttle',
      recordLimit: false,
    });
  }

  async deriveProviderLimitResumeAfterRefresh(
    state: LoopState,
  ): Promise<{ resumeAt: number | null; windowId?: string }> {
    const provider = this.quotaIdForLoopProvider(state);
    if (this.quotaSnapshotRefresher) {
      try {
        const refreshed = await this.quotaSnapshotRefresher(provider);
        const derived = this.deriveResumeFromSnapshot(refreshed);
        if (derived.resumeAt !== null) return derived;
      } catch (err) {
        logger.debug('Quota refresh failed while deriving provider-limit resume', {
          loopRunId: state.id,
          provider,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return this.deriveProviderLimitResume(state);
  }

  private readQuotaSnapshot(state: LoopState): ProviderQuotaSnapshot | null {
    try {
      return this.quotaSnapshotProvider(this.quotaIdForLoopProvider(state));
    } catch {
      return null;
    }
  }

  private deriveResumeFromSnapshot(
    snapshot: ProviderQuotaSnapshot | null,
  ): { resumeAt: number | null; windowId?: string } {
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
      action: QuotaThrottleDecision['action'] | 'notice' | 'wakeup';
      windowId?: string;
      mustStop?: boolean;
      /** False when parking from an existing durable gate rather than a new signal. */
      recordLimit?: boolean;
    },
  ): 'parked' | 'terminated' | 'skipped' {
    const now = Date.now();
    const reset = opts.resumeAt;

    if (!opts.mustStop) {
      if (reset != null && reset <= now) return 'skipped';
      if (opts.action === 'throttle' && (reset == null || reset <= now)) return 'skipped';
    }

    const willResume = typeof reset === 'number' && reset > now;
    if (willResume && opts.recordLimit !== false) {
      try {
        this.providerLimitLedger?.record({
          provider: this.quotaIdForLoopProvider(state),
          // The loop config does not retain the router's resolved model.
          // Persist account scope instead of guessing a model-specific gate.
          model: null,
          detectedAt: now,
          resumeAt: reset as number,
          source: `loop-${opts.source}`,
          instanceId: state.id,
        });
      } catch (err) {
        // A durability failure must not turn a valid limit signal into a paid retry.
        logger.warn('Failed to record loop provider limit in durable ledger', {
          loopRunId: state.id,
          provider: this.quotaIdForLoopProvider(state),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
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
      state.status = 'provider-limit';
      state.endedAt = null;
      state.endReason = opts.reason;
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

  scheduleWakeupResume(state: LoopState, opts: { resumeAt: number; reason: string }): void {
    this.scheduleResume(state, {
      resumeAt: opts.resumeAt,
      reason: opts.reason,
      source: 'wakeup',
      action: 'wakeup',
    });
  }

  private quotaIdForLoopProvider(state: LoopState): ProviderId {
    return state.config.provider;
  }

  private scheduleResume(
    state: LoopState,
    opts: {
      resumeAt: number;
      reason: string;
      source: 'quota' | 'notice' | 'wakeup';
      action: QuotaThrottleDecision['action'] | 'notice' | 'wakeup';
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

    // Quota parks additionally probe for an early lift (reset credit applied,
    // quota purchased) so the loop doesn't overstay a stale recorded reset.
    // Wakeup parks are scheduled sleeps, not limits — never probe those.
    const stopEarlyResumeProbe = opts.source === 'wakeup'
      ? () => {}
      : this.startEarlyResumeProbe(state, opts.resumeAt);
    const cancelSchedule = cancel;
    this.resumeCancellers.set(state.id, () => {
      cancelSchedule();
      stopEarlyResumeProbe();
    });
  }

  /**
   * Whether a fresh snapshot would let the pre-iteration pre-flight actually
   * spawn an iteration.
   *
   * This must be the exact inverse of the parking decision, which is why it
   * calls the same evaluator rather than applying its own rule. The previous
   * test (`snapshotShowsLimitLifted`: every window below 100%) disagreed with
   * the throttle across the whole 90-100% band and on the overage guard
   * entirely, so the probe resumed loops the pre-flight then re-parked
   * milliseconds later — an endless 3-minute cycle in the logs.
   *
   * A missing, failed or empty snapshot proves nothing, so it holds the park;
   * note this is the opposite of the throttle's own default, which lets a loop
   * already running continue when the usage endpoint is flaky.
   */
  private snapshotAllowsResume(snapshot: ProviderQuotaSnapshot | null): boolean {
    if (!snapshot || !snapshot.ok || snapshot.windows.length === 0) return false;
    return !isParkingDecision(
      evaluateQuotaThrottle(snapshot, { allowOverage: this.allowOverage }),
    );
  }

  /**
   * While parked on a provider limit, periodically re-probe the live quota and
   * resume as soon as a fresh snapshot would let an iteration run — the
   * recorded resumeAt then acts only as a fallback ceiling. Mirrors the
   * regular-session probe in instance-provider-limit-handler.ts: skips once
   * the scheduled resume is imminent, never overlaps requests, and treats
   * probe failures as "still limited".
   */
  private startEarlyResumeProbe(state: LoopState, resumeAt: number): () => void {
    const refresher = this.quotaSnapshotRefresher;
    if (!refresher) return () => {};

    const loopRunId = state.id;
    const provider = this.quotaIdForLoopProvider(state);
    let inFlight = false;
    const timer = setInterval(() => {
      if (!this.resumeCancellers.has(loopRunId) || inFlight) return;
      if (resumeAt - Date.now() < 60_000) return; // scheduled resume is about to fire anyway
      inFlight = true;
      void refresher(provider)
        .then((snapshot) => {
          if (!this.resumeCancellers.has(loopRunId) || !this.snapshotAllowsResume(snapshot)) return;
          logger.info('Loop provider limit lifted early per fresh quota probe; resuming now', {
            loopRunId,
            provider,
            recordedResumeAt: resumeAt,
          });
          // Drop the durable gate first, or the next iteration's ledger
          // preflight instantly re-parks the freshly resumed loop.
          this.clearKnownLimitGate(provider, null);
          this.clearResumeTimer(loopRunId);
          this.deps.resumeLoop(loopRunId);
        })
        .catch(() => {
          // Probe failure proves nothing — keep the park and retry next tick.
        })
        .finally(() => {
          inFlight = false;
        });
    }, EARLY_RESUME_PROBE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
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
