import { describe, expect, it, vi } from 'vitest';
import { ErrorCategory } from '../../shared/types/error-recovery.types';
import { computeBackoff, retryWithBackoff } from './backoff';

describe('computeBackoff', () => {
  it('uses a capped exponential curve with no jitter when disabled', () => {
    const options = { baseMs: 200, factor: 2, maxMs: 500, jitterRatio: 0 };

    expect(computeBackoff(0, options)).toBe(200);
    expect(computeBackoff(1, options)).toBe(400);
    expect(computeBackoff(2, options)).toBe(500);
    expect(computeBackoff(20, options)).toBe(500);
  });

  it('only adds positive jitter so a retry cannot precede its base delay', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      expect(computeBackoff(0, { baseMs: 1_000, jitterRatio: 0.1 })).toBe(1_050);
    } finally {
      random.mockRestore();
    }
  });
});

describe('retryWithBackoff', () => {
  it('uses a caller-supplied delay policy when a legacy retry schedule must be preserved', async () => {
    const error = new Error('temporary outage');
    const operation = vi.fn()
      .mockRejectedValueOnce(error)
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(retryWithBackoff(operation, {
      attempts: 3,
      classify: () => ErrorCategory.TRANSIENT,
      delayForAttempt: (attempt) => [5_000, 15_000][attempt] ?? 15_000,
      sleep,
    })).resolves.toBe('recovered');

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([5_000, 15_000]);
  });

  it('retries a retryable classified error and reports the scheduled delay', async () => {
    const error = new Error('temporary outage');
    const operation = vi.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce('recovered');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(retryWithBackoff(operation, {
      attempts: 2,
      classify: () => ErrorCategory.TRANSIENT,
      backoff: { baseMs: 25, jitterRatio: 0 },
      sleep,
      onRetry,
    })).resolves.toBe('recovered');

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25, undefined);
    expect(onRetry).toHaveBeenCalledWith({
      attempt: 1,
      category: ErrorCategory.TRANSIENT,
      delayMs: 25,
      error,
    });
  });

  it('does not retry a non-retryable classified error', async () => {
    const error = new Error('invalid credentials');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(retryWithBackoff(operation, {
      attempts: 3,
      classify: () => ErrorCategory.AUTH,
      sleep,
    })).rejects.toBe(error);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops scheduling retries after its abort signal fires', async () => {
    const controller = new AbortController();
    const error = new Error('temporary outage');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {
      controller.abort(new Error('caller stopped retrying'));
    });

    await expect(retryWithBackoff(operation, {
      attempts: 3,
      classify: () => ErrorCategory.TRANSIENT,
      signal: controller.signal,
      sleep,
    })).rejects.toThrow('caller stopped retrying');

    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
