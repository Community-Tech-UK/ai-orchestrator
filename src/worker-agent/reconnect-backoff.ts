export const RECONNECT_CONFIG = {
  initialMs: 1_000,
  factor: 2,
  maxMs: 30_000,
  stableConnectionResetMs: 60_000,
};

/**
 * Decide whether the reconnect attempt counter should be reset to zero.
 *
 * The counter is ONLY reset after a connection that stayed up for at least
 * `stableConnectionResetMs`. A link that keeps dropping within a few seconds of
 * registering must NOT reset the counter — otherwise exponential backoff never
 * escalates and the worker hammers the coordinator (the 2026-07-03 flap storm).
 *
 * Pure and clock-injected so it can be unit-tested without real `Date.now()`.
 */
export function shouldResetReconnectAttempt(
  connectedAt: number,
  now: number,
  stableConnectionResetMs = RECONNECT_CONFIG.stableConnectionResetMs,
): boolean {
  return connectedAt > 0 && now - connectedAt > stableConnectionResetMs;
}

/**
 * Compute the next reconnect delay with capped exponential backoff plus jitter.
 * `rng` is injectable so tests can assert monotonic escalation without calling
 * `Math.random()` (repo convention: no real RNG/clock in tests).
 */
export function nextReconnectDelayMs(attempt: number, rng: () => number = Math.random): number {
  const exp = Math.min(
    RECONNECT_CONFIG.maxMs,
    RECONNECT_CONFIG.initialMs * RECONNECT_CONFIG.factor ** Math.min(attempt, 30),
  );
  return Math.floor(exp / 2 + rng() * (exp / 2));
}
