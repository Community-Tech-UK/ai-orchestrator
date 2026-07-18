import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeRegistry } from './worker-node-registry';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => []),
  list: vi.fn<() => unknown[]>(() => []),
  send: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: mocks.send } }],
  },
}));

vi.mock('../local-models/local-model-inventory-service', () => ({
  getLocalModelInventoryService: () => ({ refresh: mocks.refresh }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ warn: mocks.warn }),
}));

vi.mock('./remote-node-roster-service', () => ({
  getRemoteNodeRosterService: () => ({ list: mocks.list }),
}));

import { bindWorkerNodeRosterUpdates } from './worker-node-roster-updates';

describe('bindWorkerNodeRosterUpdates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.list.mockReturnValue([]);
  });

  it('refreshes inventory only for topology or local-model capability changes', () => {
    const registry = new EventEmitter() as WorkerNodeRegistry;
    const unbind = bindWorkerNodeRosterUpdates(registry);

    registry.emit('node:updated', {});
    expect(mocks.refresh).not.toHaveBeenCalled();

    registry.emit('node:connected', {});
    registry.emit('node:local-models-changed', {});
    registry.emit('node:disconnected', {});
    expect(mocks.refresh).toHaveBeenCalledTimes(3);

    unbind();
    registry.emit('node:local-models-changed', {});
    expect(mocks.refresh).toHaveBeenCalledTimes(3);
  });

  it('refuses to broadcast an invalid renderer roster payload', () => {
    mocks.list.mockReturnValue([{ id: 'missing-required-fields' }]);
    const registry = new EventEmitter() as WorkerNodeRegistry;
    const unbind = bindWorkerNodeRosterUpdates(registry);

    registry.emit('node:updated', {});

    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      'Refusing to broadcast an invalid remote-node roster payload',
      { issues: expect.any(Number) },
    );
    unbind();
  });
});
