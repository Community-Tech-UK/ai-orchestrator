import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const netMock = vi.hoisted(() => ({
  createConnection: vi.fn(),
}));

vi.mock('node:net', () => ({
  createConnection: netMock.createConnection,
  default: { createConnection: netMock.createConnection },
}));

import {
  firstReachableCoordinatorCandidate,
  probeCoordinatorCandidate,
} from './coordinator-network-readiness';

class FakeSocket extends EventEmitter {
  readonly setTimeout = vi.fn();
  readonly destroy = vi.fn();
}

describe('coordinator network readiness', () => {
  beforeEach(() => {
    netMock.createConnection.mockReset();
  });

  it('probes the coordinator host and port without opening a WebSocket', async () => {
    const socket = new FakeSocket();
    netMock.createConnection.mockReturnValue(socket);

    const result = probeCoordinatorCandidate('ws://100.68.10.5:4878');
    socket.emit('connect');

    await expect(result).resolves.toBe(true);
    expect(netMock.createConnection).toHaveBeenCalledWith({
      host: '100.68.10.5',
      port: 4878,
    });
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('treats a timed-out stale address as unreachable and closes its probe socket', async () => {
    const socket = new FakeSocket();
    netMock.createConnection.mockReturnValue(socket);

    const result = probeCoordinatorCandidate('ws://192.168.0.156:4878', undefined, 2500);
    socket.emit('timeout');

    await expect(result).resolves.toBe(false);
    expect(socket.setTimeout).toHaveBeenCalledWith(2500);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });

  it('selects the first reachable route in configured order and aborts stale probes', async () => {
    const resolvers = new Map<string, (reachable: boolean) => void>();
    const signals = new Map<string, AbortSignal>();
    const probe = vi.fn((url: string, signal: AbortSignal) => {
      signals.set(url, signal);
      return new Promise<boolean>((resolve) => resolvers.set(url, resolve));
    });
    const candidates = [
      'ws://macbook-pro.tail4fc107.ts.net:4878',
      'ws://100.68.10.5:4878',
      'ws://192.168.0.156:4878',
    ];

    const selected = firstReachableCoordinatorCandidate(candidates, probe);
    resolvers.get('ws://macbook-pro.tail4fc107.ts.net:4878')?.(false);
    resolvers.get('ws://100.68.10.5:4878')?.(true);

    await expect(selected).resolves.toBe('ws://100.68.10.5:4878');
    expect(probe).toHaveBeenCalledTimes(3);
    expect([...signals.values()].every((signal) => signal.aborted)).toBe(true);
  });

  it('does not let a faster lower-priority LAN route outrank the paired route', async () => {
    const resolvers = new Map<string, (reachable: boolean) => void>();
    const probe = vi.fn((url: string) => (
      new Promise<boolean>((resolve) => resolvers.set(url, resolve))
    ));
    const paired = 'ws://macbook-pro.tail4fc107.ts.net:4878';
    const staleLan = 'ws://192.168.0.156:4878';

    const selected = firstReachableCoordinatorCandidate([paired, staleLan], probe);
    resolvers.get(staleLan)?.(true);
    await Promise.resolve();
    resolvers.get(paired)?.(true);

    await expect(selected).resolves.toBe(paired);
  });

  it('returns null only after every configured route is unreachable', async () => {
    const probe = vi.fn(async () => false);

    await expect(firstReachableCoordinatorCandidate([
      'ws://100.68.10.5:4878',
      'ws://192.168.0.156:4878',
    ], probe)).resolves.toBeNull();
  });
});
