import { describe, expect, it } from 'vitest';
import { ErrorCategory, DEFAULT_RETRY_CONFIG, type RetryConfig } from '../../shared/types/error-recovery.types';
import { RetryManager } from './retry-manager';

describe('RetryManager', () => {
  const config: RetryConfig = {
    ...DEFAULT_RETRY_CONFIG,
    initialDelayMs: 1000,
    backoffMultiplier: 2,
    maxDelayMs: 30_000,
    jitter: false,
  };

  it('honors server rate-limit Retry-After without clamping to maxDelayMs', () => {
    const manager = RetryManager.getInstance() as unknown as {
      calculateDelay(
        attempt: number,
        config: RetryConfig,
        retryAfterMs: number | undefined,
        category?: ErrorCategory,
      ): number;
    };

    const delay = manager.calculateDelay(1, config, 15 * 60 * 1000, ErrorCategory.RATE_LIMITED);

    expect(delay).toBe(15 * 60 * 1000);
  });

  it('still clamps computed exponential backoff for non-server delays', () => {
    const manager = RetryManager.getInstance() as unknown as {
      calculateDelay(
        attempt: number,
        config: RetryConfig,
        retryAfterMs?: number,
        category?: ErrorCategory,
      ): number;
    };

    const delay = manager.calculateDelay(10, config, undefined, ErrorCategory.TRANSIENT);

    expect(delay).toBe(30_000);
  });
});
