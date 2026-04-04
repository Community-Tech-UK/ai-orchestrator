import { describe, it, expect } from 'vitest';
import { nextReconnectDelayMs, RECONNECT_CONFIG } from '../reconnect-backoff';

describe('reconnect-backoff', () => {
  it('returns delay in initial range for attempt 0', () => {
    const delay = nextReconnectDelayMs(0);
    expect(delay).toBeGreaterThanOrEqual(RECONNECT_CONFIG.initialMs / 2);
    expect(delay).toBeLessThanOrEqual(RECONNECT_CONFIG.initialMs);
  });

  it('increases delay with attempts', () => {
    const delays = Array.from({ length: 100 }, () => nextReconnectDelayMs(5));
    const maxDelay = Math.max(...delays);
    expect(maxDelay).toBeGreaterThan(RECONNECT_CONFIG.initialMs);
  });

  it('caps at maxMs', () => {
    const delay = nextReconnectDelayMs(100);
    expect(delay).toBeLessThanOrEqual(RECONNECT_CONFIG.maxMs);
  });

  it('always returns a positive number', () => {
    for (let i = 0; i < 50; i++) {
      expect(nextReconnectDelayMs(i)).toBeGreaterThan(0);
    }
  });
});
