/**
 * RespawnCircuitBreaker — per-instance respawn / recovery circuit breaker (§6.3, §F).
 *
 * Pattern adapted from nanoclaw's startup breaker:
 *   - RESET_WINDOW_MS = 1 hour: if the instance is stable for this long, the counter resets.
 *   - BACKOFF_SCHEDULE_S = [0, 0, 10, 30, 120, 300, 900]: delay (seconds) before each
 *     successive respawn attempt within the reset window.
 *
 * Usage:
 *   1. Call `recordAttempt()` when a respawn/recovery starts.
 *   2. If `recordAttempt()` returns a non-zero delay, wait that long before spawning.
 *   3. Call `recordSuccess()` when the instance has been stable (idle) for a while — this
 *      resets the breaker. Internally, success-on-stable is gated by the caller checking
 *      `getNextDelayMs() === 0` to avoid premature reset.
 *
 * The registry is module-scoped (per-process) and keyed by instanceId.
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('RespawnCircuitBreaker');

const RESET_WINDOW_MS = 60 * 60 * 1_000; // 1 hour
const BACKOFF_SCHEDULE_MS = [0, 0, 10_000, 30_000, 120_000, 300_000, 900_000];

export interface CircuitBreakerState {
  attempt: number;
  lastAttemptAt: number;
  openUntil: number;
}

export class RespawnCircuitBreaker {
  private attempt = 0;
  private lastAttemptAt = 0;
  private openUntil = 0;

  constructor(readonly instanceId: string) {}

  /**
   * Record a respawn attempt and return the required delay in milliseconds
   * before the spawn should actually start. Callers MUST wait this long.
   * Returns 0 if the spawn can proceed immediately.
   */
  recordAttempt(now = Date.now()): number {
    // If the last attempt was more than 1h ago, the window has lapsed — reset.
    if (this.attempt > 0 && now - this.lastAttemptAt > RESET_WINDOW_MS) {
      this.attempt = 0;
      this.openUntil = 0;
      logger.debug('Circuit breaker reset (window lapsed)', { instanceId: this.instanceId });
    }

    const delay = BACKOFF_SCHEDULE_MS[Math.min(this.attempt, BACKOFF_SCHEDULE_MS.length - 1)];
    this.attempt++;
    this.lastAttemptAt = now;
    this.openUntil = now + delay;

    if (delay > 0) {
      logger.warn('Circuit breaker backing off before respawn', {
        instanceId: this.instanceId,
        attempt: this.attempt,
        delayMs: delay,
      });
    }

    return delay;
  }

  /**
   * Record that the instance has been stable. Resets the attempt counter only
   * if the 1-hour reset window has elapsed since the last attempt.
   */
  recordSuccess(now = Date.now()): void {
    if (this.attempt > 0 && now - this.lastAttemptAt > RESET_WINDOW_MS) {
      this.attempt = 0;
      this.openUntil = 0;
      logger.debug('Circuit breaker reset (stable after window)', { instanceId: this.instanceId });
    }
  }

  /**
   * Returns the delay (ms) before the next attempt is allowed; 0 if open.
   */
  remainingDelayMs(now = Date.now()): number {
    return Math.max(0, this.openUntil - now);
  }

  isOpen(now = Date.now()): boolean {
    return this.remainingDelayMs(now) > 0;
  }

  snapshot(now = Date.now()): CircuitBreakerState {
    return {
      attempt: this.attempt,
      lastAttemptAt: this.lastAttemptAt,
      openUntil: this.openUntil,
    };
  }

  /** For tests only — reset state to clean slate. */
  _resetForTesting(): void {
    this.attempt = 0;
    this.lastAttemptAt = 0;
    this.openUntil = 0;
  }
}

// ─── Per-instance registry ───────────────────────────────────────────────────

const registry = new Map<string, RespawnCircuitBreaker>();

export function getOrCreateCircuitBreaker(instanceId: string): RespawnCircuitBreaker {
  let breaker = registry.get(instanceId);
  if (!breaker) {
    breaker = new RespawnCircuitBreaker(instanceId);
    registry.set(instanceId, breaker);
  }
  return breaker;
}

export function deleteCircuitBreaker(instanceId: string): void {
  registry.delete(instanceId);
}

export function _resetAllCircuitBreakersForTesting(): void {
  registry.clear();
}
