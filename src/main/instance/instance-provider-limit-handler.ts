import type { InstanceProvider, InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { ProviderLimitLedger } from '../core/system/provider-limit-ledger';
import { getLogger } from '../logging/logger';
import type {
  AccountFailoverCoordinator,
  AccountFailoverParams,
} from '../providers/account-pool/account-failover-coordinator';
import { accountFailoverNote, type AccountFailoverNote } from './account-failover-notes';
import { isPooledProvider } from '../../shared/types/provider-account.types';
import { clearLimitLiftedSinceRecorded, snapshotShowsLimitLifted } from './provider-limit-lift';
import {
  buildProviderLimitContinuationPrompt,
  scheduleInstanceProviderLimitResume,
  type InstanceProviderLimitResumeRequest,
} from './instance-provider-limit-resume-scheduler';

const logger = getLogger('InstanceProviderLimitHandler');
/**
 * Suppress a duplicate resume of the same instance within this window. The
 * durable automation and the in-process timer both fire ~5s after the reset;
 * `cancel()` normally disarms the sibling, but a fire that races the cancel is
 * caught here so we never re-send the same turn twice.
 */
const RESUME_DEDUPE_MS = 60_000;

/**
 * How often a parked session re-probes the provider's live quota for an early
 * lift. The recorded resumeAt is only what the provider said at failure time;
 * the limit can clear sooner (a reset credit applied, extra quota purchased),
 * and without a re-probe the park silently overstays. Exported for tests.
 */
export const EARLY_RESUME_PROBE_MS = 3 * 60_000;

/**
 * Account pools: a limit with no reset time from any source still benches the
 * exhausted profile so failover skips it, clamped to an hour (research §3.2).
 */
export const ASSUMED_ACCOUNT_LIMIT_MS = 60 * 60_000;

export type ProviderLimitTurnOutcome = 'parked' | 'already-parked' | 'skipped' | 'switching-account';

export interface InstanceProviderLimitHandlerDeps {
  /** Feature gate — regular-session auto-resume is opt-in (default OFF). */
  isEnabled: () => boolean;
  /** Set/clear the quota-park waitReason so the renderer shows the countdown. */
  setWaitReason: (instanceId: string, waitReason: InstanceWaitReason | null) => void;
  /** Re-send the throttled user turn to the instance. */
  resendInput: (instanceId: string, prompt: string) => void;
  /** Live provider quota snapshot, used to derive the reset time. */
  getQuotaSnapshot: (provider: ProviderId, accountProfileId?: string | null) => ProviderQuotaSnapshot | null;
  /**
   * Fire-and-forget quota snapshot refresh, invoked when a park attempt finds
   * no reset hint from ANY source (structured error, text parse, telemetry,
   * or the cached snapshot). Never awaited from the park path — it only primes
   * the snapshot so the *next* limit error on this provider has a fresh window
   * to derive a reset time from.
   */
  refreshQuotaSnapshot?: (provider: ProviderId) => void;
  /**
   * On-demand live quota probe used by the parked early-resume checker.
   * Resolves the fresh snapshot, or null on failure. Wired to
   * ProviderQuotaService.refresh().
   */
  probeQuotaSnapshot?: (provider: ProviderId, accountProfileId?: string | null) => Promise<ProviderQuotaSnapshot | null>;
  /**
   * Durable cross-instance provider-limit cache. Injectable for focused tests.
   * With `getParkedSince`, a recorded limit that newer usage evidence
   * contradicts (credits bought, reset credit applied) stops holding sends.
   */
  providerLimitLedger?: Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive'>
    & Partial<Pick<ProviderLimitLedger, 'getParkedSince'>>;
  /**
   * Account-pool failover (spec §8.2). Consulted after the ledger row is recorded for
   * the exhausted profile and before `park()`: a switch leaves no park state.
   */
  accountFailover?: Pick<AccountFailoverCoordinator, 'plan' | 'perform' | 'offer' | 'shouldSwitchPreemptively' | 'release'>;
  /** Transcript note when an attempted account switch could not happen. */
  emitSystemMessage?: (instanceId: string, content: string, metadata: Record<string, unknown>) => void;
  /** Working directory for the instance (needed by the durable automation). */
  getWorkspaceCwd: (instanceId: string) => string | undefined;
  /**
   * Provider + resolved model for the instance, used to scope the ledger
   * user-override clear on resume/cancel. Null when the instance is gone.
   */
  getProviderModel?: (instanceId: string) => {
    provider: InstanceProvider;
    model: string | null;
    /** Account-pool profile (legacy included) for Claude/Codex; null otherwise. */
    accountProfileId?: string | null;
  } | null;
  /**
   * Whether the instance is currently live and can accept a re-sent turn. Used
   * post-restart: when false, the durable automation falls through to its own
   * thread-revive + prompt dispatch instead of a direct (doomed) re-send.
   */
  isResumable?: (instanceId: string) => boolean;
  /**
   * Stable app-level thread/session identity for the instance being parked,
   * captured before any restart/termination can drop it. Threaded into the
   * durable resume automation's destination so a fire that finds the original
   * instance gone (restart, or the user manually resumed the same thread as a
   * *different* instance id in the meantime) can still recognize an
   * already-live sibling by historyThreadId/sessionId instead of blindly
   * reviving a second, duplicate process for the same underlying session.
   */
  getThreadIdentifiers?: (instanceId: string) => { historyThreadId?: string; sessionId?: string } | null;
  /**
   * WS7 Phase B (offered switch): invoked once per successful park with the
   * park facts. The wiring decides whether to offer a provider switch
   * (fallback list configured + resume far enough away) and notifies.
   * Best-effort; never blocks the park.
   */
  onParked?: (params: { instanceId: string; provider: ProviderId; resumeAt: number }) => void;
  /**
   * Schedule the durable + in-process resume. Injectable for tests; defaults to
   * {@link scheduleInstanceProviderLimitResume} in production.
   */
  scheduleResume?: (params: {
    request: InstanceProviderLimitResumeRequest;
    resumeInstance: (instanceId: string, opts?: { resumePromptFallback?: string }) => void;
  }) => () => void;
}

export interface MaybeParkParams {
  instanceId: string;
  provider: InstanceProvider;
  /** The resolved provider model when known; null/undefined means account scope. */
  model?: string | null;
  /** Reset time parsed from the provider error/notice, if any (epoch ms). */
  resetAtHint: number | null;
  reason: string;
  /** The user turn to re-send on resume; null when unknown. */
  resumePrompt: string | null;
  /**
   * Account-pool profile the turn ran on (`legacy` for an unstamped
   * Claude/Codex session); null/undefined for providers without pools.
   */
  accountProfileId?: string | null;
}

export type MaybeParkKnownParams = Omit<MaybeParkParams, 'resetAtHint'>;

interface ParkEntry {
  cancel: () => void;
  resumePrompt: string | null;
  /** Stops the periodic early-resume quota probe for this park. */
  stopEarlyResumeProbe: () => void;
}

/**
 * Auto-resume for *regular* (non-loop) interactive instances after a provider
 * rate/session-limit — the plain-chat analogue of {@link
 * ../orchestration/loop-provider-limit-handler.LoopProviderLimitHandler}.
 *
 * On a throttled turn the instance is parked with a `quota-park` waitReason and
 * a durable one-time resume is scheduled (mirrors the loop path); when the
 * window resets the throttled turn is re-sent. Everything is gated behind the
 * `instanceProviderLimitResumeEnabled` setting, so nothing changes unless the
 * user opts in.
 */
export class InstanceProviderLimitHandler {
  private deps: InstanceProviderLimitHandlerDeps | null = null;
  private readonly parked = new Map<string, ParkEntry>();
  private readonly lastResumeAt = new Map<string, number>();
  /** Instances whose next send must not attempt another pre-emptive switch. */
  private readonly skipPreemptiveOnce = new Set<string>();

  configure(deps: InstanceProviderLimitHandlerDeps): void {
    this.deps = deps;
  }

  /**
   * Park + schedule a resume when a regular-session turn stops on a provider
   * limit. Returns `'skipped'` (a no-op that leaves normal error handling
   * intact) when the feature is off, the provider is unresolved, or no reset
   * time can be derived. Returns `'already-parked'` — instead of re-parking —
   * when the instance is already parked, so a caller receiving a second
   * throttled turn (e.g. from a send path that bypasses the renderer's
   * quota-park gate) can acknowledge it without duplicating the park message
   * or touching status.
   */
  maybePark(params: MaybeParkParams): ProviderLimitTurnOutcome {
    const deps = this.deps;
    if (!deps) return 'skipped';
    if (this.parked.has(params.instanceId)) return 'already-parked';

    const providerId = toProviderId(params.provider);
    if (!providerId) return 'skipped';

    const now = Date.now();
    const accountProfileId = params.accountProfileId ?? null;
    const resetAtHint = typeof params.resetAtHint === 'number' && params.resetAtHint > now
      ? params.resetAtHint
      : null;
    const knownLimit = deps.providerLimitLedger?.getActive({
      provider: providerId,
      model: params.model ?? null,
      accountProfileId,
      now,
    }) ?? null;
    const snapshotResumeAt = this.deriveResumeFromSnapshot(
      deps.getQuotaSnapshot(providerId, accountProfileId),
    );
    const detectedResumeAt = resetAtHint ?? snapshotResumeAt;
    const resumeAt = detectedResumeAt ?? knownLimit?.resumeAt ?? null;

    const failoverParams = this.failoverParams(params, accountProfileId, resumeAt);
    const failoverPlan = failoverParams ? deps.accountFailover?.plan(failoverParams) : undefined;
    const pooled = failoverPlan !== undefined && !(failoverPlan.kind === 'none' && failoverPlan.reason === 'no-pool');

    if (detectedResumeAt !== null) {
      deps.providerLimitLedger?.record({
        provider: providerId,
        model: params.model ?? null,
        accountProfileId,
        detectedAt: now,
        resumeAt: detectedResumeAt,
        source: resetAtHint !== null ? 'provider-limit-signal' : 'quota-snapshot',
        instanceId: params.instanceId,
      });
    } else if (pooled && knownLimit === null) {
      deps.providerLimitLedger?.record({
        provider: providerId,
        model: params.model ?? null,
        accountProfileId,
        detectedAt: now,
        resumeAt: now + ASSUMED_ACCOUNT_LIMIT_MS,
        source: 'provider-limit-assumed',
        instanceId: params.instanceId,
      });
    }

    if (failoverParams && failoverPlan?.kind === 'switch') {
      this.startAccountFailover(failoverParams, params, providerId, resumeAt);
      return 'switching-account';
    }
    if (failoverParams && failoverPlan?.kind === 'offer') {
      const parked = resumeAt === null ? 'skipped' : this.park(params, providerId, resumeAt);
      deps.accountFailover?.offer(failoverParams, failoverPlan.toProfileId);
      return parked;
    }

    if (resumeAt === null) {
      // Every hint source came up empty — prime the snapshot for next time
      // instead of leaving this provider's quota view stale until the next
      // scheduled poll.
      deps.refreshQuotaSnapshot?.(providerId);
      return 'skipped';
    }

    return this.park(params, providerId, resumeAt);
  }

  /**
   * Consult the durable ledger before dispatching a new regular-session turn.
   * Unlike {@link maybePark}, a miss is intentionally silent: preflight runs
   * for every send, so it must not start a quota probe or write another row.
   */
  maybeParkKnown(params: MaybeParkKnownParams): ProviderLimitTurnOutcome {
    const deps = this.deps;
    if (!deps) return 'skipped';
    if (this.parked.has(params.instanceId)) return 'already-parked';

    const providerId = toProviderId(params.provider);
    if (!providerId) return 'skipped';
    const accountProfileId = params.accountProfileId ?? null;
    const knownLimit = deps.providerLimitLedger?.getActive({
      provider: providerId,
      model: params.model ?? null,
      accountProfileId,
      now: Date.now(),
    }) ?? null;
    if (!knownLimit) return this.maybeSwitchPreemptively(params, providerId, accountProfileId);
    if (this.clearLimitLiftedSinceRecorded(params, providerId, accountProfileId)) {
      return this.maybeSwitchPreemptively(params, providerId, accountProfileId);
    }

    // This session's account is known-limited but another account of the pool
    // may not be: switch before sending instead of holding the turn.
    const failoverParams = this.failoverParams(params, accountProfileId, knownLimit.resumeAt);
    const plan = failoverParams ? deps.accountFailover?.plan(failoverParams) : undefined;
    if (failoverParams && plan?.kind === 'switch') {
      this.startAccountFailover(failoverParams, params, providerId, knownLimit.resumeAt);
      return 'switching-account';
    }
    const parked = this.park(params, providerId, knownLimit.resumeAt);
    if (failoverParams && plan?.kind === 'offer') deps.accountFailover?.offer(failoverParams, plan.toProfileId);
    return parked;
  }

  /** A recorded limit newer quota evidence contradicts stops holding the send (see provider-limit-lift.ts). */
  private clearLimitLiftedSinceRecorded(params: MaybeParkKnownParams, provider: ProviderId, accountProfileId: string | null): boolean {
    const deps = this.deps;
    if (!deps?.providerLimitLedger) return false;
    try {
      const lifted = clearLimitLiftedSinceRecorded({
        ledger: deps.providerLimitLedger,
        snapshot: deps.getQuotaSnapshot(provider, accountProfileId),
        provider,
        model: params.model ?? null,
        accountProfileId,
      });
      if (!lifted) return false;
      logger.info('Provider reports usage available since the recorded limit; cleared the stale gate and sending', {
        instanceId: params.instanceId, provider, accountProfileId, ...lifted,
      });
      return true;
    } catch (error) {
      logger.debug('Could not check a recorded limit against usage evidence', {
        instanceId: params.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Spec §8.4: move a live session at a turn boundary before its account runs out. */
  private maybeSwitchPreemptively(
    params: MaybeParkKnownParams,
    providerId: ProviderId,
    accountProfileId: string | null,
  ): ProviderLimitTurnOutcome {
    if (this.skipPreemptiveOnce.delete(params.instanceId)) return 'skipped';
    const failoverParams = this.failoverParams(params, accountProfileId, null);
    const coordinator = this.deps?.accountFailover;
    if (!failoverParams || !coordinator) return 'skipped';
    const preemptive = { ...failoverParams, handoffKind: 'preemptive' as const, reason: 'approaching usage limit' };
    if (!coordinator.shouldSwitchPreemptively(preemptive)) return 'skipped';
    // Unlike a rejection there is nothing to park on if the switch cannot run:
    // the turn is simply sent on the current account afterwards.
    const sendOnCurrentAccount = (): void => {
      if (!params.resumePrompt) return;
      this.skipPreemptiveOnce.add(params.instanceId);
      this.deps?.resendInput(params.instanceId, params.resumePrompt);
    };
    void coordinator.perform(preemptive).then((outcome) => {
      if (outcome.outcome === 'not-switched' || outcome.outcome === 'offered') sendOnCurrentAccount();
      if (outcome.outcome === 'already-moved') this.emitFailoverNote(params.instanceId, accountFailoverNote(outcome, false));
    }).catch(sendOnCurrentAccount);
    logger.info('Switching a live session to another account before it reaches its limit', {
      instanceId: params.instanceId,
      provider: providerId,
      fromAccountProfileId: accountProfileId,
    });
    return 'switching-account';
  }

  private failoverParams(
    params: MaybeParkKnownParams,
    accountProfileId: string | null,
    resumeAt: number | null,
  ): AccountFailoverParams | null {
    if (!accountProfileId || !isPooledProvider(params.provider)) return null;
    return {
      instanceId: params.instanceId,
      provider: params.provider,
      model: params.model ?? null,
      exhaustedProfileId: accountProfileId,
      resumeAt,
      resumePrompt: params.resumePrompt,
      reason: params.reason,
    };
  }

  /**
   * Run the async switch. When it cannot happen, fall back to exactly what the
   * funnel would have done without pools: park until the reset when possible,
   * and otherwise tell the user in the transcript.
   */
  private startAccountFailover(
    failoverParams: AccountFailoverParams,
    params: MaybeParkKnownParams,
    providerId: ProviderId,
    resumeAt: number | null,
  ): void {
    const coordinator = this.deps?.accountFailover;
    if (!coordinator) return;
    void coordinator.perform(failoverParams)
      .then((outcome) => {
        // `offered` can arrive here when the pool switched to asking while this waited for the lock.
        const waits = outcome.outcome === 'not-switched' || outcome.outcome === 'offered';
        const parked = waits && resumeAt !== null && !this.parked.has(params.instanceId)
          && this.park(params, providerId, resumeAt) === 'parked';
        this.emitFailoverNote(params.instanceId, accountFailoverNote(outcome, parked));
      })
      .catch((error: unknown) => {
        logger.warn('Account failover failed unexpectedly', {
          instanceId: params.instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private emitFailoverNote(instanceId: string, note: AccountFailoverNote | null): void {
    if (note) this.deps?.emitSystemMessage?.(instanceId, note.content, note.metadata);
  }

  private park(
    params: MaybeParkKnownParams,
    providerId: ProviderId,
    resumeAt: number,
  ): ProviderLimitTurnOutcome {
    const deps = this.deps;
    if (!deps || !deps.isEnabled()) return 'skipped';

    const workspaceCwd = deps.getWorkspaceCwd(params.instanceId);
    if (!workspaceCwd) {
      logger.debug('Cannot park instance on provider limit: no working directory', {
        instanceId: params.instanceId,
      });
      return 'skipped';
    }

    // A fresh park re-opens the instance to a later resume.
    this.lastResumeAt.delete(params.instanceId);

    deps.setWaitReason(params.instanceId, {
      kind: 'quota-park',
      provider: providerId,
      resumeAt,
    });

    const identifiers = deps.getThreadIdentifiers?.(params.instanceId) ?? null;

    const schedule = deps.scheduleResume ?? scheduleInstanceProviderLimitResume;
    const cancel = schedule({
      request: {
        instanceId: params.instanceId,
        workspaceCwd,
        provider: params.provider,
        resumeAt,
        reason: params.reason,
        resumePrompt: params.resumePrompt,
        historyThreadId: identifiers?.historyThreadId,
        sessionId: identifiers?.sessionId,
      },
      resumeInstance: (id, opts) => this.resumeNow(id, opts),
    });

    this.parked.set(params.instanceId, {
      cancel,
      resumePrompt: params.resumePrompt,
      stopEarlyResumeProbe: this.startEarlyResumeProbe(params, providerId, resumeAt, params.accountProfileId ?? null),
    });
    logger.info('Parked regular session on provider limit; will auto-resume at window reset', {
      instanceId: params.instanceId,
      provider: providerId,
      resumeAt,
      reason: params.reason,
    });
    // WS7 Phase B: let the wiring offer a provider switch for long parks.
    try {
      deps.onParked?.({ instanceId: params.instanceId, provider: providerId, resumeAt });
    } catch {
      // best-effort — the offer must never affect the park itself
    }
    return 'parked';
  }

  /**
   * Resume a parked instance now: clear the park, clear the waitReason, and
   * re-send the throttled turn. Idempotent — a double-fire (timer vs.
   * automation) within {@link RESUME_DEDUPE_MS} is ignored. `resumePromptFallback`
   * covers the post-restart case where the in-memory park entry is gone but the
   * durable automation carried the prompt. A live park that captured no turn
   * gets {@link buildProviderLimitContinuationPrompt}; with neither, nothing is
   * sent, so a stale Resume click stays a no-op.
   */
  resumeNow(instanceId: string, opts?: { resumePromptFallback?: string }): boolean {
    const deps = this.deps;
    if (!deps) return false;

    const now = Date.now();
    const recent = this.lastResumeAt.get(instanceId);
    if (recent !== undefined && now - recent < RESUME_DEDUPE_MS) {
      return false;
    }
    this.lastResumeAt.set(instanceId, now);

    const entry = this.parked.get(instanceId);
    this.parked.delete(instanceId);
    if (entry) {
      entry.cancel();
      entry.stopEarlyResumeProbe();
    }

    // Drop the durable known-limit gate BEFORE re-sending: the re-sent turn
    // travels the normal send path, whose preflight (maybeParkKnown) would
    // otherwise instantly re-park it off the same — possibly stale — ledger
    // row, making "Resume now" a silent no-op until the recorded reset time.
    this.clearKnownLimitGate(instanceId);

    deps.setWaitReason(instanceId, null);

    const prompt = entry?.resumePrompt ?? opts?.resumePromptFallback ?? null;
    if (prompt !== null && prompt.length > 0) {
      deps.resendInput(instanceId, prompt);
      logger.info('Resumed regular session after provider quota reset', { instanceId });
    } else if (entry) {
      // A live park that captured no turn was raised on a turn dispatched
      // outside sendInput() (the create-time initial prompt), so there is
      // nothing to replay — continue rather than resume into silence.
      deps.resendInput(instanceId, buildProviderLimitContinuationPrompt());
      logger.info('Resumed regular session with a continuation turn; none captured', { instanceId });
    } else {
      // Stale action, e.g. a Resume click landing after the park cleared.
      logger.info('Cleared provider-limit park with no message to re-send', { instanceId });
    }
    return true;
  }

  /**
   * Resume path for the durable automation firing (possibly in a fresh process
   * after a restart). Returns:
   * - `'resent'` — handled here (an in-memory park existed, or the instance is
   *   live and the fallback turn was re-sent, or a recent resume already ran).
   *   The automation should terminalize as succeeded.
   * - `'fell-through'` — the instance is not live and there was no park entry,
   *   so nothing was re-sent. The automation should fall through to its normal
   *   thread-revive + prompt dispatch to continue the work.
   */
  resumeFromAutomation(instanceId: string, fallbackPrompt?: string): 'resent' | 'fell-through' {
    const deps = this.deps;
    if (!deps) return 'fell-through';

    const now = Date.now();
    const recent = this.lastResumeAt.get(instanceId);
    if (recent !== undefined && now - recent < RESUME_DEDUPE_MS) {
      return 'resent'; // already resumed this window (e.g. the in-process timer beat us)
    }

    const entry = this.parked.get(instanceId);
    if (entry) {
      // Live, in-session park — re-send directly.
      this.resumeNow(instanceId, fallbackPrompt ? { resumePromptFallback: fallbackPrompt } : undefined);
      return 'resent';
    }

    // No in-memory park (fresh process). Only re-send directly if the instance
    // is live; otherwise let the automation revive the thread and dispatch.
    if (deps.isResumable?.(instanceId)) {
      this.lastResumeAt.set(instanceId, now);
      this.clearKnownLimitGate(instanceId);
      deps.setWaitReason(instanceId, null);
      // The automation only fires for a park that was still armed, so an absent
      // prompt means the park captured none — continue, never do nothing.
      deps.resendInput(instanceId, fallbackPrompt || buildProviderLimitContinuationPrompt());
      return 'resent';
    }
    return 'fell-through';
  }

  /** User dismissed the park. Clear the schedule + waitReason, do not re-send. */
  cancel(instanceId: string): boolean {
    const entry = this.parked.get(instanceId);
    this.parked.delete(instanceId);
    if (entry) {
      entry.cancel();
      entry.stopEarlyResumeProbe();
    }
    // Block a racing timer/automation from re-sending after an explicit cancel.
    this.lastResumeAt.set(instanceId, Date.now());
    // A dismissal is also a user override: without this, the user's next
    // typed message would be re-held by the send-path preflight against the
    // same (possibly stale) ledger row and the park would come straight back.
    this.clearKnownLimitGate(instanceId);
    this.deps?.setWaitReason(instanceId, null);
    return !!entry;
  }

  /**
   * Instance-teardown hook. Drops all in-memory park state for the instance
   * (early-resume probe interval, parked entry, resume-dedupe marker) so a
   * terminated instance never leaves zombie timers or Map entries behind.
   *
   * By default also cancels the scheduled resume (in-process timer + durable
   * automation) — a deliberately terminated session must not be revived later
   * by its quota-reset automation. Pass `preserveDurableResume` on app-shutdown
   * bulk termination: the durable automation is the only thing that resumes a
   * parked session after a restart, so shutdown must leave it standing.
   *
   * Unlike {@link cancel}, never touches the waitReason (the instance is being
   * deleted) and never clears the ledger's known-limit gate (the provider is
   * still limited for every other instance).
   */
  release(instanceId: string, opts?: { preserveDurableResume?: boolean }): void {
    const entry = this.parked.get(instanceId);
    this.parked.delete(instanceId);
    this.lastResumeAt.delete(instanceId);
    this.skipPreemptiveOnce.delete(instanceId);
    this.deps?.accountFailover?.release(instanceId);
    if (!entry) return;
    entry.stopEarlyResumeProbe();
    if (!opts?.preserveDurableResume) {
      entry.cancel();
    }
    logger.info('Released provider-limit park state on instance termination', {
      instanceId,
      durableResumePreserved: !!opts?.preserveDurableResume,
    });
  }

  /**
   * User-override of the durable known-limit gate for this instance's
   * provider/model. A recorded resumeAt can go stale mid-window (the user
   * applies a reset credit or buys more quota), and the ledger has no way to
   * observe that — an explicit resume/cancel is the signal to trust the user
   * and actually attempt the next turn. If the provider is still limited, the
   * failed turn re-parks with a fresh reset hint, so a wrong override costs
   * one rejected request.
   */
  private clearKnownLimitGate(instanceId: string): void {
    const deps = this.deps;
    const ledger = deps?.providerLimitLedger;
    if (!deps || !ledger || !deps.getProviderModel) return;

    const info = deps.getProviderModel(instanceId);
    if (!info) return;
    const providerId = toProviderId(info.provider);
    if (!providerId) return;

    const cleared = ledger.clearActive({
      provider: providerId,
      model: info.model,
      accountProfileId: info.accountProfileId ?? null,
    });
    if (cleared > 0) {
      logger.info('Cleared active provider-limit gate (user override)', {
        instanceId,
        provider: providerId,
        model: info.model,
        cleared,
      });
    }
  }

  isParked(instanceId: string): boolean {
    return this.parked.has(instanceId);
  }

  /**
   * While parked, periodically check for an early lift: either a pool sibling
   * account has since become available (a fresh turn on another instance can
   * flip the pool's default route while this one keeps waiting on its own
   * window), or a fresh quota snapshot shows this instance's own limit has
   * lifted — the recorded resumeAt then acts only as a fallback ceiling. The
   * sibling check goes first and is cheap (cached bindings), so a pooled
   * account that already recovered switches this park immediately instead of
   * waiting out its own multi-hour window. Skips the probe once the scheduled
   * resume is imminent, never overlaps requests, and treats probe failures as
   * "still limited" (retry next tick). The interval is unref'd and stopped by
   * resumeNow/cancel via the park entry.
   */
  private startEarlyResumeProbe(
    params: MaybeParkKnownParams,
    providerId: ProviderId,
    resumeAt: number,
    accountProfileId: string | null,
  ): () => void {
    const deps = this.deps;
    const probe = deps?.probeQuotaSnapshot;
    if (!deps || !probe) return () => {};
    const instanceId = params.instanceId;

    let inFlight = false;
    const timer = setInterval(() => {
      if (!this.parked.has(instanceId) || inFlight) return;
      if (resumeAt - Date.now() < 60_000) return; // scheduled resume is about to fire anyway
      inFlight = true;

      const failoverParams = this.failoverParams(params, accountProfileId, resumeAt);
      const plan = failoverParams ? deps.accountFailover?.plan(failoverParams) : undefined;
      if (failoverParams && plan?.kind === 'switch') {
        const entry = this.parked.get(instanceId);
        this.parked.delete(instanceId);
        entry?.cancel();
        clearInterval(timer); // this probe is superseded by startAccountFailover's own re-park (if needed)
        logger.info('Sibling pool account became available while parked; switching instead of waiting for the own window reset', {
          instanceId,
          provider: providerId,
        });
        this.startAccountFailover(failoverParams, params, providerId, resumeAt);
        inFlight = false;
        return;
      }

      void probe(providerId, accountProfileId)
        .then((snapshot) => {
          // An interactive session may continue on purchased credits: the user bought them to keep going.
          if (!this.parked.has(instanceId) || !snapshotShowsLimitLifted(snapshot, { acceptCredits: true })) return;
          logger.info('Provider limit lifted early per fresh quota probe; resuming parked session now', {
            instanceId,
            provider: providerId,
            recordedResumeAt: resumeAt,
          });
          this.resumeNow(instanceId);
        })
        .catch(() => {
          // Probe failure proves nothing — keep the park and retry next tick.
        })
        .finally(() => {
          inFlight = false;
        });
    }, EARLY_RESUME_PROBE_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * Pick the reset time of the most-constrained active quota window. Mirrors
   * {@link ../orchestration/loop-provider-limit-handler.LoopProviderLimitHandler.deriveResumeFromSnapshot}.
   */
  private deriveResumeFromSnapshot(snapshot: ProviderQuotaSnapshot | null): number | null {
    if (!snapshot || !snapshot.ok) return null;
    const now = Date.now();
    let bestResetsAt: number | null = null;
    let bestPct = -1;
    for (const w of snapshot.windows) {
      if (w.resetsAt == null || w.resetsAt <= now || w.limit <= 0) continue;
      const pct = (w.used / w.limit) * 100;
      if (pct > bestPct) {
        bestPct = pct;
        bestResetsAt = w.resetsAt;
      }
    }
    return bestResetsAt;
  }

  /** Test seam — drop all in-memory park state. */
  _resetForTesting(): void {
    for (const entry of this.parked.values()) {
      try {
        entry.cancel();
        entry.stopEarlyResumeProbe();
      } catch {
        // ignore
      }
    }
    this.parked.clear();
    this.lastResumeAt.clear();
    this.skipPreemptiveOnce.clear();
    this.deps = null;
  }
}

function toProviderId(provider: InstanceProvider): ProviderId | null {
  // `InstanceProvider` adds 'auto' (unresolved) on top of ProviderId; a running
  // instance always has a concrete provider, but guard anyway.
  return provider === 'auto' ? null : provider;
}

let singleton: InstanceProviderLimitHandler | null = null;

export function getInstanceProviderLimitHandler(): InstanceProviderLimitHandler {
  if (!singleton) singleton = new InstanceProviderLimitHandler();
  return singleton;
}

export function _resetInstanceProviderLimitHandlerForTesting(): void {
  singleton?._resetForTesting();
  singleton = null;
}
