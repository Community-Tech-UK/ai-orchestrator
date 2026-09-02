import { beforeEach, describe, expect, it, vi } from 'vitest';

const workerPort = vi.hoisted(() => ({
  invokeRlm: vi.fn(),
}));
const fileWatcher = vi.hoisted(() => ({
  startWatching: vi.fn(),
}));

vi.mock('../instance/context-worker-client', () => ({
  getContextWorkerClient: () => workerPort,
}));
vi.mock('./file-watcher', () => ({
  getCodebaseFileWatcher: () => fileWatcher,
}));

import {
  createDefaultContextManagerTarget,
  createDefaultFileWatcherTarget,
} from './codebase-indexing-auto-defaults';

describe('codebase auto-index default context target', () => {
  beforeEach(() => {
    workerPort.invokeRlm.mockReset();
    fileWatcher.startWatching.mockReset();
  });

  it('uses the shared RLM worker port for configurable creation and discovery', async () => {
    const store = { id: 'worker-store' };
    workerPort.invokeRlm
      .mockResolvedValueOnce(store)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ sections: [{ type: 'file', filePath: '/repo/main.ts' }] });
    const target = createDefaultContextManagerTarget();
    const config = { kind: 'codebase-auto', rootPath: '/repo' };

    await expect(target.createStore('codebase:repo', config)).resolves.toBe(store);
    await expect(target.listStores?.()).resolves.toEqual([]);
    await expect(target.listSectionFilterMetadata?.('worker-store', 256, 12)).resolves.toEqual({
      sections: [{ type: 'file', filePath: '/repo/main.ts' }],
    });
    expect(workerPort.invokeRlm.mock.calls).toEqual([
      [{ kind: 'create-store', instanceId: 'codebase:repo', config }],
      [{ kind: 'list-stores' }],
      [{ kind: 'list-section-filter-metadata', storeId: 'worker-store', offset: 256, limit: 12 }],
    ]);
  });

  it('preserves the unique disposable registration from the shared file watcher', async () => {
    const registration = { dispose: vi.fn().mockResolvedValue(undefined) };
    fileWatcher.startWatching.mockResolvedValue(registration);

    const target = createDefaultFileWatcherTarget();

    await expect(target.startWatching('store-1', '/repo')).resolves.toBe(registration);
    expect(fileWatcher.startWatching).toHaveBeenCalledWith('store-1', '/repo');
  });
});
