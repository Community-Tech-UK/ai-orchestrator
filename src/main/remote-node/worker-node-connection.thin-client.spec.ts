import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerNodeConnectionServer } from './worker-node-connection';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

describe('WorkerNodeConnectionServer thin-client handoff', () => {
  beforeEach(() => {
    WorkerNodeConnectionServer._resetForTesting();
  });

  it('keeps the worker-node listener reserved for node.register instead of thin-client UI sockets', () => {
    const socket = new FakeSocket();
    const server = WorkerNodeConnectionServer.getInstance() as unknown as {
      handleConnection(ws: FakeSocket): void;
    };
    server.handleConnection(socket);

    socket.emit('message', Buffer.from(JSON.stringify({
      cmdId: 'cmd-1',
      cmd: 'state:subscribe',
      payload: { ipcAuthToken: 'secret', tiers: ['lifecycle'] },
    })));

    expect(socket.sent).toEqual([]);
    expect(socket.readyState).toBe(3);
  });
});
