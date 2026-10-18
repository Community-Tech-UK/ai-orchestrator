import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-test', isPackaged: false } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));

import { InstanceManager } from './instance-manager';

describe('InstanceManager deliberate Close all versus app quit', () => {
  it('closes a snapshot of each session gracefully through the normal public teardown', async () => {
    const sessions = [{ id: 'a' }, { id: 'b' }];
    const terminateInstance = vi.fn(async () => { sessions.length = 0; });
    const terminateAll = vi.fn();
    const receiver = {
      state: { getAllInstances: () => sessions },
      terminateInstance,
      lifecycle: { terminateAll },
    };
    await InstanceManager.prototype.terminateAllInstances.call(receiver as never);
    expect(terminateInstance.mock.calls).toEqual([['a', true], ['b', true]]);
    expect(terminateAll).not.toHaveBeenCalled();
  });

  it('retains the lifecycle bulk path for app quit', async () => {
    const terminateAll = vi.fn(async () => undefined);
    const terminateInstance = vi.fn();
    await InstanceManager.prototype.terminateAll.call({ lifecycle: { terminateAll }, terminateInstance } as never);
    expect(terminateAll).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });
});
