import type { InstanceProvider, InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import type { ProviderLimitLedger } from '../core/system/provider-limit-ledger';
import { getLogger } from '../logging/logger';
import {
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

export interface InstanceProviderLimitHandlerDeps {
  /** Feature gate — regular-session auto-resume is opt-in (default OFF). */
  isEnabled: () => boolean;
  /** Set/clear the quota-park waitReason so the renderer shows the countdown. */
  setWaitReason: (instanceId: string, waitReason: InstanceWaitReason | null) => void;
  /** Re-send the throttled user turn to the instance. */
  resendInput: (instanceId: string, prompt: string) => void;
  /** Live provider quota snapshot, used to derive the reset time. */
  getQuotaSnapshot: (provider: ProviderId) => ProviderQuotaSnapshot | null;
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
  probeQuotaSnapshot?: (provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>;
  /** Durable cross-instance provider-limit cache. Injectable for focused tests. */
  providerLimitLedger?: Pick<ProviderLimitLedger, 'record' | 'getActive' | 'clearActive'>;
  /** Working directory for the instance (needed by the durable automation). */
  getWorkspaceCwd: (instanceId: string) => string | undefined;
  /**
   * Provider + resolved model for the instance, used to scope the ledger
   * user-override clear on resume/cancel. Null when the instance is gone.
   */
  getProviderModel?: (instanceId: string) => { provider: InstanceProvider; model: string | null } | null;
  /**
   * Whether the instance is currently live and can accept a re-sent turn. Used
   * post-restart: when false, the durable automation falls through to its own
   * thread-revive + prompt dispatch instead of a direct (doomed) re-send.
   */
  isResumable?: (instanceId: string) => boolean;
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
  maybePark(params: MaybeParkParams): 'parked' | 'already-parked' | 'skipped' {
    const deps = this.deps;
    if (!deps) return 'skipped';
    if (this.parked.has(params.instanceId)) return 'already-parked';

    const providerId = toProviderId(params.provider);
    if (!providerId) return 'skipped';

    const now = Date.now();
    const resetAtHint = typeof params.resetAtHint === 'number' && params.resetAtHint > now
      ? params.resetAtHint
      : null;
    const knownLimit = deps.providerLimitLedger?.getActive({
      provider: providerId,
      model: params.model ?? null,
      now,
    }) ?? null;
    const snapshotResumeAt = this.deriveResumeFromSnapshot(
      deps.getQuotaSnapshot(providerId),
    );
    const detectedResumeAt = resetAtHint ?? snapshotResumeAt;
    const resumeAt = detectedResumeAt ?? knownLimit?.resumeAt ?? null;

    if (detectedResumeAt !== null) {
      deps.providerLimitLedger?.record({
        provider: providerId,
        model: params.model ?? null,
        detectedAt: now,
        resumeAt: detectedResumeAt,
        source: resetAtHint !== null ? 'provider-limit-signal' : 'quota-snapshot',
        instanceId: params.instanceId,
      });
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
  maybeParkKnown(params: MaybeParkKnownParams): 'parked' | 'already-parked' | 'skipped' {
    const deps = this.deps;
    if (!deps) return 'skipped';
    if (this.parked.has(params.instanceId)) return 'already-parked';

    const providerId = toProviderId(params.provider);
    if (!providerId) return 'skipped';
    const knownLimit = deps.providerLimitLedger?.getActive({
      provider: providerId,
      model: params.model ?? null,
      now: Date.now(),
    }) ?? null;
    if (!knownLimit) return 'skipped';

    return this.park(params, providerId, knownLimit.resumeAt);
  }

  private park(
    params: MaybeParkKnownParams,
    providerId: ProviderId,
    resumeAt: number,
  ): 'parked' | 'already-parked' | 'skipped' {
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

    const schedule = deps.scheduleResume ?? scheduleInstanceProviderLimitResume;
    const cancel = schedule({
      request: {
        instanceId: params.instanceId,
        workspaceCwd,
        provider: params.provider,
        resumeAt,
        reason: params.reason,
        resumePrompt: params.resumePrompt,
      },
      resumeInstance: (id, opts) => this.resumeNow(id, opts),
    });

    this.parked.set(params.instanceId, {
      cancel,
      resumePrompt: params.resumePrompt,
      stopEarlyResumeProbe: this.startEarlyResumeProbe(params.instanceId, providerId, resumeAt),
    });
    logger.info('Parked regular session on provider limit; will auto-resume at window reset', {
      instanceId: params.instanceId,
      provider: providerId,
      resumeAt,
      reason: params.reason,
    });
    return 'parked';
  }

  /**
   * Resume a parked instance now: clear the park, clear the waitReason, and
   * re-send the throttled turn. Idempotent — a double-fire (timer vs.
   * automation) within {@link RESUME_DEDUPE_MS} is ignored. `resumePromptFallback`
   * covers the post-restart case where the in-memory park entry is gone but the
   * durable automation carried the prompt.
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
    } else {
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
      if (fallbackPrompt && fallbackPrompt.length > 0) {
        deps.resendInput(instanceId, fallbackPrompt);
      }
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

    const cleared = ledger.clearActive({ provider: providerId, model: info.model });
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
   * While parked, periodically re-probe the provider's live quota and resume
   * as soon as a fresh snapshot shows the limit has lifted — the recorded
   * resumeAt then acts only as a fallback ceiling. Skips the probe once the
   * scheduled resume is imminent, never overlaps requests, and treats probe
   * failures as "still limited" (retry next tick). The interval is unref'd
   * and stopped by resumeNow/cancel via the park entry.
   */
  private startEarlyResumeProbe(
    instanceId: string,
    providerId: ProviderId,
    resumeAt: number,
  ): () => void {
    const probe = this.deps?.probeQuotaSnapshot;
    if (!probe) return () => {};

    let inFlight = false;
    const timer = setInterval(() => {
      if (!this.parked.has(instanceId) || inFlight) return;
      if (resumeAt - Date.now() < 60_000) return; // scheduled resume is about to fire anyway
      inFlight = true;
      void probe(providerId)
        .then((snapshot) => {
          if (!this.parked.has(instanceId) || !snapshotShowsLimitLifted(snapshot)) return;
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
    this.deps = null;
  }
}

/**
 * A parked limit counts as lifted only when a fresh, successful snapshot
 * reports headroom on EVERY window (a reset credit zeroes the exhausted
 * window; other windows may still be pinned). An errored/absent snapshot or
 * one with no windows proves nothing and keeps the park. Shared with the
 * loop-side early-resume probe (loop-provider-limit-handler.ts).
 */
export function snapshotShowsLimitLifted(snapshot: ProviderQuotaSnapshot | null): boolean {
  if (!snapshot || !snapshot.ok || snapshot.windows.length === 0) return false;
  return snapshot.windows.every((w) => w.limit <= 0 || w.used < w.limit);
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
