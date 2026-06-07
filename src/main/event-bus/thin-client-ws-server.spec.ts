import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainEventBus } from './main-event-bus';
import { ThinClientWsServer } from './thin-client-ws-server';

function onceOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function nextJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(data.toString())));
  });
}

describe('ThinClientWsServer', () => {
  let server: ThinClientWsServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('hosts thin-client event sockets on a dedicated endpoint', async () => {
    const bus = new MainEventBus({ now: () => 10 });
    const buildStateSnapshot = vi.fn((seq: number) => ({ seq, instances: [] }));
    server = new ThinClientWsServer({
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot,
    });

    const status = await server.start({ host: '127.0.0.1', port: 0 });
    const socket = new WebSocket(`ws://${status.host}:${status.port}`);
    await onceOpen(socket);

    const subscribeResponse = nextJson(socket);
    socket.send(JSON.stringify({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['lifecycle'] },
    }));
    await expect(subscribeResponse).resolves.toEqual({
      cmdId: 'cmd-1',
      success: true,
      data: { tiers: ['lifecycle'] },
    });

    const eventMessage = nextJson(socket);
    bus.emit('lifecycle', 'instance:created', { instanceId: 'inst-1' });
    await expect(eventMessage).resolves.toEqual({
      seq: 1,
      ts: 10,
      tier: 'lifecycle',
      type: 'instance:created',
      payload: { instanceId: 'inst-1' },
    });

    const resyncResponse = nextJson(socket);
    socket.send(JSON.stringify({
      cmdId: 'cmd-2',
      cmd: 'state:resync',
      payload: { ipcAuthToken: 'secret' },
    }));
    await expect(resyncResponse).resolves.toEqual({
      cmdId: 'cmd-2',
      success: true,
      data: { seq: 1, instances: [] },
    });
    expect(buildStateSnapshot).toHaveBeenCalledWith(1);

    socket.close();
  });
});
