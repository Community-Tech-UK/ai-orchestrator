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
      getActiveDebates: vi.fn((): unknown[] => []),
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
    const stats = await handlerFor(IPC_CHANNELS.MEMORY_R1_GET_STATS)(fakeEvent);
    const patterns = await handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_PATTERNS)(fakeEvent, 0.5);
    const sessions = await handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_SESSIONS)(fakeEvent, 20);
    const workflows = await handlerFor(IPC_CHANNELS.UNIFIED_MEMORY_GET_WORKFLOWS)(fakeEvent);

    expect(retrieve).toEqual({ success: true, data: [] });
    expect(stats).toEqual({ success: true, data: mocks.memoryStats });
    expect(patterns).toEqual({ success: true, data: [] });
    expect(sessions).toEqual({ success: true, data: [] });
    expect(workflows).toEqual({ success: true, data: [] });

    expect(mocks.memory.retrieve).toHaveBeenCalledWith('recent context', 'memory-1');
    expect(mocks.unified.getPatterns).toHaveBeenCalledWith(0.5);
    expect(mocks.unified.getSessionHistory).toHaveBeenCalledWith(20);
  });

  it('returns a structured validation error instead of rejecting invalid memory input', async () => {
    await expect(handlerFor(IPC_CHANNELS.MEMORY_R1_RETRIEVE)(fakeEvent, {
      query: '',
      taskId: 'memory-1',
    })).resolves.toMatchObject({
      success: false,
      error: expect.objectContaining({
        code: 'VALIDATION_FAILED',
        timestamp: expect.any(Number),
      }),
    });
    expect(mocks.memory.retrieve).not.toHaveBeenCalled();
  });

  it('returns a stable structured error when a memory operation fails', async () => {
    mocks.memory.retrieve.mockRejectedValue(new Error('memory index unavailable'));

    await expect(handlerFor(IPC_CHANNELS.MEMORY_R1_RETRIEVE)(fakeEvent, {
      query: 'recent context',
      taskId: 'memory-1',
    })).resolves.toMatchObject({
      success: false,
      error: {
        code: 'MEMORY_R1_RETRIEVE_FAILED',
        message: 'memory index unavailable',
        timestamp: expect.any(Number),
      },
    });
  });

  it('rejects an untrusted sender before reading memory state', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const trustError = {
      success: false,
      error: {
        code: 'IPC_TRUST_FAILED',
        message: 'Untrusted sender',
        timestamp: 123,
      },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerMemoryHandlers({ ensureTrustedSender });

    const result = await handlerFor(IPC_CHANNELS.MEMORY_R1_GET_STATS)(fakeEvent);

    expect(result).toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(fakeEvent, IPC_CHANNELS.MEMORY_R1_GET_STATS);
    expect(mocks.memory.getStats).not.toHaveBeenCalled();
  });

  it('returns IpcResponse envelopes for the Debate page startup and control calls', async () => {
    mocks.debate.startDebate.mockResolvedValue('debate-1');
    mocks.debate.getActiveDebates.mockReturnValue([{ id: 'debate-1' }]);
    mocks.debate.getStats.mockReturnValue({ active: 1 });
    mocks.debate.cancelDebate.mockResolvedValue(true);

    const start = await handlerFor(IPC_CHANNELS.DEBATE_START)(fakeEvent, {
      query: 'Which approach is safer?',
    });
    const active = await handlerFor(IPC_CHANNELS.DEBATE_GET_ACTIVE)(fakeEvent);
    const stats = await handlerFor(IPC_CHANNELS.DEBATE_GET_STATS)(fakeEvent);
    const cancel = await handlerFor(IPC_CHANNELS.DEBATE_CANCEL)(fakeEvent, 'debate-1');

    expect(start).toEqual({ success: true, data: 'debate-1' });
    expect(active).toEqual({ success: true, data: [{ id: 'debate-1' }] });
    expect(stats).toEqual({ success: true, data: { active: 1 } });
    expect(cancel).toEqual({ success: true, data: true });
  });

  it('returns a structured validation error instead of rejecting an invalid debate start', async () => {
    await expect(handlerFor(IPC_CHANNELS.DEBATE_START)(fakeEvent, {
      query: '',
    })).resolves.toMatchObject({
      success: false,
      error: expect.objectContaining({
        code: 'VALIDATION_FAILED',
        timestamp: expect.any(Number),
      }),
    });
    expect(mocks.debate.startDebate).not.toHaveBeenCalled();
  });

  it('rejects unexpected fields on debate control payloads', async () => {
    const result = await handlerFor(IPC_CHANNELS.DEBATE_PAUSE)(fakeEvent, {
      sessionId: 'debate-1',
      unexpected: true,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
    expect(mocks.debate.pauseDebate).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before invoking the debate coordinator', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const trustError = {
      success: false,
      error: {
        code: 'IPC_TRUST_FAILED',
        message: 'Untrusted sender',
        timestamp: 123,
      },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerMemoryHandlers({ ensureTrustedSender });

    const result = await handlerFor(IPC_CHANNELS.DEBATE_START)(fakeEvent, {
      query: 'Should never run',
    });

    expect(result).toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(fakeEvent, IPC_CHANNELS.DEBATE_START);
    expect(mocks.debate.startDebate).not.toHaveBeenCalled();
  });
});
