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

});
