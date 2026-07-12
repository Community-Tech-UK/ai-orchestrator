import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';

type Handler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
  },
}));

class FakeService extends EventEmitter {
  getHealth = vi.fn(() => ({ level: 'warning', databaseSizeBytes: 10 }));
  preview = vi.fn((request) => ({ request, eligibleStoreCount: 2 }));
  run = vi.fn(async (request) => ({ status: 'success', request }));
  getStatus = vi.fn(() => null);
}

describe('registerRlmMaintenanceHandlers', () => {
  let service: FakeService;
  let sendToRenderer: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    handlers.clear();
    vi.clearAllMocks();
    service = new FakeService();
    sendToRenderer = vi.fn();
    const { registerRlmMaintenanceHandlers } = await import('./rlm-maintenance-handlers');
    registerRlmMaintenanceHandlers({
      service: service as never,
      windowManager: { sendToRenderer } as never,
    });
  });

  it('registers health, preview, run, and status handlers', () => {
    expect([...handlers.keys()]).toEqual(expect.arrayContaining([
      IPC_CHANNELS.RLM_STORAGE_GET_HEALTH,
      IPC_CHANNELS.RLM_STORAGE_PREVIEW_MAINTENANCE,
      IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE,
      IPC_CHANNELS.RLM_STORAGE_GET_MAINTENANCE_STATUS,
    ]));
  });

  it('validates loop IDs and rejects renderer-controlled retention', async () => {
    const invalid = await invoke(IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE, {
      loopRunId: '',
      retentionDays: 1,
    });
    expect(invalid.success).toBe(false);
    expect(service.run).not.toHaveBeenCalled();

    const valid = await invoke(IPC_CHANNELS.RLM_STORAGE_RUN_MAINTENANCE, {
      loopRunId: 'loop-1',
    });
    expect(valid.success).toBe(true);
    expect(service.run).toHaveBeenCalledWith({ loopRunId: 'loop-1' });
  });

  it('forwards typed progress and does not expose a stack trace on errors', async () => {
    const progress = { operationId: 'op-1', stage: 'pruning' };
    service.emit('progress', progress);
    expect(sendToRenderer).toHaveBeenCalledWith(
      IPC_CHANNELS.RLM_STORAGE_MAINTENANCE_PROGRESS,
      progress,
    );

    service.preview.mockImplementationOnce(() => {
      const error = new Error('preview failed');
      error.stack = 'secret stack';
      throw error;
    });
    const response = await invoke(IPC_CHANNELS.RLM_STORAGE_PREVIEW_MAINTENANCE, {});
    expect(response.error?.message).toBe('preview failed');
    expect(JSON.stringify(response)).not.toContain('secret stack');
  });
});

async function invoke(channel: string, payload: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing handler ${channel}`);
  return handler({}, payload);
}
