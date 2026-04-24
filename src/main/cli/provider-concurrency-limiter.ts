/**
 * Provider Concurrency Limiter
 *
 * Per-provider semaphore that caps how many children of a given provider
 * can be alive at once. Motivated by the Copilot ACP fan-out incident: the
 * orchestrator spawned 5+ Copilot subprocesses in parallel, and a single
 * stuck `session/request_permission` RPC stalled the whole batch.
 *
 * Design:
 *   - `acquire(key)` returns a release function once a slot is free.
 *   - Slot limits are per provider `key` (e.g. 'copilot', 'cursor').
 *   - Default caps are conservative; tune via `setLimit()` if needed.
 *   - The limiter holds no process references itself — callers MUST call
 *     the returned release on adapter exit/termination/spawn failure.
 *
 * Not a hard rate limiter — it's a concurrent-slot gate. Waiters are
 * FIFO-ordered; a single wait-queue per provider key.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ProviderConcurrencyLimiter');

/**
 * Default concurrent child limit per provider.
 *
 * Copilot is capped tighter than the others because:
 *   - Each ACP child holds a persistent GitHub API connection + MCP clients,
 *     so fan-out multiplies backend load non-linearly.
 *   - Copilot CLI on macOS 26 has observed instability (keychain SIGSEGV,
 *     orphaned tool-call hangs) that is amplified by concurrent starts.
 * Others (Claude, Codex, Gemini, Cursor) are capped looser because they're
 * more stable under concurrent spawn load in practice.
 */
export const DEFAULT_PROVIDER_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  copilot: 3,
  cursor: 3,
  claude: 6,
  codex: 6,
  gemini: 6,
});

/** Fallback limit when a provider isn't listed in DEFAULT_PROVIDER_LIMITS. */
const FALLBACK_DEFAULT_LIMIT = 6;

interface ProviderSlot {
  /** Active slots currently held (pre-release). */
  active: number;
  /** Waiters, oldest first. Each resolves when a slot frees up. */
  waiters: (() => void)[];
  /** Effective concurrent cap for this provider. */
  limit: number;
}

export class ProviderConcurrencyLimiter {
  private static instance: ProviderConcurrencyLimiter | null = null;

  private readonly slots = new Map<string, ProviderSlot>();

  // Intentionally no custom constructor body — state is initialized via
  // field initializers above. Kept private to enforce the singleton access
  // pattern (callers go through `getInstance()` / `getProviderConcurrencyLimiter()`).

  static getInstance(): ProviderConcurrencyLimiter {
    if (!this.instance) {
      this.instance = new ProviderConcurrencyLimiter();
    }
    return this.instance;
  }

  /**
   * Reset for tests. Clears all slots and drains waiters (resolves them so
   * they don't leak pending promises).
   */
  static _resetForTesting(): void {
    if (this.instance) {
      for (const slot of this.instance.slots.values()) {
        while (slot.waiters.length > 0) {
          const next = slot.waiters.shift();
          next?.();
        }
      }
      this.instance.slots.clear();
    }
    this.instance = null;
  }

  /**
   * Override the slot limit for a provider. Existing active+waiter counts are
   * preserved; newly-freed slots respect the new cap.
   */
  setLimit(key: string, limit: number): void {
    if (!Number.isFinite(limit) || limit < 1) {
      throw new Error(`ProviderConcurrencyLimiter: limit for '${key}' must be >= 1; got ${limit}`);
    }
    const slot = this.getOrCreateSlot(key);
    const prev = slot.limit;
    slot.limit = Math.floor(limit);
    // If the cap grew, wake any waiters that now fit.
    this.drainWaiters(slot);
    if (prev !== slot.limit) {
      logger.info('Provider concurrency limit changed', { key, from: prev, to: slot.limit });
    }
  }

  /**
   * Acquire a slot for `key`. Resolves to a release function that MUST be
   * called exactly once when the consumer is done (on adapter exit / spawn
   * failure / terminate).
   *
   * Contract: `slot.active` is bumped exactly once per acquire — either
   * synchronously (fast path) or by the releaser that wakes a waiter
   * (slow path). The waiter's own continuation never touches `active`,
   * which keeps the invariant `active <= limit` trivial to verify.
   *
   * Idempotent release: calling the returned function twice is a no-op the
   * second time (defensive — the real invariant is "exactly once").
   */
  async acquire(key: string): Promise<() => void> {
    const slot = this.getOrCreateSlot(key);

    if (slot.active < slot.limit) {
      slot.active += 1;
      logger.debug('Acquired provider slot immediately', {
        key,
        active: slot.active,
        limit: slot.limit,
      });
      return this.makeReleaser(key);
    }

    logger.info('Provider slot full, queueing waiter', {
      key,
      active: slot.active,
      limit: slot.limit,
      waiters: slot.waiters.length,
    });

    // The releaser will bump `slot.active` before calling our resolver, so
    // we inherit an already-counted slot when the promise settles.
    await new Promise<void>((resolve) => {
      slot.waiters.push(resolve);
    });

    logger.debug('Acquired provider slot after waiting', {
      key,
      active: slot.active,
      limit: slot.limit,
    });
    return this.makeReleaser(key);
  }

  /** Snapshot of counters for diagnostics / tests. */
  getStats(key: string): { active: number; waiting: number; limit: number } {
    const slot = this.slots.get(key);
    if (!slot) {
      return { active: 0, waiting: 0, limit: DEFAULT_PROVIDER_LIMITS[key] ?? FALLBACK_DEFAULT_LIMIT };
    }
    return { active: slot.active, waiting: slot.waiters.length, limit: slot.limit };
  }

  private getOrCreateSlot(key: string): ProviderSlot {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = {
        active: 0,
        waiters: [],
        limit: DEFAULT_PROVIDER_LIMITS[key] ?? FALLBACK_DEFAULT_LIMIT,
      };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private makeReleaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const slot = this.slots.get(key);
      if (!slot) return;

      // Transfer the slot either back to the pool or directly to the
      // next waiter. Doing the hand-off inside this branch means
      // `slot.active` is ONLY decremented when there's no one to hand
      // off to — so it never temporarily falls below the true active
      // holder count between release and waiter resumption.
      if (slot.waiters.length > 0) {
        const next = slot.waiters.shift()!;
        next();
      } else {
        slot.active = Math.max(0, slot.active - 1);
      }

      logger.debug('Released provider slot', {
        key,
        active: slot.active,
        limit: slot.limit,
        waiters: slot.waiters.length,
      });
    };
  }

  private drainWaiters(slot: ProviderSlot): void {
    // Used only by `setLimit` when the cap is raised. Wake as many
    // waiters as there is headroom for; each waiter gets its slot
    // accounted for via `active += 1` here (same convention as the
    // releaser hand-off).
    while (slot.active < slot.limit && slot.waiters.length > 0) {
      slot.active += 1;
      const next = slot.waiters.shift()!;
      next();
    }
  }
}

export function getProviderConcurrencyLimiter(): ProviderConcurrencyLimiter {
  return ProviderConcurrencyLimiter.getInstance();
}
