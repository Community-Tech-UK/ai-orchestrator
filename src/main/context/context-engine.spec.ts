import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContextUsage, Instance, OutputMessage } from '../../shared/types/instance.types';
import type { InstanceContextPort } from '../instance/instance-context-port';

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

const instance = (overrides: Partial<Instance> = {}): Instance =>
  ({
    id: 'i1',
    sessionId: 's1',
    workingDirectory: '/repo',
    displayName: 'Instance 1',
    contextUsage: usage(12),
    outputBuffer: [],
    ...overrides,
  }) as Instance;

const message = (content = 'hello world'): OutputMessage =>
  ({
    id: 'm1',
    type: 'assistant',
    content,
    timestamp: 123,
  }) as OutputMessage;

function makeContextPort(overrides: Partial<InstanceContextPort> = {}): InstanceContextPort {
  return {
    initializeRlm: vi.fn(async () => undefined),
    endRlmSession: vi.fn(),
    ingestInitialOutputToRlm: vi.fn(async () => undefined),
    ingestToRLM: vi.fn(),
    ingestToUnifiedMemory: vi.fn(),
    calculateContextBudget: vi.fn(() => ({
      totalTokens: 300,
      rlmMaxTokens: 200,
      unifiedMaxTokens: 100,
      rlmTopK: 3,
    })),
    buildRlmContext: vi.fn(async () => ({
      context: 'rlm',
      tokens: 10,
      sectionsAccessed: ['sec-1'],
      durationMs: 5,
      source: 'semantic',
    })),
    buildUnifiedMemoryContext: vi.fn(async () => ({
      context: 'memory',
      tokens: 8,
      longTermCount: 1,
      proceduralCount: 0,
      durationMs: 4,
    })),
    buildObservationContext: vi.fn(async () => null),
    buildWakeContextText: vi.fn(async () => null),
    buildMcpRuntimeToolContextSelection: vi.fn(async () => null),
    formatRlmContextBlock: vi.fn(() => null),
    formatUnifiedMemoryContextBlock: vi.fn(() => null),
    compactContext: vi.fn(async () => undefined),
    ...overrides,
  };
}

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
    expect(engine.getStatus('i1')).toEqual({ latestUsage: null, isCompacting: false, lastTurnStatus: null });

    const u = usage(80);
    engine.onContextUpdate('i1', u);
    hoisted.coordinator.isCompacting.mockReturnValue(true);
    expect(engine.getStatus('i1')).toEqual({ latestUsage: u, isCompacting: true, lastTurnStatus: null });
  });

  it('forgets usage after cleanup', () => {
    const engine = new LegacyContextEngine();
    engine.onContextUpdate('i1', usage(50));
    engine.cleanupInstance('i1');
    expect(engine.getStatus('i1').latestUsage).toBeNull();
  });

  it('ingests output through the supplied context port', () => {
    const engine = new LegacyContextEngine();
    const port = makeContextPort();
    const inst = instance();
    const msg = message();

    engine.ingest({ instance: inst, message: msg, contextPort: port });

    expect(port.ingestToRLM).toHaveBeenCalledWith('i1', msg);
    expect(port.ingestToUnifiedMemory).toHaveBeenCalledWith(inst, msg);
  });

  it('assembles input context through the supplied context port and indexed-context hook', async () => {
    const engine = new LegacyContextEngine();
    const port = makeContextPort();
    const inst = instance();
    const indexedCodebaseContext = {
      context: 'indexed',
      tokens: 12,
      results: [],
      storeId: 'store-1',
      durationMs: 6,
    };

    const result = await engine.assemble({
      instance: inst,
      message: 'what changed?',
      taskId: 'task-1',
      contextPort: port,
      buildIndexedCodebaseContext: vi.fn(async () => indexedCodebaseContext),
    });

    expect(port.calculateContextBudget).toHaveBeenCalledWith(inst, 'what changed?');
    expect(port.buildRlmContext).toHaveBeenCalledWith('i1', 'what changed?', 200, 3);
    expect(port.buildUnifiedMemoryContext).toHaveBeenCalledWith(inst, 'what changed?', 'task-1', 100);
    expect(result.indexedCodebaseContext).toBe(indexedCodebaseContext);
  });

  it('afterTurn feeds the latest instance usage through the same context update path', () => {
    const engine = new LegacyContextEngine();
    const u = usage(64);

    engine.afterTurn({ instance: instance({ contextUsage: u }), status: 'idle' });

    expect(hoisted.coordinator.onContextUpdate).toHaveBeenCalledWith('i1', u);
  });
});

