import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeRegistry } from './worker-node-registry';

const refresh = vi.fn(async () => []);

vi.mock('../local-models/local-model-inventory-service', () => ({
  getLocalModelInventoryService: () => ({ refresh }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('./remote-node-roster-service', () => ({
  getRemoteNodeRosterService: () => ({ list: () => [] }),
}));

import { bindWorkerNodeRosterUpdates } from './worker-node-roster-updates';

describe('bindWorkerNodeRosterUpdates', () => {
  beforeEach(() => {
    refresh.mockClear();
  });

  it('refreshes inventory only for topology or local-model capability changes', () => {
    const registry = new EventEmitter() as WorkerNodeRegistry;
    const unbind = bindWorkerNodeRosterUpdates(registry);

    registry.emit('node:updated', {});
    expect(refresh).not.toHaveBeenCalled();

    registry.emit('node:connected', {});
    registry.emit('node:local-models-changed', {});
    registry.emit('node:disconnected', {});
    expect(refresh).toHaveBeenCalledTimes(3);

    unbind();
    registry.emit('node:local-models-changed', {});
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
