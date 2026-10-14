import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../../shared/types/ipc.types';
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<IpcResponse>>();
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: never) => handlers.set(channel, handler) }, app: { getPath: () => '/fixture' } }));
vi.mock('../../storage/storage-runtime', () => ({ createStorageRuntime: vi.fn() }));
import { registerStorageHandlers } from './storage-handlers';
import { StorageRunCleanupRequestSchema } from '@contracts/schemas/storage';
describe('storage IPC', () => {
  const runtime = { usage: { getUsage: vi.fn(async () => ({ rows: [] })), invalidate: vi.fn() }, cleanup: { preview: vi.fn(async () => ({})), run: vi.fn(async () => { throw new Error('Review first'); }) } };
  beforeEach(() => { handlers.clear(); vi.clearAllMocks(); registerStorageHandlers({ runtime: runtime as never }); });
  it('registers all channels and rejects missing or unexpected run fields', async () => {
    expect(handlers.size).toBe(3);
    expect(StorageRunCleanupRequestSchema.safeParse({ target: 'rlm-backups' }).success).toBe(false);
    expect(StorageRunCleanupRequestSchema.safeParse({ target: 'rlm-backups', previewId: 'fixture', directory: '/escape' }).success).toBe(false);
    const response = await handlers.get(IPC_CHANNELS.STORAGE_RUN_CLEANUP)!({}, { target: 'rlm-backups' });
    expect(response.success).toBe(false);
    expect(runtime.cleanup.run).not.toHaveBeenCalled();
  });
  it('preserves service preview enforcement through the handler', async () => {
    const response = await handlers.get(IPC_CHANNELS.STORAGE_RUN_CLEANUP)!({}, { target: 'rlm-backups', previewId: 'unknown' });
    expect(response.success).toBe(false);
    expect(response.error?.message).toContain('Review first');
  });
});
