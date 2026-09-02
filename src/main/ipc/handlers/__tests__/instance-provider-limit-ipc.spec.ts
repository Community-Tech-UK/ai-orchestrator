import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { LoopState } from '../../../../shared/types/loop.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  instanceResumeNow: vi.fn(),
  instanceCancel: vi.fn(),
  getActiveLoops: vi.fn(),
  resumeLoop: vi.fn(),
  cancelProviderLimitResume: vi.fn(),
  getLoopCoordinator: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../instance/instance-provider-limit-handler', () => ({
  getInstanceProviderLimitHandler: () => ({
    resumeNow: mocks.instanceResumeNow,
    cancel: mocks.instanceCancel,
  }),
}));

vi.mock('../../../instance/instance-auth-repair-handler', () => ({
  getInstanceAuthRepairHandler: () => ({ retryNow: vi.fn(), cancel: vi.fn() }),
}));

vi.mock('../../../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: mocks.getLoopCoordinator,
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerInstanceProviderLimitHandlers } from '../instance-provider-limit-ipc';

function loop(overrides: Partial<LoopState>): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'provider-limit',
    ...overrides,
  } as unknown as LoopState;
}

async function resumeNow(instanceId: string): Promise<IpcResponse> {
  const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_RESUME_NOW)!;
  return handler({}, { instanceId });
}

describe('INSTANCE_PROVIDER_LIMIT_RESUME_NOW', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.instanceResumeNow.mockReset().mockReturnValue(false);
    mocks.getActiveLoops.mockReset().mockReturnValue([]);
    mocks.resumeLoop.mockReset().mockReturnValue(true);
    mocks.cancelProviderLimitResume.mockReset().mockReturnValue(true);
    mocks.instanceCancel.mockReset().mockReturnValue(false);
    mocks.getLoopCoordinator.mockReset().mockReturnValue({
      getActiveLoops: mocks.getActiveLoops,
      resumeLoop: mocks.resumeLoop,
      cancelProviderLimitResume: mocks.cancelProviderLimitResume,
    });
    registerInstanceProviderLimitHandlers({});
  });

  // Regression: a loop park paints its quota-park banner onto the loop's chat
  // instance, but Resume only ever called the instance handler — which had no
  // park registered for that instance and nothing to re-send. The button was a
  // guaranteed no-op for every loop park.
  it('resumes the loop that owns the chat instead of the instance', async () => {
    mocks.getActiveLoops.mockReturnValue([loop({ id: 'loop-9', chatId: 'chat-1' })]);

    const res = await resumeNow('chat-1');

    expect(mocks.resumeLoop).toHaveBeenCalledWith('loop-9');
    expect(mocks.instanceResumeNow).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, data: { resumed: true, resumedLoop: true } });
  });

  it('ignores loops for other chats and loops that are not parked', async () => {
    mocks.getActiveLoops.mockReturnValue([
      loop({ id: 'other-chat', chatId: 'chat-2' }),
      loop({ id: 'running', chatId: 'chat-1', status: 'running' }),
    ]);
    mocks.instanceResumeNow.mockReturnValue(true);

    const res = await resumeNow('chat-1');

    expect(mocks.resumeLoop).not.toHaveBeenCalled();
    expect(mocks.instanceResumeNow).toHaveBeenCalledWith('chat-1');
    expect(res).toEqual({ success: true, data: { resumed: true, resumedLoop: false } });
  });

  it('falls back to the instance handler when no loop runtime exists', async () => {
    mocks.getLoopCoordinator.mockImplementation(() => {
      throw new Error('no loop runtime in this process');
    });
    mocks.instanceResumeNow.mockReturnValue(true);

    const res = await resumeNow('chat-1');

    expect(mocks.instanceResumeNow).toHaveBeenCalledWith('chat-1');
    expect(res).toEqual({ success: true, data: { resumed: true, resumedLoop: false } });
  });

  it('reports a failed resume rather than throwing', async () => {
    const res = await resumeNow('chat-1');
    expect(res).toEqual({ success: true, data: { resumed: false, resumedLoop: false } });
  });
});

async function cancel(instanceId: string): Promise<IpcResponse> {
  const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_PROVIDER_LIMIT_CANCEL)!;
  return handler({}, { instanceId });
}

describe('INSTANCE_PROVIDER_LIMIT_CANCEL', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.instanceResumeNow.mockReset().mockReturnValue(false);
    mocks.instanceCancel.mockReset().mockReturnValue(false);
    mocks.getActiveLoops.mockReset().mockReturnValue([]);
    mocks.resumeLoop.mockReset().mockReturnValue(true);
    mocks.cancelProviderLimitResume.mockReset().mockReturnValue(true);
    mocks.getLoopCoordinator.mockReset().mockReturnValue({
      getActiveLoops: mocks.getActiveLoops,
      resumeLoop: mocks.resumeLoop,
      cancelProviderLimitResume: mocks.cancelProviderLimitResume,
    });
    registerInstanceProviderLimitHandlers({});
  });

  // Regression: the instance handler clears the waitReason unconditionally, so
  // dismissing a loop-owned banner hid the countdown while the loop stayed
  // parked with its auto-resume armed — it would later spawn an iteration with
  // nothing on screen warning the user it was still parked.
  it('disarms the loop auto-resume as well as clearing the banner', async () => {
    mocks.getActiveLoops.mockReturnValue([loop({ id: 'loop-9', chatId: 'chat-1' })]);

    const res = await cancel('chat-1');

    expect(mocks.cancelProviderLimitResume).toHaveBeenCalledWith('loop-9');
    // The instance handler still runs: it is what clears the waitReason/banner.
    expect(mocks.instanceCancel).toHaveBeenCalledWith('chat-1');
    expect(res).toEqual({ success: true, data: { cancelled: true, cancelledLoop: true } });
  });

  it('leaves the instance-only path unchanged when no loop owns the chat', async () => {
    mocks.instanceCancel.mockReturnValue(true);

    const res = await cancel('chat-1');

    expect(mocks.cancelProviderLimitResume).not.toHaveBeenCalled();
    expect(res).toEqual({ success: true, data: { cancelled: true, cancelledLoop: false } });
  });
});