describe('SafeContextEngine (quarantine/fallback)', () => {
  function makeInner(overrides: Partial<ContextEngine> = {}): ContextEngine {
    return {
      onContextUpdate: vi.fn(),
      ingest: vi.fn(),
      assemble: vi.fn(async () => ({
        budget: { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 },
        rlmContext: null,
        unifiedMemoryContext: null,
        indexedCodebaseContext: null,
      })),
      afterTurn: vi.fn(),
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
    expect(safe.getStatus('i1')).toEqual({ latestUsage: null, isCompacting: false, lastTurnStatus: null });
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

  it('quarantines after assemble throws, then returns empty context fallback', async () => {
    const inner = makeInner({
      assemble: vi.fn(async () => {
        throw new Error('assemble boom');
      }),
    });
    const safe = new SafeContextEngine(inner);

    const result = await safe.assemble({
      instance: instance(),
      message: 'query',
      contextPort: makeContextPort(),
    });

    expect(result).toEqual({
      budget: { totalTokens: 300, rlmMaxTokens: 200, unifiedMaxTokens: 100, rlmTopK: 3 },
      rlmContext: null,
      unifiedMemoryContext: null,
      indexedCodebaseContext: null,
    });
    expect(safe.isQuarantined()).toBe(true);
  });

  it('uses a zero-budget fallback if budget calculation also fails after quarantine', async () => {
    const inner = makeInner({
      assemble: vi.fn(async () => {
        throw new Error('assemble boom');
      }),
    });
    const contextPort = makeContextPort({
      calculateContextBudget: vi.fn(() => {
        throw new Error('budget boom');
      }),
    });
    const safe = new SafeContextEngine(inner);

    const result = await safe.assemble({
      instance: instance(),
      message: 'query',
      contextPort,
    });

    expect(result).toEqual({
      budget: { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 },
      rlmContext: null,
      unifiedMemoryContext: null,
      indexedCodebaseContext: null,
    });
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
      ingest: vi.fn(),
      assemble: vi.fn(async () => ({
        budget: { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 },
        rlmContext: null,
        unifiedMemoryContext: null,
        indexedCodebaseContext: null,
      })),
      afterTurn: vi.fn(),
      compactInstance: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(() => ({ latestUsage: null, isCompacting: false })),
      cleanupInstance: vi.fn(),
    };
    setContextEngine(inner);
    getContextEngine().onContextUpdate('i1', usage(20));
    expect(inner.onContextUpdate).toHaveBeenCalledWith('i1', usage(20));
    expect(hoisted.coordinator.onContextUpdate).not.toHaveBeenCalled();
  });

  it('routes manual compactInstance through the active engine (a swap governs IPC compaction too)', async () => {
    // Guards the B3 boundary: the manual /compact + INSTANCE_COMPACT call sites
    // resolve compaction via getContextEngine().compactInstance(), so installing
    // an alternative engine governs manual compaction without touching call sites.
    const inner = {
      onContextUpdate: vi.fn(),
      ingest: vi.fn(),
      assemble: vi.fn(async () => ({
        budget: { totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 },
        rlmContext: null,
        unifiedMemoryContext: null,
        indexedCodebaseContext: null,
      })),
      afterTurn: vi.fn(),
      compactInstance: vi.fn(async () => ({ success: true })),
      getStatus: vi.fn(() => ({ latestUsage: null, isCompacting: false })),
      cleanupInstance: vi.fn(),
    };
    setContextEngine(inner);
    await getContextEngine().compactInstance('i1');
    expect(inner.compactInstance).toHaveBeenCalledWith('i1');
    expect(hoisted.coordinator.compactInstance).not.toHaveBeenCalled();
  });
});
