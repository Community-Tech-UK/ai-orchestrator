import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
import { HistoryManager } from './history-manager';

describe('history index write recovery', () => {
  it('reports a failed write without poisoning the queue for an explicit retry', async () => {
    const manager = Object.create(HistoryManager.prototype) as {
      saveQueue: Promise<void>; saveIndex: () => Promise<void>; doSaveIndex: ReturnType<typeof vi.fn>;
    };
    manager.saveQueue = Promise.resolve();
    manager.doSaveIndex = vi.fn().mockRejectedValueOnce(new Error('index unavailable')).mockResolvedValue(undefined);
    await expect(manager.saveIndex()).rejects.toThrow('index unavailable');
    await expect(manager.saveIndex()).resolves.toBeUndefined();
    expect(manager.doSaveIndex).toHaveBeenCalledTimes(2);
  });
});
