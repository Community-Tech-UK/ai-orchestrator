import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { InstanceManager } from '../../../instance/instance-manager';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  applyCompaction: vi.fn(),
  previewCompaction: vi.fn(),
  recoverCompactionContext: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../../app/compaction-runtime', () => ({
  applyCompaction: mocks.applyCompaction,
}));

vi.mock('../../../context/compaction-preview', () => ({
  previewCompaction: mocks.previewCompaction,
}));

vi.mock('../../../app/compaction-recovery', () => ({
  recoverCompactionContext: mocks.recoverCompactionContext,
}));

import { IPC_CHANNELS } from '@contracts/channels';
import { registerInstanceCompactionHandlers } from '../instance-compaction-handlers';

describe('registerInstanceCompactionHandlers', () => {
  const instanceManager = {} as InstanceManager;

  beforeEach(() => {
    mocks.handlers.clear();
    mocks.applyCompaction.mockReset();
    mocks.previewCompaction.mockReset();
    mocks.recoverCompactionContext.mockReset();
    registerInstanceCompactionHandlers(instanceManager);
  });

  describe(IPC_CHANNELS.INSTANCE_COMPACT, () => {
    it('routes the plain Compact Now button through applyCompaction with no boundary', async () => {
      mocks.applyCompaction.mockResolvedValue({ success: true, method: 'native', blocking: true });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACT)!;

      const response = await handler({}, { instanceId: 'inst-1' });

      expect(mocks.applyCompaction).toHaveBeenCalledWith(instanceManager, 'inst-1');
      expect(response).toEqual({ success: true, data: { success: true, method: 'native', blocking: true } });
    });

    it('rejects an invalid payload without calling applyCompaction', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACT)!;
      const response = await handler({}, {});
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('COMPACT_FAILED');
      expect(mocks.applyCompaction).not.toHaveBeenCalled();
    });
  });

  describe(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW, () => {
    it('validates and forwards keepLatestExchanges to previewCompaction', async () => {
      mocks.previewCompaction.mockResolvedValue({ mode: 'aio-managed' });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;

      const response = await handler({}, { instanceId: 'inst-1', keepLatestExchanges: 3 });

      expect(mocks.previewCompaction).toHaveBeenCalledWith(instanceManager, 'inst-1', { keepLatestExchanges: 3 });
      expect(response).toEqual({ success: true, data: { mode: 'aio-managed' } });
    });

    it('omits keepLatestExchanges when the caller does not supply one', async () => {
      mocks.previewCompaction.mockResolvedValue({ mode: 'aio-managed' });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;

      await handler({}, { instanceId: 'inst-1' });

      expect(mocks.previewCompaction).toHaveBeenCalledWith(instanceManager, 'inst-1', { keepLatestExchanges: undefined });
    });

    it('rejects a negative keepLatestExchanges', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;
      const response = await handler({}, { instanceId: 'inst-1', keepLatestExchanges: -1 });
      expect(response.success).toBe(false);
      expect(response.error?.code).toBe('COMPACTION_PREVIEW_FAILED');
      expect(mocks.previewCompaction).not.toHaveBeenCalled();
    });

    it('rejects a keepLatestExchanges above the sane bound', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;
      const response = await handler({}, { instanceId: 'inst-1', keepLatestExchanges: 100_000 });
      expect(response.success).toBe(false);
      expect(mocks.previewCompaction).not.toHaveBeenCalled();
    });

    it('rejects a missing instanceId', async () => {
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;
      const response = await handler({}, { keepLatestExchanges: 2 });
      expect(response.success).toBe(false);
      expect(mocks.previewCompaction).not.toHaveBeenCalled();
    });

    it('surfaces a previewCompaction failure as a structured error response', async () => {
      mocks.previewCompaction.mockRejectedValue(new Error('boom'));
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_PREVIEW)!;
      const response = await handler({}, { instanceId: 'inst-1' });
      expect(response).toEqual({
        success: false,
        error: { code: 'COMPACTION_PREVIEW_FAILED', message: 'boom', timestamp: expect.any(Number) },
      });
    });
  });

  describe(IPC_CHANNELS.INSTANCE_COMPACTION_APPLY, () => {
    it('validates and forwards keepLatestExchanges to applyCompaction', async () => {
      mocks.applyCompaction.mockResolvedValue({ success: true, method: 'restart-with-summary', blocking: true });
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_APPLY)!;

      const response = await handler({}, { instanceId: 'inst-1', keepLatestExchanges: 2 });

      expect(mocks.applyCompaction).toHaveBeenCalledWith(instanceManager, 'inst-1', { keepLatestExchanges: 2 });
      expect(response.success).toBe(true);
    });

    it('surfaces an applyCompaction failure as a structured error response', async () => {
      mocks.applyCompaction.mockRejectedValue(new Error('apply boom'));
      const handler = mocks.handlers.get(IPC_CHANNELS.INSTANCE_COMPACTION_APPLY)!;
      const response = await handler({}, { instanceId: 'inst-1' });
      expect(response).toEqual({
        success: false,
        error: { code: 'COMPACTION_APPLY_FAILED', message: 'apply boom', timestamp: expect.any(Number) },
      });
    });
  });
});
