import { describe, expect, it, vi } from 'vitest';

import { ErrorCategory } from '../../../shared/types/error-recovery.types';
import { CliRetryCoordinator } from './cli-retry-coordinator';

describe('CliRetryCoordinator', () => {
  it('classifies failures once and applies a caller-preserved retry schedule', async () => {
    const transient = new Error('temporary');
    const classify = vi.fn(() => ErrorCategory.TRANSIENT);
    const operation = vi.fn()
      .mockRejectedValueOnce(transient)
      .mockResolvedValueOnce('recovered');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    const coordinator = new CliRetryCoordinator({ classify });

    await expect(coordinator.run(operation, {
      attempts: 3,
      retryDelaysMs: [5_000, 15_000],
      sleep,
      onRetry,
    })).resolves.toBe('recovered');

    expect(classify).toHaveBeenCalledWith(transient);
    expect(sleep).toHaveBeenCalledWith(5_000, undefined);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({
      attempt: 1,
      category: ErrorCategory.TRANSIENT,
      delayMs: 5_000,
      error: transient,
    }));
  });

  it('repeats the last configured delay and propagates the final error', async () => {
    const error = new Error('still temporary');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const coordinator = new CliRetryCoordinator({
      classify: () => ErrorCategory.TRANSIENT,
    });

    await expect(coordinator.run(operation, {
      attempts: 4,
      retryDelaysMs: [10, 20],
      sleep,
    })).rejects.toBe(error);

    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 20]);
  });

  it('does not retry a permanent classification', async () => {
    const error = new Error('bad request');
    const operation = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const coordinator = new CliRetryCoordinator({
      classify: () => ErrorCategory.PERMANENT,
    });

    await expect(coordinator.run(operation, { attempts: 3, sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
