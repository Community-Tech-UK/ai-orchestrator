import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerNodeConnectionServer } from './worker-node-connection';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../auth/remote-auth', () => ({
  getRemoteAuthService: () => ({
    authenticateRegistration: () => ({
      status: 'accepted',
      session: {
        sessionId: 'sess-1',
        nodeId: 'node-1',
        token: 'tok-1',
        recoveryToken: 'rec-1',
      },
    }),
  }),
}));

vi.mock('./worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({
    getNode: (id: string) => ({ id, name: id }),
    getAllNodes: () => [],
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
  }),
}));

vi.mock('./remote-worker-repair-tracker', () => ({
  getRemoteWorkerRepairTracker: () => ({
    clear: vi.fn(),
    recordRejectedRegistration: vi.fn(),
  }),
}));

class FakeSocket extends EventEmitter {
  readyState = 1; // OPEN
  bufferedAmount = 0;
  sent: unknown[] = [];

  send(data: string, cb?: (err?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    cb?.();
  }

  close(): void {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}

interface TestServer {
  handleConnection(ws: FakeSocket): void;
  isNodeConnected(nodeId: string): boolean;
  sendRpc<T>(nodeId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

function registerNode(server: TestServer, ws: FakeSocket, nodeId = 'node-1'): void {
  server.handleConnection(ws);
  ws.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'reg-1',
        method: 'node.register',
        params: { nodeId, name: nodeId, token: 'tok-1' },
      }),
    ),
  );
}

describe('WorkerNodeConnectionServer disconnect grace window', () => {
  let server: WorkerNodeConnectionServer & TestServer;

  beforeEach(() => {
    vi.useFakeTimers();
    WorkerNodeConnectionServer._resetForTesting();
    server = WorkerNodeConnectionServer.getInstance() as unknown as WorkerNodeConnectionServer &
      TestServer;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    WorkerNodeConnectionServer._resetForTesting();
  });

  it('does not deregister or fail in-flight RPCs within the grace window', async () => {
    const ws = new FakeSocket();
    registerNode(server, ws);
    expect(server.isNodeConnected('node-1')).toBe(true);

    const disconnected = vi.fn();
    server.on('node:ws-disconnected', disconnected);

    // An in-flight, timeout-disabled RPC (e.g. instance.sendInput).
    let rejected: Error | null = null;
    const inflight = server
      .sendRpc('node-1', 'instance.sendInput', {}, 0)
      .catch((err: Error) => {
        rejected = err;
      });

    // Socket flaps closed.
    ws.close();

    // Advance to just before the grace window elapses.
    await vi.advanceTimersByTimeAsync(2_400);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // Re-register within the grace window on a fresh socket → continuous session.
    const ws2 = new FakeSocket();
    registerNode(server, ws2);
    expect(server.isNodeConnected('node-1')).toBe(true);

    // Even well past the original grace window, no disconnect / no RPC failure.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // Clean up the still-pending RPC by fully disconnecting.
    ws2.close();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await inflight;
    expect(rejected).toBeInstanceOf(Error);
  });

  it('deregisters and fails in-flight RPCs once the grace window elapses with no re-registration', async () => {
    const ws = new FakeSocket();
    registerNode(server, ws);

    const disconnected = vi.fn();
    server.on('node:ws-disconnected', disconnected);

    let rejected: Error | null = null;
    const inflight = server
      .sendRpc('node-1', 'instance.sendInput', {}, 0)
      .catch((err: Error) => {
        rejected = err;
      });

    ws.close();

    // Before grace elapses: still holding.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // After grace elapses: true disconnect.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await inflight;
    expect(rejected).toBeInstanceOf(Error);
  });
});
