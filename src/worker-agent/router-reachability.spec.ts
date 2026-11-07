import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  routeOutput: '   route to: default\ndestination: default\n    gateway: 192.168.0.1\n  interface: en12\n',
  routeError: null as Error | null,
  createConnection: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (error: Error | null, stdout: string) => void) =>
    cb(mocks.routeError, mocks.routeOutput),
}));
vi.mock('net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('net')>()),
  createConnection: mocks.createConnection,
}));

import { isRouterUnreachable } from './router-reachability';

class FakeSocket extends EventEmitter {
  readonly destroy = vi.fn();
  setTimeout(): this { return this; }
}

describe('isRouterUnreachable', () => {
  beforeEach(() => {
    mocks.routeError = null;
    mocks.routeOutput = '    gateway: 192.168.0.1\n';
    mocks.createConnection.mockReset();
  });

  it('is true when the router also fails with EHOSTUNREACH', async () => {
    const socket = new FakeSocket();
    mocks.createConnection.mockReturnValue(socket);

    const result = isRouterUnreachable();
    await vi.waitFor(() => expect(mocks.createConnection).toHaveBeenCalledWith({ host: '192.168.0.1', port: 53 }));
    socket.emit('error', Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }));

    await expect(result).resolves.toBe(true);
  });

  it('is false when the router answers or refuses', async () => {
    const answering = new FakeSocket();
    mocks.createConnection.mockReturnValue(answering);
    const answered = isRouterUnreachable();
    await vi.waitFor(() => expect(mocks.createConnection).toHaveBeenCalled());
    answering.emit('connect');
    await expect(answered).resolves.toBe(false);

    const refusing = new FakeSocket();
    mocks.createConnection.mockReturnValue(refusing);
    const refused = isRouterUnreachable();
    await vi.waitFor(() => expect(mocks.createConnection).toHaveBeenCalledTimes(2));
    refusing.emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(refused).resolves.toBe(false);
  });

  it('is undefined with no home-network router to try', async () => {
    mocks.routeError = new Error('route: not in table');
    await expect(isRouterUnreachable()).resolves.toBeUndefined();

    mocks.routeError = null;
    mocks.routeOutput = '    gateway: 100.64.0.1\n';
    await expect(isRouterUnreachable()).resolves.toBeUndefined();
    expect(mocks.createConnection).not.toHaveBeenCalled();
  });
});
