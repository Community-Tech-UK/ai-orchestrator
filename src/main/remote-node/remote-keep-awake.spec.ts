import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { RemoteKeepAwake } from './remote-keep-awake';

describe('remote keep-awake coordinator', () => {
  function setup() {
    const nodes = [
      { id: 'pc', status: 'connected', capabilities: { keepAwake: 1 } },
      { id: 'old', status: 'connected', capabilities: {} },
    ] as WorkerNodeInfo[];
    let instances = [{ status: 'busy', lastActivity: Date.now(),
      executionLocation: { type: 'remote', nodeId: 'pc' } }] as Instance[];
    const send = vi.fn(async () => ({ active: true }));
    const coordinator = new RemoteKeepAwake({ getNodes: () => nodes,
      getInstances: () => instances, send });
    return { nodes, send, coordinator, setInstances: (value: Instance[]) => { instances = value; } };
  }
  it('renews only working capable workers and releases when work ends or mode is off', async () => {
    const { send, coordinator, setInstances } = setup();
    await coordinator.reconcile('while-working');
    await coordinator.reconcile('while-working');
    expect(send.mock.calls).toEqual([['pc', true], ['pc', true]]);
    setInstances([]);
    await coordinator.reconcile('while-working');
    expect(send).toHaveBeenLastCalledWith('pc', false);
    await coordinator.reconcile('always');
    expect(send).toHaveBeenLastCalledWith('pc', true);
    await coordinator.reconcile('off');
    expect(send).toHaveBeenLastCalledWith('pc', false);
  });
  it('shutdown releases held workers and failed renewals remain retryable', async () => {
    const { coordinator, send } = setup();
    send.mockRejectedValueOnce(new Error('link lost'));
    await coordinator.reconcile('always');
    await coordinator.reconcile('always');
    await coordinator.shutdown();
    expect(send.mock.calls).toEqual([['pc', true], ['pc', true], ['pc', false]]);
  });
  it('isolates slow workers and replaces queued renewals with the latest Off setting', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const nodes = Array.from({ length: 7 }, (_, index) => ({ id: `silent-${index}`,
      status: 'connected', capabilities: { keepAwake: 1 } }));
    nodes.push({ id: 'healthy', status: 'connected', capabilities: { keepAwake: 1 } });
    const healthyCommands: { enabled: boolean; at: number }[] = [];
    const send = async (id: string, enabled: boolean) => {
      if (id === 'healthy') { healthyCommands.push({ enabled, at: Date.now() }); return; }
      await new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('bounded fixture timeout')), 15_000));
    };
    const coordinator = new RemoteKeepAwake({ getNodes: () => nodes as WorkerNodeInfo[],
      getInstances: () => [], send });
    const first = coordinator.reconcile('always');
    await vi.advanceTimersByTimeAsync(0);
    const queuedRenewal = coordinator.reconcile('always');
    const off = coordinator.reconcile('off');
    try {
      await vi.runAllTimersAsync(); await Promise.all([first, queuedRenewal, off]);
      expect(healthyCommands).toEqual([{ enabled: true, at: 0 }, { enabled: false, at: 0 }]);
      expect(Date.now()).toBeLessThan(90_000);
    } finally {
      const shutdown = coordinator.shutdown();
      await vi.runAllTimersAsync(); await shutdown; vi.useRealTimers();
    }
  });
});
