import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ThinClientEvent } from '../../shared/types/thin-client-event.types';
import { MainEventBus } from './main-event-bus';
import { WsEventTransport } from './ws-event-transport';

class FakeSocket extends EventEmitter {
  static readonly OPEN = 1;
  readyState = FakeSocket.OPEN;
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed: { code: number; reason: string } | null = null;

  send(data: string, callback?: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    callback?.();
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit('close');
  }
}

describe('WsEventTransport', () => {
  it('authenticates state:subscribe, registers with the event bus, and sends subscribed envelopes', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: () => ({ seq: 0 }),
    });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['lifecycle'] },
    })).toBe(true);

    bus.emit('status', 'quota:updated', { ignored: true });
    bus.emit('lifecycle', 'instance:created', { instanceId: 'inst-1' });

    expect(socket.closed).toBeNull();
    expect(socket.sent).toEqual([
      {
        cmdId: 'cmd-1',
        success: true,
        data: { tiers: ['lifecycle'] },
      },
      {
        seq: 1,
        ts: 10,
        tier: 'lifecycle',
        type: 'instance:created',
        payload: { instanceId: 'inst-1' },
      },
    ]);
  });

  it('rejects invalid auth without registering for events', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: () => ({ seq: 0 }),
    });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'wrong', tiers: ['lifecycle'] },
    })).toBe(true);

    bus.emit('lifecycle', 'instance:created', { instanceId: 'inst-1' });

    expect(socket.closed).toEqual({ code: 4001, reason: 'Unauthorized' });
    expect(socket.sent).toEqual([
      {
        cmdId: 'cmd-1',
        success: false,
        error: expect.objectContaining({ code: 'THIN_CLIENT_AUTH_FAILED' }),
      },
    ]);
  });

  it('answers state:resync with a snapshot correlated to the command id', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: (seq) => ({ seq, instances: [{ id: 'inst-1' }] }),
    });

    transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['lifecycle'] },
    });
    bus.emit('lifecycle', 'instance:created', { instanceId: 'inst-1' });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-2',
      cmd: 'state:resync',
      payload: { ipcAuthToken: 'secret' },
    })).toBe(true);

    expect(socket.sent.at(-1)).toEqual({
      cmdId: 'cmd-2',
      success: true,
      data: {
        seq: 1,
        instances: [{ id: 'inst-1' }],
      },
    });
  });

  it('drops output tier events under socket backpressure instead of queueing them', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    socket.bufferedAmount = 2_000;
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: () => ({ seq: 0 }),
      maxBufferedBytes: 1_000,
    });
    transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['output', 'interaction'] },
    });

    bus.emit('output', 'provider:runtime-event', { text: 'drop me' });
    bus.emit('interaction', 'instance:input-required', { instanceId: 'inst-1' });

    const eventMessages = socket.sent.filter((message): message is ThinClientEvent =>
      typeof message === 'object' && message !== null && 'seq' in message
    );
    expect(eventMessages).toEqual([
      expect.objectContaining({
        tier: 'interaction',
        type: 'instance:input-required',
      }),
    ]);
  });

  it('uses the transport stream cursor for state:resync after a dropped output event', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    socket.bufferedAmount = 2_000;
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: (seq) => ({ seq, instances: [] }),
      maxBufferedBytes: 1_000,
    });
    transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['output'] },
    });

    bus.emit('output', 'provider:runtime-event', { text: 'drop me' });
    transport.handleClientMessage({
      cmdId: 'cmd-2',
      cmd: 'state:resync',
      payload: { ipcAuthToken: 'secret' },
    });

    expect(socket.sent.at(-1)).toEqual({
      cmdId: 'cmd-2',
      success: true,
      data: {
        seq: 1,
        instances: [],
      },
    });
  });

  it('re-validates the auth token on every state:resync command', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const buildStateSnapshot = vi.fn((seq: number) => ({ seq, instances: [] }));
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot,
    });

    transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['lifecycle'] },
    });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-2',
      cmd: 'state:resync',
      payload: { ipcAuthToken: 'wrong' },
    })).toBe(true);

    expect(socket.closed).toEqual({ code: 4001, reason: 'Unauthorized' });
    expect(buildStateSnapshot).not.toHaveBeenCalled();
    expect(socket.sent.at(-1)).toEqual({
      cmdId: 'cmd-2',
      success: false,
      error: expect.objectContaining({ code: 'THIN_CLIENT_AUTH_FAILED' }),
    });
  });

  it('delegates authenticated non-state commands to the configured command executor', async () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const executeCommand = vi.fn(async (cmd, payload) => ({
      success: true,
      data: { cmd, payload },
    }));
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: () => ({ seq: 0 }),
      executeCommand,
    });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'instance:list',
      payload: { ipcAuthToken: 'secret' },
    })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(socket.closed).toBeNull();
    expect(executeCommand).toHaveBeenCalledWith('instance:list', { ipcAuthToken: 'secret' });
    expect(socket.sent).toEqual([
      {
        cmdId: 'cmd-1',
        success: true,
        data: {
          cmd: 'instance:list',
          payload: { ipcAuthToken: 'secret' },
        },
      },
    ]);
  });

  it('rejects command-vocabulary entries when no command executor is configured', () => {
    const bus = new MainEventBus({ now: () => 10 });
    const socket = new FakeSocket();
    const transport = new WsEventTransport(socket, {
      eventBus: bus,
      getIpcAuthToken: () => 'secret',
      buildStateSnapshot: () => ({ seq: 0 }),
    });

    expect(transport.handleClientMessage({
      cmdId: 'cmd-1',
      cmd: 'chat:list',
      payload: { ipcAuthToken: 'secret' },
    })).toBe(true);

    expect(socket.closed).toBeNull();
    expect(socket.sent).toEqual([
      {
        cmdId: 'cmd-1',
        success: false,
        error: expect.objectContaining({
          code: 'THIN_CLIENT_COMMAND_EXECUTOR_UNAVAILABLE',
        }),
      },
    ]);
  });
});
