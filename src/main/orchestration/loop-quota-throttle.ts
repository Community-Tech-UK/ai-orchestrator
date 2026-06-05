/**
 * Loop quota throttle ladder (preventive half of usage-aware throttling).
 *
 * Pure decision function consumed by the LoopCoordinator's pre-iteration
 * pre-flight. Given the active provider's latest `ProviderQuotaSnapshot`, it
 * decides whether the loop may spawn another (paid) iteration or must hold:
 *
 *   • continue       — headroom remains; spawn the next iteration.
 *   • throttle        — binding window ≥ throttle threshold (default 90%);
 *                       finish nothing new, park until the window resets.
 *   • park-exhausted  — binding window ≥ 100%; the next request would spill.
 *   • overage-guard   — a paid credits/overage window is already being consumed
 *                       (decision #3 default: never ride paid overage).
 *
 * Each iteration is a full paid agent turn, so "slow down" == "don't start
 * another one" — exactly what the coordinator does when it parks. The decision
 * is intentionally conservative: a missing/stale/failed snapshot yields
 * `continue` so a flaky usage endpoint never wedges a loop.
 */

import type {
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../shared/types/provider-quota.types';

export type QuotaThrottleAction =
  | 'continue'
  | 'downshift'
  | 'throttle'
  | 'park-exhausted'
  | 'overage-guard';

export interface QuotaDownshiftTarget {
  windowId: string;
  model: string;
  reason: string;
}

export interface QuotaThrottleDecision {
  action: QuotaThrottleAction;
  /** The window that drove a non-`continue` decision. */
  window?: ProviderQuotaWindow;
  /** Cheaper same-provider model/bucket to use instead of parking. */
  downshift?: QuotaDownshiftTarget;
  /** Human-readable reason for logs / UI / terminal reason. */
  reason?: string;
  /** Epoch ms to auto-resume at (the binding window's reset), when known. */
  resumeAt?: number | null;
}

export interface QuotaThrottleOptions {
  /** Park when a window's utilization reaches this %. Default 90. */
  throttlePct?: number;
  /**
   * Whether paid overage is allowed. Default false (hard-never, decision #3).
   * When true, the overage-guard is skipped (the loop may consume credits).
   */
  allowOverage?: boolean;
}

const DEFAULT_THROTTLE_PCT = 90;

/** A window is the "credits/overage" bucket when it is denominated in USD. */
function isOverageWindow(w: ProviderQuotaWindow): boolean {
  return w.unit === 'usd';
}

function pct(w: ProviderQuotaWindow): number {
  return w.limit > 0 ? (w.used / w.limit) * 100 : 0;
}

function findClaudeDownshiftTarget(
  binding: ProviderQuotaWindow,
  windows: ProviderQuotaWindow[],
  throttlePct: number,
): QuotaDownshiftTarget | null {
  if (!binding.id.startsWith('claude.')) return null;
  if (binding.id === 'claude.5h' || binding.id === 'claude.weekly-sonnet') return null;

  const sonnet = windows.find((w) => w.id === 'claude.weekly-sonnet' && w.limit > 0);
  if (!sonnet || pct(sonnet) >= throttlePct) return null;

  const remainingPct = Math.max(0, Math.round(100 - pct(sonnet)));
  return {
    windowId: sonnet.id,
    model: 'sonnet',
    reason: `${sonnet.label} has ${remainingPct}% remaining`,
  };
}

/**
 * Evaluate the throttle ladder for one provider snapshot.
 */
export function evaluateQuotaThrottle(
  snapshot: ProviderQuotaSnapshot | null | undefined,
  options: QuotaThrottleOptions = {},
): QuotaThrottleDecision {
  if (!snapshot || !snapshot.ok || snapshot.windows.length === 0) {
    return { action: 'continue' };
  }

  const throttlePct = options.throttlePct ?? DEFAULT_THROTTLE_PCT;
  const allowOverage = options.allowOverage ?? false;

  // 1. Find the most-utilized non-overage window — the binding constraint.
  let binding: ProviderQuotaWindow | null = null;
  let bindingPct = -1;
  for (const w of snapshot.windows) {
    if (isOverageWindow(w)) continue;
    if (w.limit <= 0) continue;
    const p = pct(w);
    if (p > bindingPct) {
      binding = w;
      bindingPct = p;
    }
  }

  const credits = snapshot.windows.find(
    (w) => isOverageWindow(w) && w.limit > 0 && w.used > 0,
  );

  if (!binding) {
    if (!allowOverage && credits) {
      return {
        action: 'overage-guard',
        window: credits,
        reason:
          'paid overage credits are being consumed — parking (allowOverage is off)',
        resumeAt: credits.resetsAt,
      };
    }
    return { action: 'continue' };
  }

  // 2. Hard real-money guard: if a paid credits window is the only usable
  // quota signal, stop unless the operator explicitly opted in. Do not let a
  // nonzero credits bucket preempt normal-window headroom: Claude reports
  // extra_usage.used_credits as monthly cumulative usage, not proof that the
  // next request would currently consume paid overage.
  if (!allowOverage && bindingPct >= throttlePct) {
    if (credits && bindingPct >= 100) {
      return {
        action: 'overage-guard',
        window: credits,
        reason:
          'paid overage credits are being consumed — parking (allowOverage is off)',
        resumeAt: credits.resetsAt,
      };
    }
  }

  if (bindingPct >= 100) {
    return {
      action: 'park-exhausted',
      window: binding,
      reason: `${binding.label} exhausted (${Math.round(bindingPct)}%) — parking until it resets`,
      resumeAt: binding.resetsAt,
    };
  }

  if (bindingPct >= throttlePct) {
    const downshift = findClaudeDownshiftTarget(binding, snapshot.windows, throttlePct);
    if (downshift) {
      return {
        action: 'downshift',
        window: binding,
        downshift,
        reason: `${binding.label} at ${Math.round(bindingPct)}% — downshifting to ${downshift.model}`,
      };
    }
    return {
      action: 'throttle',
      window: binding,
      reason: `${binding.label} at ${Math.round(bindingPct)}% (≥ ${throttlePct}%) — parking before spilling into paid overage`,
      resumeAt: binding.resetsAt,
    };
  }

  return { action: 'continue' };
}

/** True when a decision means the loop must NOT spawn another iteration. */
export function isParkingDecision(d: QuotaThrottleDecision): boolean {
  return d.action !== 'continue' && d.action !== 'downshift';
}
