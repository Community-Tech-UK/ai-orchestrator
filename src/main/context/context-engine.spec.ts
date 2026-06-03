import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContextUsage } from '../../shared/types/instance.types';

const hoisted = vi.hoisted(() => {
  const coordinator = {
    onContextUpdate: vi.fn(),
    compactInstance: vi.fn(async () => ({ success: true })),
    isCompacting: vi.fn(() => false),
    cleanupInstance: vi.fn(),
  };
  return { coordinator };
});

vi.mock('./compaction-coordinator', () => ({
  getCompactionCoordinator: () => hoisted.coordinator,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  LegacyContextEngine,
  SafeContextEngine,
  getContextEngine,
  setContextEngine,
  _resetContextEngineForTesting,
  type ContextEngine,
} from './context-engine';

const usage = (percentage: number): ContextUsage =>
  ({ used: percentage * 10, total: 1000, percentage }) as ContextUsage;

describe('LegacyContextEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetContextEngineForTesting();
  });

  it('delegates onContextUpdate to the coordinator', () => {
    const engine = new LegacyContextEngine();
    const u = usage(42);
    engine.onContextUpdate('i1', u);
    expect(hoisted.coordinator.onContextUpdate).toHaveBeenCalledWith('i1', u);
  });

  it('delegates compactInstance + cleanupInstance', async () => {
    const engine = new LegacyContextEngine();
    await engine.compactInstance('i1');
    expect(hoisted.coordinator.compactInstance).toHaveBeenCalledWith('i1');
    engine.cleanupInstance('i1');
    expect(hoisted.coordinator.cleanupInstance).toHaveBeenCalledWith('i1');
  });

  it('getStatus reports the last seen usage + coordinator compacting state', () => {
    const engine = new LegacyContextEngine();
    expect(engine.getStatus('i1')).toEqual({ latestUsage: null, isCompacting: false });

    const u = usage(80);
    engine.onContextUpdate('i1', u);
    hoisted.coordinator.isCompacting.mockReturnValue(true);
    expect(engine.getStatus('i1')).toEqual({ latestUsage: u, isCompacting: true });
  });

  it('forgets usage after cleanup', () => {
    const engine = new LegacyContextEngine();
    engine.onContextUpdate('i1', usage(50));
    engine.cleanupInstance('i1');
    expect(engine.getStatus('i1').latestUsage).toBeNull();
  });
});

describe('SafeContextEngine (quarantine/fallback)', () => {
  function makeInner(overrides: Partial<ContextEngine> = {}): ContextEngine {
    return {
      onContextUpdate: vi.fn(),
      compactInstance: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(() => ({ latestUsage: null, isCompacting: false })),
      cleanupInstance: vi.fn(),
      ...overrides,
    };
  }

  it('delegates to the inner engine when healthy', () => {
    const inner = makeInner();
    const safe = new SafeContextEngine(inner);
    const u = usage(10);
    safe.onContextUpdate('i1', u);
    expect(inner.onContextUpdate).toHaveBeenCalledWith('i1', u);
    expect(safe.isQuarantined()).toBe(false);
  });

  it('quarantines after onContextUpdate throws, then no-ops (hot path stays alive)', () => {
    const inner = makeInner({
      onContextUpdate: vi.fn(() => {
        throw new Error('engine boom');
      }),
    });
    const safe = new SafeContextEngine(inner);

    // First call throws internally but does NOT propagate.
    expect(() => safe.onContextUpdate('i1', usage(90))).not.toThrow();
    expect(safe.isQuarantined()).toBe(true);

    // Subsequent calls are no-ops — inner is not invoked again.
    safe.onContextUpdate('i1', usage(95));
    expect(inner.onContextUpdate).toHaveBeenCalledTimes(1);
  });

  it('getStatus returns a safe default when the inner throws', () => {
    const inner = makeInner({
      getStatus: vi.fn(() => {
        throw new Error('status boom');
      }),
    });
    const safe = new SafeContextEngine(inner);
    expect(safe.getStatus('i1')).toEqual({ latestUsage: null, isCompacting: false });
  });

  it('cleanupInstance swallows inner errors', () => {
    const inner = makeInner({
      cleanupInstance: vi.fn(() => {
        throw new Error('cleanup boom');
      }),
    });
    const safe = new SafeContextEngine(inner);
    expect(() => safe.cleanupInstance('i1')).not.toThrow();
  });

  it('compactInstance lets errors propagate (manual/IPC path)', async () => {
    const inner = makeInner({
      compactInstance: vi.fn(async () => {
        throw new Error('compact boom');
      }),
    });
    const safe = new SafeContextEngine(inner);
    await expect(safe.compactInstance('i1')).rejects.toThrow('compact boom');
  });
});

describe('getContextEngine singleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetContextEngineForTesting();
  });

  it('returns a stable safe-wrapped engine that delegates to the coordinator', () => {
    const engine = getContextEngine();
    expect(getContextEngine()).toBe(engine); // stable
    engine.onContextUpdate('i1', usage(33));
    expect(hoisted.coordinator.onContextUpdate).toHaveBeenCalledWith('i1', usage(33));
  });

  it('setContextEngine installs an alternative (still safe-wrapped)', () => {
    const inner = {
      onContextUpdate: vi.fn(),
      compactInstance: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(() => ({ latestUsage: null, isCompacting: false })),
      cleanupInstance: vi.fn(),
    };
    setContextEngine(inner);
    getContextEngine().onContextUpdate('i1', usage(20));
    expect(inner.onContextUpdate).toHaveBeenCalledWith('i1', usage(20));
    expect(hoisted.coordinator.onContextUpdate).not.toHaveBeenCalled();
  });
});
