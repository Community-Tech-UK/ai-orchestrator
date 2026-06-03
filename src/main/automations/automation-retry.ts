/**
 * Retry / backoff utilities for automation runs (B10b).
 *
 * Jitter is DETERMINISTIC — derived from a hash of automationId + attempt so
 * that tests can assert exact delay values without any random variation and so
 * that two processes racing on the same automation don't produce random skew.
 */

import * as crypto from 'crypto';

/** Default maximum number of attempts per run (1 = first try, no retries). */
export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

/**
 * Base delay for the first retry (attempt 2) in milliseconds.
 * Subsequent delays follow: baseDelay * 2^(attempt - 2)
 * i.e. attempt 2 → base, attempt 3 → 2*base, attempt 4 → 4*base, …
 */
export const DEFAULT_RETRY_BASE_DELAY_MS = 30_000; // 30 s

/** Hard cap on a single backoff delay regardless of attempt number. */
export const MAX_RETRY_DELAY_MS = 10 * 60_000; // 10 min

/**
 * Compute a deterministic jitter fraction in [0, 1) for the given
 * automationId + attempt combination.  Uses the first two bytes of a SHA-256
 * digest so the result is stable across processes and test runs.
 */
export function deterministicJitterFraction(automationId: string, attempt: number): number {
  const digest = crypto
    .createHash('sha256')
    .update(`${automationId}:${attempt}`)
    .digest();
  // Use two bytes → 0x0000..0xFFFF range, map to [0, 1)
  const raw = (digest[0]! << 8) | digest[1]!;
  return raw / 0x10000;
}

/**
 * Compute the delay in milliseconds before the next retry attempt.
 *
 * Formula: min(baseDelay * 2^(attempt - 2), MAX_RETRY_DELAY_MS) + jitter * baseDelay
 *
 * The jitter term is bounded to one full `baseDelay` so it cannot push the
 * delay above `MAX_RETRY_DELAY_MS + baseDelay`.
 *
 * @param automationId  Stable identifier used to seed the jitter hash.
 * @param attempt       The attempt number that JUST FAILED (1-based).
 *                      For example, pass 1 if the first try failed and we are
 *                      computing when to schedule attempt 2.
 * @param baseDelayMs   Base delay for the first retry (default 30 s).
 */
export function computeRetryDelayMs(
  automationId: string,
  attempt: number,
  baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
): number {
  // attempt is the attempt that just failed; next attempt index is attempt + 1
  // but exponential growth starts at attempt 1 failing → delay = baseDelay * 2^0
  const exponent = Math.max(0, attempt - 1);
  const exponential = Math.min(baseDelayMs * Math.pow(2, exponent), MAX_RETRY_DELAY_MS);
  const jitter = deterministicJitterFraction(automationId, attempt) * baseDelayMs;
  return Math.round(exponential + jitter);
}
