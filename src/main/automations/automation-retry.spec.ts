import { describe, it, expect } from 'vitest';
import {
  computeRetryDelayMs,
  deterministicJitterFraction,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  MAX_RETRY_DELAY_MS,
} from './automation-retry';

describe('automation-retry utilities', () => {
  describe('deterministicJitterFraction', () => {
    it('returns a value in [0, 1)', () => {
      const f = deterministicJitterFraction('auto-1', 1);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    });

    it('is deterministic — same inputs always produce same output', () => {
      const a = deterministicJitterFraction('automation-abc', 2);
      const b = deterministicJitterFraction('automation-abc', 2);
      expect(a).toBe(b);
    });

    it('differs for different attempt numbers', () => {
      const a = deterministicJitterFraction('auto-1', 1);
      const b = deterministicJitterFraction('auto-1', 2);
      expect(a).not.toBe(b);
    });

    it('differs for different automation IDs', () => {
      const a = deterministicJitterFraction('auto-A', 1);
      const b = deterministicJitterFraction('auto-B', 1);
      expect(a).not.toBe(b);
    });
  });

  describe('computeRetryDelayMs', () => {
    it('is deterministic — same inputs always produce same delay', () => {
      const d1 = computeRetryDelayMs('auto-1', 1, 30_000);
      const d2 = computeRetryDelayMs('auto-1', 1, 30_000);
      expect(d1).toBe(d2);
    });

    it('first retry (attempt=1 failed) delay is baseDelay + jitter', () => {
      const base = 30_000;
      const jitter = deterministicJitterFraction('auto-x', 1) * base;
      const expected = Math.round(base + jitter);
      expect(computeRetryDelayMs('auto-x', 1, base)).toBe(expected);
    });

    it('second retry (attempt=2 failed) delay is 2*baseDelay + jitter (uncapped)', () => {
      const base = 30_000;
      // exponent = max(0, 2-1) = 1 → exponential = base * 2^1 = 2*base
      const jitter = deterministicJitterFraction('auto-x', 2) * base;
      const expected = Math.round(2 * base + jitter);
      expect(computeRetryDelayMs('auto-x', 2, base)).toBe(expected);
    });

    it('third retry (attempt=3 failed) delay is 4*baseDelay + jitter (uncapped)', () => {
      const base = 30_000;
      // exponent = max(0, 3-1) = 2 → exponential = base * 2^2 = 4*base
      const jitter = deterministicJitterFraction('auto-x', 3) * base;
      const expected = Math.round(4 * base + jitter);
      expect(computeRetryDelayMs('auto-x', 3, base)).toBe(expected);
    });

    it('caps exponential part at MAX_RETRY_DELAY_MS regardless of attempt', () => {
      // With base=30_000 and attempt=100, exponential would be astronomically
      // large but must be capped.
      const delay = computeRetryDelayMs('auto-cap', 100, 30_000);
      // Jitter term can add at most one base delay on top.
      expect(delay).toBeLessThanOrEqual(MAX_RETRY_DELAY_MS + 30_000);
    });

    it('grows with increasing attempt number (pre-cap)', () => {
      const d1 = computeRetryDelayMs('auto-grow', 1, 1_000);
      const d2 = computeRetryDelayMs('auto-grow', 2, 1_000);
      const d3 = computeRetryDelayMs('auto-grow', 3, 1_000);
      // Each successive delay should be larger (exponential growth dominates jitter).
      expect(d2).toBeGreaterThan(d1);
      expect(d3).toBeGreaterThan(d2);
    });

    it('uses DEFAULT_RETRY_BASE_DELAY_MS when no base is provided', () => {
      const withDefault = computeRetryDelayMs('auto-d', 1);
      const explicit = computeRetryDelayMs('auto-d', 1, DEFAULT_RETRY_BASE_DELAY_MS);
      expect(withDefault).toBe(explicit);
    });
  });

  describe('constants', () => {
    it('DEFAULT_MAX_RETRY_ATTEMPTS is > 1 so retries actually happen', () => {
      expect(DEFAULT_MAX_RETRY_ATTEMPTS).toBeGreaterThan(1);
    });

    it('DEFAULT_RETRY_BASE_DELAY_MS is a positive number', () => {
      expect(DEFAULT_RETRY_BASE_DELAY_MS).toBeGreaterThan(0);
    });
  });
});
