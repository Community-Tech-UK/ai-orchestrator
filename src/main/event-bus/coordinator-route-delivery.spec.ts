import { describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { CoordinatorTailscaleWatcher } from '../remote-node/coordinator-tailscale-watcher';
import { ElectronWindowTransport } from './electron-window-transport';
import { MainEventBus } from './main-event-bus';

describe('coordinator route renderer delivery (LT-711)', () => {
  it('delivers outage and recovery from the watcher through renderer validation', async () => {
    const webContents = { send: vi.fn() };
    const bus = new MainEventBus();
    bus.addTransport(new ElectronWindowTransport(() => webContents));
    let state: 'running' | 'stopped' = 'running';
    const watcher = new CoordinatorTailscaleWatcher({
      probe: async () => ({ state }),
      listPairedNodes: () => [],
      notify: vi.fn(),
      onStateChange: (coordinatorTailscale) => bus.emitRendererEvent(
        IPC_CHANNELS.REMOTE_NODE_EVENT,
        { type: 'coordinator-route', coordinatorTailscale },
      ),
    });

    await watcher.checkNow();
    state = 'stopped';
    await watcher.checkNow();
    await watcher.checkNow(); // An unchanged poll must not duplicate delivery.
    state = 'running';
    await watcher.checkNow();

    expect(webContents.send.mock.calls).toEqual([
      [IPC_CHANNELS.REMOTE_NODE_EVENT, { type: 'coordinator-route', coordinatorTailscale: 'running' }],
      [IPC_CHANNELS.REMOTE_NODE_EVENT, { type: 'coordinator-route', coordinatorTailscale: 'stopped' }],
      [IPC_CHANNELS.REMOTE_NODE_EVENT, { type: 'coordinator-route', coordinatorTailscale: 'running' }],
    ]);
  });

  it('blocks an invalid state before sending to webContents', () => {
    const webContents = { send: vi.fn() };
    const bus = new MainEventBus();
    bus.addTransport(new ElectronWindowTransport(() => webContents));

    bus.emitRendererEvent(IPC_CHANNELS.REMOTE_NODE_EVENT, {
      type: 'coordinator-route', coordinatorTailscale: 'invalid',
    });

    expect(webContents.send).not.toHaveBeenCalled();
  });
});
