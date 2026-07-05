import type { InstanceProvider, InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
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

export interface InstanceProviderLimitHandlerDeps {
  /** Feature gate — regular-session auto-resume is opt-in (default OFF). */
  isEnabled: () => boolean;
  /** Set/clear the quota-park waitReason so the renderer shows the countdown. */
  setWaitReason: (instanceId: string, waitReason: InstanceWaitReason | null) => void;
  /** Re-send the throttled user turn to the instance. */
  resendInput: (instanceId: string, prompt: string) => void;
  /** Live provider quota snapshot, used to derive the reset time. */
  getQuotaSnapshot: (provider: ProviderId) => ProviderQuotaSnapshot | null;
  /** Working directory for the instance (needed by the durable automation). */
  getWorkspaceCwd: (instanceId: string) => string | undefined;
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
  /** Reset time parsed from the provider error/notice, if any (epoch ms). */
  resetAtHint: number | null;
  reason: string;
  /** The user turn to re-send on resume; null when unknown. */
  resumePrompt: string | null;
}

interface ParkEntry {
  cancel: () => void;
  resumePrompt: string | null;
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
   * intact) when the feature is off, the provider is unresolved, the instance
   * is already parked, or no reset time can be derived.
   */
  maybePark(params: MaybeParkParams): 'parked' | 'skipped' {
    const deps = this.deps;
    if (!deps) return 'skipped';
    if (!deps.isEnabled()) return 'skipped';
    if (this.parked.has(params.instanceId)) return 'skipped';

    const providerId = toProviderId(params.provider);
    if (!providerId) return 'skipped';

    const resumeAt = this.deriveResumeAt(params.resetAtHint, providerId);
    if (resumeAt === null) return 'skipped';

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

    this.parked.set(params.instanceId, { cancel, resumePrompt: params.resumePrompt });
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
    if (entry) entry.cancel();

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
    if (entry) entry.cancel();
    // Block a racing timer/automation from re-sending after an explicit cancel.
    this.lastResumeAt.set(instanceId, Date.now());
    this.deps?.setWaitReason(instanceId, null);
    return !!entry;
  }

  isParked(instanceId: string): boolean {
    return this.parked.has(instanceId);
  }

  private deriveResumeAt(resetAtHint: number | null, provider: ProviderId): number | null {
    const now = Date.now();
    if (typeof resetAtHint === 'number' && resetAtHint > now) return resetAtHint;
    return this.deriveResumeFromSnapshot(this.deps?.getQuotaSnapshot(provider) ?? null);
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
      } catch {
        // ignore
      }
    }
    this.parked.clear();
    this.lastResumeAt.clear();
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
