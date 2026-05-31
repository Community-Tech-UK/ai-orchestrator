/**
 * Failover cooldown lanes + model-scoped cooldown tracker (claude2_todo #10).
 *
 * Two net-new pieces over the existing provider failover:
 *
 *  1. **Reason-scoped backoff lanes** — a 402/billing failure should sideline a
 *     provider/model far longer (hours → a day) than a transient 429 rate-limit
 *     (a minute → an hour), because billing won't self-heal on a retry. This
 *     maps each `FailoverReason` to an exponential lane (base → cap).
 *
 *  2. **Model-scoped cooldowns** — a single rate-limited *model* should not
 *     blacklist its whole provider. `ModelCooldownTracker` cools down individual
 *     model keys so the provider's other models stay selectable.
 *
 * Pure except for an injectable `now` (defaults to `Date.now()`), so every
 * schedule is deterministically unit-testable.
 */

import type { FailoverReason } from '../core/failover-error';

const MIN = 60_000;
const HOUR = 60 * MIN;

export interface CooldownLane {
  /** Cooldown for the first failure in this lane. */
  baseMs: number;
  /** Hard ceiling regardless of how many consecutive failures. */
  maxMs: number;
  /** Exponential growth factor per additional consecutive failure. */
  factor: number;
}

/**
 * Per-reason backoff schedules. The long "disabled" lanes (billing / auth /
 * permission) need an operator action to clear, so they start high; the
 * transient lanes self-heal, so they start low and grow modestly.
 */
export const COOLDOWN_LANES: Record<FailoverReason, CooldownLane> = {
  billing: { baseMs: 5 * HOUR, maxMs: 24 * HOUR, factor: 2 },
  auth: { baseMs: 30 * MIN, maxMs: 6 * HOUR, factor: 2 },
  permission: { baseMs: 30 * MIN, maxMs: 6 * HOUR, factor: 2 },
  rate_limit: { baseMs: 1 * MIN, maxMs: 1 * HOUR, factor: 4 },
  validation: { baseMs: 1 * MIN, maxMs: 1 * HOUR, factor: 2 },
  unknown: { baseMs: 1 * MIN, maxMs: 1 * HOUR, factor: 2 },
  timeout: { baseMs: 15_000, maxMs: 5 * MIN, factor: 3 },
  provider_runtime: { baseMs: 15_000, maxMs: 5 * MIN, factor: 3 },
  prompt_delivery: { baseMs: 15_000, maxMs: 5 * MIN, factor: 3 },
  tool_runtime: { baseMs: 15_000, maxMs: 5 * MIN, factor: 3 },
  session_resume: { baseMs: 15_000, maxMs: 5 * MIN, factor: 3 },
  context_overflow: { baseMs: 10_000, maxMs: 1 * MIN, factor: 2 },
  process_exit: { baseMs: 10_000, maxMs: 1 * MIN, factor: 2 },
  stale_worktree: { baseMs: 10_000, maxMs: 1 * MIN, factor: 2 },
};

/** Reasons that need an operator action to clear — the "disabled" lanes. */
export function isLongCooldownLane(reason: FailoverReason): boolean {
  return reason === 'billing' || reason === 'auth' || reason === 'permission';
}

/**
 * Backoff (ms) for the `consecutiveFailures`-th failure of `reason`, capped at
 * the lane's `maxMs`. `consecutiveFailures` is clamped to ≥ 1.
 */
export function cooldownMsFor(reason: FailoverReason, consecutiveFailures = 1): number {
  const lane = COOLDOWN_LANES[reason] ?? COOLDOWN_LANES.unknown;
  const n = Math.max(1, Math.floor(consecutiveFailures || 1));
  const ms = lane.baseMs * lane.factor ** (n - 1);
  return Math.min(lane.maxMs, Math.round(ms));
}

/**
 * Tracks cooldowns keyed by an arbitrary model key (e.g. `provider::model`), so
 * a rate-limited model is sidelined without blacklisting the whole provider.
 * Expired entries are lazily pruned on read.
 */
export class ModelCooldownTracker {
  private readonly until = new Map<string, { at: number; reason: FailoverReason }>();

  /** Put `key` on cooldown for `reason`. Returns the epoch-ms it clears at. */
  set(key: string, reason: FailoverReason, consecutiveFailures = 1, now: number = Date.now()): number {
    const at = now + cooldownMsFor(reason, consecutiveFailures);
    this.until.set(key, { at, reason });
    return at;
  }

  isOnCooldown(key: string, now: number = Date.now()): boolean {
    const entry = this.until.get(key);
    if (!entry) return false;
    if (now >= entry.at) {
      this.until.delete(key);
      return false;
    }
    return true;
  }

  /** Remaining cooldown in ms (0 when not on cooldown). */
  remainingMs(key: string, now: number = Date.now()): number {
    const entry = this.until.get(key);
    if (!entry) return 0;
    const remaining = entry.at - now;
    if (remaining <= 0) {
      this.until.delete(key);
      return 0;
    }
    return remaining;
  }

  /** The reason a key is on cooldown, or null. */
  reasonFor(key: string, now: number = Date.now()): FailoverReason | null {
    return this.isOnCooldown(key, now) ? this.until.get(key)!.reason : null;
  }

  clear(key: string): void {
    this.until.delete(key);
  }

  reset(): void {
    this.until.clear();
  }
}
