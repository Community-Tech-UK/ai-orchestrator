import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS, type IpcResponse } from '../../../../shared/types/ipc.types';
import type { CouncilRun } from '@contracts/schemas/command';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  compareService: {
    listAvailableProviders: vi.fn(),
    compare: vi.fn(),
  },
  councilRuns: {
    startRun: vi.fn(),
    cancelRun: vi.fn(),
    synthesizeRun: vi.fn(),
    getRun: vi.fn(),
    listeners: new Map<string, (run: CouncilRun) => void>(),
    on: vi.fn((event: string, cb: (run: CouncilRun) => void) => {
      mocks.councilRuns.listeners.set(event, cb);
    }),
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../compare/multi-provider-compare-service', () => ({
  getMultiProviderCompareService: () => mocks.compareService,
}));

vi.mock('../../../compare/council-run-service', () => ({
  getCouncilRunService: () => mocks.councilRuns,
}));

import { registerCompareHandlers } from '../compare-handlers';

function makeRun(overrides: Partial<CouncilRun> = {}): CouncilRun {
  return {
    id: 'council-1',
    prompt: 'hi',
    createdAt: 1,
    members: [{ provider: 'claude', status: 'succeeded', answer: 'hello' }],
    cancelled: false,
    ...overrides,
  };
}

describe('compare-handlers (WS-B6)', () => {
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.councilRuns.listeners.clear();
    sendToRenderer = vi.fn();
    registerCompareHandlers({ windowManager: { sendToRenderer } as never });
  });

  it('registers all WS-B6 channels plus the legacy compare channels', () => {
    expect([...mocks.handlers.keys()]).toEqual(
      expect.arrayContaining([
        IPC_CHANNELS.COMPARE_LIST_PROVIDERS,
        IPC_CHANNELS.COMPARE_RUN,
        IPC_CHANNELS.COMPARE_START,
        IPC_CHANNELS.COMPARE_CANCEL,
        IPC_CHANNELS.COMPARE_SYNTHESIZE,
        IPC_CHANNELS.COMPARE_GET_RUN,
      ]),
    );
  });

  it('bridges CouncilRunService run-updated events to the renderer via COMPARE_RUN_UPDATED', () => {
    const run = makeRun();
    mocks.councilRuns.listeners.get('run-updated')?.(run);
    expect(sendToRenderer).toHaveBeenCalledWith(IPC_CHANNELS.COMPARE_RUN_UPDATED, run);
  });

  it('COMPARE_START validates the payload and starts a progressive run', async () => {
    const run = makeRun();
    mocks.councilRuns.startRun.mockReturnValue(run);
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_START)!;

    const response = await handler({}, { prompt: 'hi', providers: ['claude'] });

    expect(mocks.councilRuns.startRun).toHaveBeenCalledWith('hi', ['claude'], { workingDirectory: undefined });
    expect(response).toEqual({ success: true, data: run });
  });

  it('COMPARE_START rejects an invalid payload without touching the service', async () => {
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_START)!;
    const response = await handler({}, { prompt: '', providers: [] });
    expect(response.success).toBe(false);
    expect(mocks.councilRuns.startRun).not.toHaveBeenCalled();
  });

  it('COMPARE_CANCEL cancels the given run', async () => {
    const run = makeRun({ cancelled: true });
    mocks.councilRuns.cancelRun.mockReturnValue(run);
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_CANCEL)!;

    const response = await handler({}, { runId: 'council-1' });

    expect(mocks.councilRuns.cancelRun).toHaveBeenCalledWith('council-1');
    expect(response).toEqual({ success: true, data: run });
  });

  it('COMPARE_SYNTHESIZE routes the method through to synthesizeRun', async () => {
    const run = makeRun({ synthesis: { method: 'consensus', text: 'x', attribution: [], generatedAt: 1 } });
    mocks.councilRuns.synthesizeRun.mockResolvedValue(run);
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_SYNTHESIZE)!;

    const response = await handler({}, { runId: 'council-1', method: 'consensus' });

    expect(mocks.councilRuns.synthesizeRun).toHaveBeenCalledWith('council-1', 'consensus');
    expect(response).toEqual({ success: true, data: run });
  });

  it('COMPARE_SYNTHESIZE returns a structured failure when the service throws', async () => {
    mocks.councilRuns.synthesizeRun.mockRejectedValue(new Error('needs at least 2'));
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_SYNTHESIZE)!;

    const response = await handler({}, { runId: 'council-1', method: 'debate' });

    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('needs at least 2');
  });

  it('COMPARE_GET_RUN with no runId asks the service for the latest run', async () => {
    const run = makeRun();
    mocks.councilRuns.getRun.mockReturnValue(run);
    const handler = mocks.handlers.get(IPC_CHANNELS.COMPARE_GET_RUN)!;

    const response = await handler({}, { runId: undefined });

    expect(mocks.councilRuns.getRun).toHaveBeenCalledWith(undefined);
    expect(response).toEqual({ success: true, data: run });
  });
});
