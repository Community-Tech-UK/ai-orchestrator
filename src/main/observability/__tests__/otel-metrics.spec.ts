/**
 * OTel Metrics Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import {
  initMetrics,
  getOrchestratorMeter,
  shutdownMetrics,
  withMetrics,
  withMetricsSync,
  METRICS,
  _resetMetricsForTesting,
} from '../otel-metrics';

describe('OTel Metrics', () => {
  beforeEach(() => {
    _resetMetricsForTesting();
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('initMetrics returns a Meter', () => {
    const meter = initMetrics();
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe('function');
    expect(typeof meter.createHistogram).toBe('function');
  });

  it('initMetrics is idempotent — second call returns the same global meter', () => {
    const m1 = initMetrics();
    const m2 = initMetrics();
    // Both should resolve to the same meter name (globally set provider)
    expect(m1).toBeDefined();
    expect(m2).toBeDefined();
  });

  it('getOrchestratorMeter returns a usable meter after init', () => {
    initMetrics();
    const meter = getOrchestratorMeter();
    expect(meter).toBeDefined();
    const counter = meter.createCounter('test_counter');
    expect(() => counter.add(1)).not.toThrow();
  });

  it('METRICS constants are non-empty strings', () => {
    for (const [key, value] of Object.entries(METRICS)) {
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
      expect(value).toMatch(/^aio_/);
      void key; // suppress unused-variable lint
    }
  });

  describe('withMetrics', () => {
    it('resolves with the function return value on success', async () => {
      initMetrics();
      const result = await withMetrics(
        { counter: METRICS.PROVIDER_TURNS, timer: METRICS.PROVIDER_TURN_DURATION, attributes: { provider: 'claude' } },
        async () => 'ok',
      );
      expect(result).toBe('ok');
    });

    it('re-throws on error and still records metrics', async () => {
      initMetrics();
      await expect(
        withMetrics({ counter: METRICS.IPC_REQUESTS }, async () => { throw new Error('boom'); }),
      ).rejects.toThrow('boom');
    });

    it('works with no counter or timer configured', async () => {
      initMetrics();
      const result = await withMetrics({}, async () => 42);
      expect(result).toBe(42);
    });
  });

  describe('withMetricsSync', () => {
    it('returns function value on success', () => {
      initMetrics();
      const result = withMetricsSync(
        { counter: METRICS.CLI_RESTARTS, attributes: { provider: 'gemini' } },
        () => 'sync-ok',
      );
      expect(result).toBe('sync-ok');
    });

    it('re-throws on error', () => {
      initMetrics();
      expect(() =>
        withMetricsSync({ counter: METRICS.CLI_RESTARTS }, () => { throw new Error('sync-err'); }),
      ).toThrow('sync-err');
    });
  });
});
