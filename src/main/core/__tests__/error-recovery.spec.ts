import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must appear before any import that transitively loads Electron
// ---------------------------------------------------------------------------

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks are in place)
// ---------------------------------------------------------------------------

import {
  ErrorRecoveryManager,
  retryWithBackoff,
} from '../error-recovery';
import { ErrorCategory, ErrorSeverity } from '../../../shared/types/error-recovery.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(message: string, code?: string | number): Error {
  const err = new Error(message);
  if (code !== undefined) {
    (err as Error & { code?: string | number }).code = code;
  }
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ErrorRecoveryManager', () => {
  let manager: ErrorRecoveryManager;

  beforeEach(() => {
    ErrorRecoveryManager._resetForTesting();
    manager = ErrorRecoveryManager.getInstance();
  });

  afterEach(() => {
    ErrorRecoveryManager._resetForTesting();
  });

  // -------------------------------------------------------------------------
  // classifyError
  // -------------------------------------------------------------------------

  describe('classifyError', () => {
    it('classifies rate limit errors', () => {
      const result = manager.classifyError(makeError('Too Many Requests — rate limit exceeded'));

      expect(result.category).toBe(ErrorCategory.RATE_LIMITED);
      expect(result.recoverable).toBe(true);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it('classifies network errors', () => {
      const result = manager.classifyError(makeError('ECONNREFUSED — connection refused'));

      expect(result.category).toBe(ErrorCategory.NETWORK);
      expect(result.recoverable).toBe(true);
    });

    it('classifies auth errors', () => {
      const result = manager.classifyError(makeError('Unauthorized — invalid API key'));

      expect(result.category).toBe(ErrorCategory.AUTH);
      expect(result.severity).toBe(ErrorSeverity.CRITICAL);
      expect(result.recoverable).toBe(false);
    });

    it('classifies context overflow', () => {
      const result = manager.classifyError(makeError('context length exceeded maximum tokens'));

      expect(result.category).toBe(ErrorCategory.RESOURCE);
      expect(result.recoverable).toBe(true);
    });

    it('classifies CLI not installed errors', () => {
      const result = manager.classifyError(makeError('command not found: claude'));

      expect(result.category).toBe(ErrorCategory.PERMANENT);
      expect(result.severity).toBe(ErrorSeverity.CRITICAL);
      expect(result.recoverable).toBe(false);
    });

    it('classifies unknown errors as UNKNOWN category', () => {
      const result = manager.classifyError(makeError('some completely unrecognized error xyz'));

      expect(result.category).toBe(ErrorCategory.UNKNOWN);
      expect(result.recoverable).toBe(false);
      expect(result.userMessage).toBe('An unexpected error occurred.');
    });

    it('attaches the original error', () => {
      const original = makeError('rate limit hit');
      const result = manager.classifyError(original);

      expect(result.original).toBe(original);
    });

    it('attaches source when provided', () => {
      const result = manager.classifyError(makeError('ECONNRESET'), 'test-source');

      expect(result.source).toBe('test-source');
    });

    it('classifies by error code when message does not match', () => {
      // code 429 maps to rate_limit pattern via codePatterns
      const result = manager.classifyError(makeError('some message', 429));

      expect(result.category).toBe(ErrorCategory.RATE_LIMITED);
    });
  });

  // -------------------------------------------------------------------------
  // recordError and getErrorStats (via public surface)
  // -------------------------------------------------------------------------

  describe('recordError and getErrorStats', () => {
    it('tracks error counts in history by category', () => {
      manager.classifyError(makeError('ECONNREFUSED'));
      manager.classifyError(makeError('ECONNRESET'));
      manager.classifyError(makeError('Too many requests'));

      const history = manager.getErrorHistory();
      expect(history).toHaveLength(3);

      const networkErrors = history.filter(e => e.category === ErrorCategory.NETWORK);
      const rateLimitErrors = history.filter(e => e.category === ErrorCategory.RATE_LIMITED);

      expect(networkErrors).toHaveLength(2);
      expect(rateLimitErrors).toHaveLength(1);
    });

    it('tracks consecutive failures', () => {
      expect(manager.getConsecutiveFailures()).toBe(0);

      manager.classifyError(makeError('ECONNREFUSED'));
      expect(manager.getConsecutiveFailures()).toBe(1);

      manager.classifyError(makeError('ECONNRESET'));
      expect(manager.getConsecutiveFailures()).toBe(2);
    });

    it('resets consecutive count on completeAction', async () => {
      // Trigger some failures to increment the counter
      manager.classifyError(makeError('ECONNREFUSED'));
      manager.classifyError(makeError('ECONNRESET'));
      expect(manager.getConsecutiveFailures()).toBe(2);

      // Create a plan and execute an action so completeAction has something to work with
      const classified = manager.classifyError(makeError('ECONNREFUSED'));
      const plan = manager.createRecoveryPlan(classified);
      await manager.executeNextAction(plan.id);
      manager.completeAction(plan.id, true);

      expect(manager.getConsecutiveFailures()).toBe(0);
    });

    it('caps error history at 100 entries', () => {
      for (let i = 0; i < 110; i++) {
        manager.classifyError(makeError(`ECONNREFUSED error ${i}`));
      }

      const history = manager.getErrorHistory();
      expect(history.length).toBeLessThanOrEqual(100);
    });

    it('returns limited history when limit is specified', () => {
      for (let i = 0; i < 10; i++) {
        manager.classifyError(makeError(`ECONNREFUSED error ${i}`));
      }

      const history = manager.getErrorHistory(3);
      expect(history).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // retryWithBackoff
  // -------------------------------------------------------------------------

  describe('retryWithBackoff', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('succeeds on first try for non-failing functions', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const result = await retryWithBackoff(fn, { maxRetries: 3 });

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient failure and succeeds', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeError('ECONNREFUSED first failure'))
        .mockResolvedValue('success after retry');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelayMs: 100,
      });

      // Advance timers to flush the backoff delay
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe('success after retry');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('applies exponential backoff between retries', async () => {
      const delays: number[] = [];
      const originalSetTimeout = globalThis.setTimeout;

      // Spy on setTimeout to capture delays used
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: TimerHandler, delay?: number) => {
          delays.push(delay ?? 0);
          return originalSetTimeout(fn as () => void, 0);
        }
      );

      const fn = vi.fn()
        .mockRejectedValueOnce(makeError('ETIMEDOUT attempt 1'))
        .mockRejectedValueOnce(makeError('ETIMEDOUT attempt 2'))
        .mockResolvedValue('done');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
        maxDelayMs: 30000,
      });

      await vi.runAllTimersAsync();
      await promise;

      setTimeoutSpy.mockRestore();

      // Two delays should have been recorded (after attempt 0 and attempt 1)
      expect(delays).toHaveLength(2);

      // Second delay should be approximately double the first (ignoring jitter)
      // With initialDelayMs=1000, multiplier=2: delay0≈1000, delay1≈2000
      // Allow for ±20% jitter
      expect(delays[0]).toBeGreaterThan(800);
      expect(delays[0]).toBeLessThan(1200);
      expect(delays[1]).toBeGreaterThan(1600);
      expect(delays[1]).toBeLessThan(2400);
    });

    it('stops after max retries and throws the last error', async () => {
      const error = makeError('ECONNREFUSED persistent failure');
      const fn = vi.fn().mockRejectedValue(error);

      // Attach assertion first so rejection is never unhandled
      const assertion = expect(
        retryWithBackoff(fn, { maxRetries: 2, initialDelayMs: 10 })
      ).rejects.toThrow('ECONNREFUSED persistent failure');

      await vi.runAllTimersAsync();
      await assertion;

      // 1 initial attempt + 2 retries = 3 total calls
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('does not retry non-recoverable errors', async () => {
      // Auth errors are non-recoverable — should throw immediately without retry
      const error = makeError('Unauthorized — invalid API key');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, { maxRetries: 3, initialDelayMs: 10 })
      ).rejects.toThrow('Unauthorized — invalid API key');

      // Should have been called exactly once (no retries)
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('does not retry when custom retryCondition returns false', async () => {
      const error = makeError('ECONNREFUSED network issue');
      const fn = vi.fn().mockRejectedValue(error);

      await expect(
        retryWithBackoff(fn, {
          maxRetries: 3,
          initialDelayMs: 10,
          retryCondition: () => false,
        })
      ).rejects.toThrow('ECONNREFUSED network issue');

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('respects custom retryCondition that allows retry', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(makeError('ECONNREFUSED first'))
        .mockResolvedValue('ok');

      const promise = retryWithBackoff(fn, {
        maxRetries: 3,
        initialDelayMs: 10,
        retryCondition: () => true,
      });

      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});
