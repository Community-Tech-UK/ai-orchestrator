import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  getStatus: vi.fn(() => ({ enabled: true })),
  getReviewHistory: vi.fn((): unknown[] => []),
  getReviewContext: vi.fn(),
  startDebate: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../orchestration/cross-model-review-service', () => ({
  getCrossModelReviewService: () => ({
    getStatus: mocks.getStatus,
    getReviewHistory: mocks.getReviewHistory,
    getReviewContext: mocks.getReviewContext,
  }),
}));

vi.mock('../orchestration/debate-coordinator', () => ({
  getDebateCoordinator: () => ({ startDebate: mocks.startDebate }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), warn: vi.fn() }),
}));

import { registerCrossModelReviewIpcHandlers } from './cross-model-review-ipc';

describe('cross-model review IPC handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    registerCrossModelReviewIpcHandlers();
  });

  it('returns review status in a structured response', async () => {
    await expect(invoke(IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS)).resolves.toEqual({
      success: true,
      data: { enabled: true },
    });
  });

  it('wraps review actions in a structured response', async () => {
    await expect(invoke(IPC_CHANNELS.CROSS_MODEL_REVIEW_ACTION, {
      reviewId: 'review-1',
      instanceId: 'instance-1',
      action: 'ask-primary',
    })).resolves.toEqual({
      success: true,
      data: { action: 'ask-primary', concerns: [] },
    });
  });

  it('returns structured validation failures', async () => {
    const result = await invoke(IPC_CHANNELS.CROSS_MODEL_REVIEW_DISMISS, {
      reviewId: '',
      instanceId: 'instance-1',
    });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
  });

  it('rejects untrusted senders before reading review state', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerCrossModelReviewIpcHandlers({ ensureTrustedSender });

    await expect(invoke(IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(
      {},
      IPC_CHANNELS.CROSS_MODEL_REVIEW_STATUS,
    );
    expect(mocks.getStatus).not.toHaveBeenCalled();
  });
});

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}
