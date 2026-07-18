import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  getStats: vi.fn(() => ({
    totalOutcomes: 2,
    totalBatches: 1,
    avgReward: 0.75,
    avgAdvantage: 0.25,
    rewardTrend: [0.5, 1],
    strategyPerformance: new Map(),
  })),
  exportTrainingData: vi.fn(() => ({
    outcomes: [],
    batches: [],
    stats: {
      totalOutcomes: 0,
      totalBatches: 0,
      avgReward: 0,
      avgAdvantage: 0,
      rewardTrend: [],
      strategyPerformance: new Map(),
    },
  })),
  getTopStrategies: vi.fn((): unknown[] => []),
  getConfig: vi.fn(() => ({ groupSize: 8 })),
  configure: vi.fn(),
  getRewardTrend: vi.fn(() => ({ improving: true, slope: 0.1, recent: [0.5, 0.6] })),
  recordOutcome: vi.fn(),
  importTrainingData: vi.fn(),
  getAgentPerformance: vi.fn((): unknown[] => []),
  getPatterns: vi.fn((): unknown[] => []),
  getInsights: vi.fn((): unknown[] => []),
  applyInsight: vi.fn(),
  dismissInsight: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../learning/grpo-trainer', () => ({
  getGRPOTrainer: () => mocks,
}));

import { registerTrainingHandlers, TRAINING_IPC_CHANNELS } from './training-ipc-handler';

describe('training IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerTrainingHandlers();
  });

  it('registers all canonical and compatibility training channels', () => {
    const expected = new Set([
      ...Object.values(TRAINING_IPC_CHANNELS),
      IPC_CHANNELS.TRAINING_RECORD_OUTCOME,
      IPC_CHANNELS.TRAINING_IMPORT_DATA,
      IPC_CHANNELS.TRAINING_GET_TREND,
      IPC_CHANNELS.TRAINING_GET_TOP_STRATEGIES,
      IPC_CHANNELS.TRAINING_CONFIGURE,
      IPC_CHANNELS.TRAINING_GET_AGENT_PERFORMANCE,
      IPC_CHANNELS.TRAINING_GET_PATTERNS,
      IPC_CHANNELS.TRAINING_GET_INSIGHTS,
      IPC_CHANNELS.TRAINING_APPLY_INSIGHT,
      IPC_CHANNELS.TRAINING_DISMISS_INSIGHT,
    ]);

    expect(new Set(mocks.handlers.keys())).toEqual(expected);
    expect(expected.size).toBe(18);
  });

  it('returns structured training statistics', async () => {
    const result = await invoke(IPC_CHANNELS.TRAINING_GET_STATS);

    expect(result).toMatchObject({
      success: true,
      data: {
        totalOutcomes: 2,
        totalBatches: 1,
        averageReward: 0.75,
        averageAdvantage: 0.25,
        lastUpdated: expect.any(Number),
      },
    });
  });

  it('rejects invalid outcomes before writing training state', async () => {
    const result = await invoke(IPC_CHANNELS.TRAINING_RECORD_OUTCOME, {
      taskId: 'task-1',
      prompt: 'Prompt',
      response: 'Response',
      reward: 2,
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });

  it('validates typed configuration fields', async () => {
    await expect(invoke(IPC_CHANNELS.TRAINING_CONFIGURE, {
      groupSize: 4,
      learningRate: 0.01,
    })).resolves.toEqual({ success: true });
    expect(mocks.configure).toHaveBeenCalledWith({ groupSize: 4, learningRate: 0.01 });

    const invalid = await invoke(IPC_CHANNELS.TRAINING_CONFIGURE, { unknownSetting: true });
    expect(invalid).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
  });

  it('returns a structured failure when an insight cannot be applied', async () => {
    mocks.applyInsight.mockReturnValue(false);

    const result = await invoke(IPC_CHANNELS.TRAINING_APPLY_INSIGHT, {
      insightId: 'insight-1',
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'TRAINING_APPLY_INSIGHT_FAILED',
        message: 'Training insight not found',
        timestamp: expect.any(Number),
      },
    });
  });

  it('rejects an untrusted sender before reading training state', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerTrainingHandlers({ ensureTrustedSender });

    await expect(invoke(IPC_CHANNELS.TRAINING_GET_STATS)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.TRAINING_GET_STATS);
    expect(mocks.getStats).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
