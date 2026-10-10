import { isLogicalMiMoModel } from '../../shared/types/provider-account.types';
import { resolveModelForInvocation } from './invocation-model-resolver';
import type { LoopState } from '../../shared/types/loop.types';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../shared/types/provider-quota.types';
import type { ProviderLimitLedger } from '../core/system/provider-limit-ledger';
import { ASSUMED_ACCOUNT_LIMIT_MS } from '../instance/instance-provider-limit-handler';
import { startLoopProviderLimitResumeProbe } from './loop-provider-limit-resume-probe';
import { resolveLoopProviderLimitScope, type LoopProviderLimitScope } from './loop-provider-limit-scope';
import {
  getLoopAccountFailover,
  type LoopAccountFailover,
} from '../providers/account-pool/loop-account-failover';
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
type LoopAccounts = Pick<LoopAccountFailover, 'currentProfileId' | 'trySwitch'>
  & Partial<Pick<LoopAccountFailover, 'currentModel' | 'hasAccountPool'>>;

export type LoopProviderLimitOutcome = 'parked' | 'terminated' | 'skipped' | 'switched-account' | 'switched-provider';

export class LoopProviderLimitHandler {
  private quotaSnapshotProvider: (provider: ProviderId, accountProfileId?: string | null) => ProviderQuotaSnapshot | null = () => null;
  private quotaSnapshotRefresher: ((provider: ProviderId, accountProfileId?: string | null) => Promise<ProviderQuotaSnapshot | null>) | null = null;
  private loopAccountFailover: LoopAccounts | null = null;
  private allowOverageProvider: () => boolean = () => false;
  private providerLimitLedger: Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive'> | null = null;
  private readonly parkedScopes = new Map<string, LoopProviderLimitScope & { provider: ProviderId }>();
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
    /** The next attempt runs in a brand-new session on the new account and needs the full prompt bootstrap. */
    requestContextReset?: (loopRunId: string) => void;
    /**
     * Opt-in provider failover (`config.failover`). True = the run's provider
     * was switched and the next attempt should run on it instead of parking.
     */
    tryProviderFailover?: (state: LoopState, reason: string) => boolean;
  }) {}

  setQuotaSnapshotProvider(fn: (provider: ProviderId, accountProfileId?: string | null) => ProviderQuotaSnapshot | null): void {
    this.quotaSnapshotProvider = fn;
  }

  setQuotaSnapshotRefresher(fn: ((provider: ProviderId, accountProfileId?: string | null) => Promise<ProviderQuotaSnapshot | null>) | null): void {
    this.quotaSnapshotRefresher = fn;
  }

  /** Account-pool failover for loops (D9). Defaults to the shared instance. */
  setLoopAccountFailover(failover: LoopAccounts | null): void {
    this.loopAccountFailover = failover;
  }

  private accounts(): LoopAccounts {
    return this.loopAccountFailover ?? getLoopAccountFailover();
  }

  /** The account-pool profile the loop's last iteration ran on; null outside a pool. */
  private loopProfileId(state: LoopState): string | null {
    try {
      return this.accounts().currentProfileId(state.id, this.quotaIdForLoopProvider(state));
    } catch {
      return null;
    }
  }

  private currentLoopModel(state: LoopState): string | null {
    return this.accounts().currentModel?.(state.id, state.config.provider) ?? null;
  }

  /** Preventive gates run before the next adapter exists: resolve live settings now. */
  private nextOpenCodeModel(state: LoopState, requestedModel: string | null): string | null {
    try {
      return resolveModelForInvocation({
        cliType: 'opencode',
        requestedProvider: 'opencode',
        payloadModel: requestedModel ?? undefined,
        prompt: state.config.initialPrompt ?? '',
        routingIntent: 'loop',
        routingPolicyKey: 'loop',
      })?.trim() || null;
    } catch {
      return null;
    }
  }

  private limitScope(state: LoopState, modelOverride?: string | null): LoopProviderLimitScope {
    return resolveLoopProviderLimitScope(state.config.provider,
      modelOverride === undefined ? this.currentLoopModel(state) : modelOverride, this.loopProfileId(state));
  }

  private preventiveMiMoScopeKnown(state: LoopState): boolean {
    // A first/replacement pooled spawn may choose any eligible profile. Do
    // not treat missing attribution as legacy. A legacy-only installation has
    // no such choice, so its established global prechecks remain applicable.
    return this.currentQuotaApplies(state) || this.accounts().hasAccountPool?.('opencode') === false;
  }

  private currentQuotaApplies(state: LoopState): boolean {
    return state.config.provider !== 'opencode'
      || this.loopProfileId(state) !== null || isLogicalMiMoModel(this.currentLoopModel(state));
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
  clearKnownLimitGate(provider: ProviderId, model: string | null, accountProfileId: string | null = null): void {
    const ledger = this.providerLimitLedger;
    if (!ledger) return;
    try {
      const nativeOpenCode = provider === 'opencode' && model !== null && !isLogicalMiMoModel(model) && accountProfileId === null;
      const cleared = ledger.clearActive({ provider, model, accountProfileId,
        ...(nativeOpenCode ? { includeAccountWideFallback: false } : {}),
        ...(provider === 'opencode' && model === null ? { accountWideOnly: true } : {}),
      });
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
   * Disarm this loop's park: the scheduled auto-resume, the
   * early-lift probe, and any unconsumed one-shot throttle override. Grouping
   * them means no caller can disarm the timer while leaving an override behind
   * for a later, unrelated iteration to spend against. Active-park callers
   * may retain the scope until manual resume; terminal cleanup removes it.
   */
  clearResumeTimer(loopRunId: string, preserveParkedScope = false): void {
    this.throttleOverrides.delete(loopRunId);
    if (!preserveParkedScope) this.parkedScopes.delete(loopRunId);
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
   * credit. MiMo clears the account scope; unrelated native models clear only
   * their exact model, retaining the legacy MiMo account-wide gate.
   */
  applyManualResumeOverride(provider: ProviderId, loopRunId: string): void {
    let profileId: string | null = null;
    try {
      profileId = this.accounts().currentProfileId(loopRunId, provider);
    } catch {
      profileId = null;
    }
    const parked = this.parkedScopes.get(loopRunId);
    this.parkedScopes.delete(loopRunId);
    const model = provider === 'opencode' ? this.accounts().currentModel?.(loopRunId, provider) ?? null : null;
    if (parked?.provider === provider) {
      if (parked.recordable) this.clearKnownLimitGate(provider, parked.model, parked.accountProfileId);
    } else if (provider !== 'opencode' || profileId !== null || model !== null) {
      this.clearKnownLimitGate(provider, model, profileId);
    }
    this.throttleOverrides.add(loopRunId);
  }

  evaluateLoopQuotaThrottle(state: LoopState, model: string | null = null): QuotaThrottleDecision & { limitScope?: LoopProviderLimitScope } {
    if (this.throttleOverrides.delete(state.id)) {
      logger.info('Quota throttle skipped for one iteration by manual resume', {
        loopRunId: state.id,
      });
      return { action: 'continue' };
    }
    const resolvedModel = state.config.provider === 'opencode' ? this.nextOpenCodeModel(state, model) : model;
    if (state.config.provider === 'opencode' && (!isLogicalMiMoModel(resolvedModel) || !this.preventiveMiMoScopeKnown(state))) {
      return { action: 'continue' };
    }
    const scope = this.limitScope(state, resolvedModel);
    let snapshot: ProviderQuotaSnapshot | null = null;
    try {
      snapshot = this.quotaSnapshotProvider(this.quotaIdForLoopProvider(state), scope.accountProfileId);
    } catch (err) {
      logger.debug('Quota snapshot provider threw; skipping throttle', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: 'continue' };
    }
    const decision = evaluateQuotaThrottle(snapshot, { allowOverage: this.allowOverage });
    return isParkingDecision(decision) ? { ...decision, limitScope: scope } : decision;
  }

  deriveProviderLimitResume(state: LoopState): { resumeAt: number | null; windowId?: string } {
    return this.deriveResumeFromSnapshot(this.readQuotaSnapshot(state));
  }

  /**
   * Avoid rediscovering an active limit observed by another runtime. OpenCode
   * resolves the next invocation from live settings before looking up its
   * account or exact native-model scope; other providers keep the prior gate.
   */
  maybeParkKnownProviderLimit(
    state: LoopState,
    model: string | null = null,
  ): LoopProviderLimitOutcome {
    const resolvedModel = state.config.provider === 'opencode' ? this.nextOpenCodeModel(state, model) : model;
    if (state.config.provider === 'opencode'
      && (resolvedModel === null || (isLogicalMiMoModel(resolvedModel) && !this.preventiveMiMoScopeKnown(state)))) return 'skipped';
    const scope = this.limitScope(state, resolvedModel);
    if (!scope.recordable) return 'skipped';
    const knownLimit = this.providerLimitLedger?.getActive({
      provider: this.quotaIdForLoopProvider(state),
      model: state.config.provider === 'opencode' ? scope.model : model,
      accountProfileId: scope.accountProfileId,
      now: Date.now(),
    });
    if (!knownLimit) return 'skipped';
    if (state.config.provider === 'opencode' && !isLogicalMiMoModel(resolvedModel)
      && (knownLimit.model !== resolvedModel || (knownLimit.accountProfileId != null && knownLimit.accountProfileId !== 'legacy'))) {
      return 'skipped';
    }

    return this.handleProviderLimit(state, {
      reason: `Parked on a recorded provider limit from ${knownLimit.source}`,
      resumeAt: knownLimit.resumeAt,
      source: 'quota',
      action: 'throttle',
      recordLimit: false,
      limitScope: scope,
    });
  }

  async deriveProviderLimitResumeAfterRefresh(
    state: LoopState,
  ): Promise<{ resumeAt: number | null; windowId?: string }> {
    const provider = this.quotaIdForLoopProvider(state);
    if (!this.currentQuotaApplies(state)) return { resumeAt: null };
    if (this.quotaSnapshotRefresher) {
      try {
        const refreshed = await this.quotaSnapshotRefresher(provider, this.loopProfileId(state));
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
    if (!this.currentQuotaApplies(state)) return null;
    try {
      return this.quotaSnapshotProvider(this.quotaIdForLoopProvider(state), this.loopProfileId(state));
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
      /**
       * Account pools and opt-in provider failover: move the loop to another
       * account, then another provider, instead of parking. False for burst
       * throttles (a server `retry-after`), which must not rotate either.
       */
      accountFailover?: boolean;
      /** Resolved next model for callers without an accepted preventive scope. */
      limitModel?: string | null;
      /** Immutable scope accepted by a preventive check before the next adapter exists. */
      limitScope?: LoopProviderLimitScope;
    },
  ): LoopProviderLimitOutcome {
    const now = Date.now();
    const reset = opts.resumeAt;

    if (!opts.mustStop) {
      if (reset != null && reset <= now) return 'skipped';
      if (opts.action === 'throttle' && (reset == null || reset <= now)) return 'skipped';
    }

    const willResume = typeof reset === 'number' && reset > now;
    const scope = opts.limitScope ?? this.limitScope(state, opts.limitModel);
    const accountProfileId = scope.accountProfileId;
    const accountSwitch = accountProfileId !== null && opts.accountFailover !== false
      ? this.switchLoopAccount(state, opts, accountProfileId, scope, now) : null;
    if (accountSwitch?.switched) return 'switched-account';
    // Record before any provider switch so the failover veto and a later
    // switch back both see this provider as limited.
    if (willResume && scope.recordable && opts.recordLimit !== false && !accountSwitch?.recorded) {
      try {
        this.providerLimitLedger?.record({
          provider: this.quotaIdForLoopProvider(state),
          // MiMo is account-wide; unrelated native models retain exact scope.
          model: scope.recordModel,
          accountProfileId,
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
    if (opts.accountFailover !== false && this.switchLoopProvider(state, accountSwitch?.recorded ? { ...opts, recordLimit: false } : opts, scope, now)) {
      return 'switched-provider';
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
      }, scope);
      this.parkedScopes.set(state.id, { provider: state.config.provider, ...scope });
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

  /**
   * Bench the loop's exhausted account and let the next iteration re-route to
   * another account of the pool. False leaves the park path untouched.
   */
  private switchLoopAccount(
    state: LoopState,
    opts: { reason: string; resumeAt: number | null; source: 'quota' | 'notice'; recordLimit?: boolean },
    accountProfileId: string,
    scope: LoopProviderLimitScope,
    now: number,
  ): { switched: boolean; recorded: boolean } {
    const provider = this.quotaIdForLoopProvider(state);
    let recorded = false;
    if (opts.recordLimit !== false && this.providerLimitLedger) {
      try {
        this.providerLimitLedger.record({
          provider,
          model: null,
          accountProfileId,
          detectedAt: now,
          resumeAt: typeof opts.resumeAt === 'number' && opts.resumeAt > now ? opts.resumeAt : now + ASSUMED_ACCOUNT_LIMIT_MS,
          source: `loop-${opts.source}`,
          instanceId: state.id,
        });
        recorded = true;
      } catch (err) {
        logger.warn('Failed to record loop account limit before switching', {
          loopRunId: state.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    let switched = false;
    try {
      switched = this.accounts().trySwitch({
        loopRunId: state.id,
        provider,
        model: provider === 'opencode' ? scope.model : null,
        iteration: state.totalIterations,
        reason: opts.reason,
        allowCredits: this.allowOverage,
      });
    } catch (err) {
      logger.warn('Loop account failover failed; parking instead', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!switched) return { switched, recorded };
    this.deps.requestContextReset?.(state.id);
    this.deps.emit('loop:activity', {
      loopRunId: state.id,
      seq: state.totalIterations,
      stage: state.currentStage,
      timestamp: now,
      kind: 'status',
      message: 'Account usage limit reached — continuing on another account in the pool',
      detail: { reason: opts.reason, fromAccountProfileId: accountProfileId },
    });
    logger.info('Loop switched account on provider limit', { loopRunId: state.id, provider, fromAccountProfileId: accountProfileId });
    return { switched, recorded };
  }

  private switchLoopProvider(
    state: LoopState,
    opts: { reason: string; resumeAt: number | null; source: 'quota' | 'notice'; recordLimit?: boolean },
    scope: LoopProviderLimitScope,
    now: number,
  ): boolean {
    if (!this.deps.tryProviderFailover) return false;
    const from = this.quotaIdForLoopProvider(state);
    try {
      const switched = this.deps.tryProviderFailover(state, opts.reason);
      // With no known reset the ledger was not written above; record an assumed
      // window (as account switches do) so a later switch cannot pick this
      // provider straight back.
      const recorded = typeof opts.resumeAt === 'number' && opts.resumeAt > now;
      if (switched && !recorded && scope.recordable && opts.recordLimit !== false) {
        try {
          this.providerLimitLedger?.record({
            provider: from,
            model: scope.recordModel,
            accountProfileId: scope.accountProfileId,
            detectedAt: now,
            resumeAt: now + ASSUMED_ACCOUNT_LIMIT_MS,
            source: `loop-${opts.source}`,
            instanceId: state.id,
          });
        } catch (err) {
          logger.warn('Failed to record loop provider limit after switching provider', {
            loopRunId: state.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return switched;
    } catch (err) {
      logger.warn('Loop provider failover threw on provider limit; parking instead', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
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
    scope = this.limitScope(state),
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
      ? () => { /* scheduled wakeup has no quota probe */ }
      : this.startEarlyResumeProbe(state, opts.resumeAt, scope);
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
  private startEarlyResumeProbe(state: LoopState, resumeAt: number, scope: LoopProviderLimitScope): () => void {
    const refresher = this.quotaSnapshotRefresher;
    if (!refresher || !scope.quotaApplies) return () => { /* no applicable quota probe */ };

    const loopRunId = state.id;
    const provider = this.quotaIdForLoopProvider(state);
    const accountProfileId = scope.accountProfileId;
    return startLoopProviderLimitResumeProbe({
      provider, accountProfileId, resumeAt, refresh: refresher,
      isArmed: () => this.resumeCancellers.has(loopRunId),
      snapshotAllowsResume: (snapshot) => this.snapshotAllowsResume(snapshot),
      onLifted: () => {
        logger.info('Loop provider limit lifted early per fresh quota probe; resuming now', {
          loopRunId,
          provider,
          recordedResumeAt: resumeAt,
        });
        // Drop the durable gate first, or the next iteration's ledger
        // preflight instantly re-parks the freshly resumed loop.
        this.clearKnownLimitGate(provider, scope.model, accountProfileId);
        this.clearResumeTimer(loopRunId);
        this.deps.resumeLoop(loopRunId);
      },
    });
  }

  private scheduleInProcessResume(loopRunId: string, resumeAt: number): () => void {
    const delay = Math.max(0, resumeAt - Date.now()) + 5_000;
    const timer = setTimeout(() => {
      const cancel = this.resumeCancellers.get(loopRunId);
      this.resumeCancellers.delete(loopRunId);
      try {
        cancel?.();
        const resumed = this.deps.resumeLoop(loopRunId);
        logger.info('Loop auto-resume timer fired after provider-limit park', { loopRunId, resumed });
      } finally {
        this.parkedScopes.delete(loopRunId);
      }
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }
}
