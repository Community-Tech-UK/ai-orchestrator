import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

const mocks = vi.hoisted(() => {
  const memoryStats = {
    totalEntries: 0,
    totalTokens: 0,
    avgRelevanceScore: 0,
    operationCounts: { ADD: 0, UPDATE: 0, DELETE: 0, NOOP: 0 },
    recentRetrievals: 0,
    cacheHitRate: 0,
  };

  return {
    memory: {
      decideOperation: vi.fn(),
      executeOperation: vi.fn(),
      addEntry: vi.fn(),
      deleteEntry: vi.fn(),
      getEntry: vi.fn(),
      retrieve: vi.fn(async () => []),
      recordTaskOutcome: vi.fn(),
      getStats: vi.fn(() => memoryStats),
      save: vi.fn(),
      load: vi.fn(),
      configure: vi.fn(),
    },
    unified: {
      processInput: vi.fn(),
      retrieve: vi.fn(),
      recordSessionEnd: vi.fn(),
      recordWorkflow: vi.fn(),
      recordStrategy: vi.fn(),
      recordTaskOutcome: vi.fn(),
      getStats: vi.fn(),
      getSessionHistory: vi.fn(() => []),
      getPatterns: vi.fn(() => []),
      getWorkflows: vi.fn(() => []),
      save: vi.fn(),
      load: vi.fn(),
      configure: vi.fn(),
    },
    debate: {
      startDebate: vi.fn(),
      getResult: vi.fn(),
      getActiveDebates: vi.fn(() => []),
      cancelDebate: vi.fn(),
      getStats: vi.fn(),
      pauseDebate: vi.fn(),
      resumeDebate: vi.fn(),
      intervene: vi.fn(),
    },
    eventStore: {
      initialize: vi.fn(),
      getDebateResult: vi.fn(),
      getActiveDebates: vi.fn(() => []),
    },
    memoryStats,
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
  },
}));

vi.mock('../../shared/constants/feature-flags', () => ({
  isFeatureEnabled: vi.fn(() => false),
}));

vi.mock('../memory/r1-memory-manager', () => ({
  getMemoryManager: () => mocks.memory,
}));

vi.mock('../memory/unified-controller', () => ({
  getUnifiedMemory: () => mocks.unified,
}));

vi.mock('../orchestration/debate-coordinator', () => ({
  getDebateCoordinator: () => mocks.debate,
}));

vi.mock('../orchestration/event-store/orchestration-event-store', () => ({
  OrchestrationEventStore: {
    getInstance: vi.fn(() => mocks.eventStore),
  },
}));

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: vi.fn(() => ({ getRawDb: vi.fn() })),
}));

import { registerMemoryHandlers } from './memory-ipc-handler';

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

type RegisteredHandler = (...args: unknown[]) => unknown;

function handlerFor(channel: string): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }
  return call[1] as RegisteredHandler;
}

describe('registerMemoryHandlers', () => {
  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    vi.clearAllMocks();
    registerMemoryHandlers();
  });

  it('returns IpcResponse envelopes for default Memory Browser startup calls', async () => {
    const retrieve = await handlerFor(IPC_CHANNELS.MEMORY_R1_RETRIEVE)(fakeEvent, {
      query: 'recent context',
      taskId: 'memory-1',
    });
    const stats = handlerFor(IPC_CHANNELS.MEMORY_R1_GET_STATS)(fakeEvent);
    const patterns = handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS)(fakeEvent, 0.5);
    const sessions = handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS)(fakeEvent, 20);
    const workflows = handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS)(fakeEvent);

    expect(retrieve).toEqual({ success: true, data: [] });
    expect(stats).toEqual({ success: true, data: mocks.memoryStats });
    expect(patterns).toEqual({ success: true, data: [] });
    expect(sessions).toEqual({ success: true, data: [] });
    expect(workflows).toEqual({ success: true, data: [] });

    expect(mocks.memory.retrieve).toHaveBeenCalledWith('recent context', 'memory-1');
    expect(mocks.unified.getPatterns).toHaveBeenCalledWith(0.5);
    expect(mocks.unified.getSessionHistory).toHaveBeenCalledWith(20);
  });
});
