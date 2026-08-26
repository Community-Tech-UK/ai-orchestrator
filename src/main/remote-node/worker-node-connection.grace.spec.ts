import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkerNodeConnectionServer } from './worker-node-connection';
import { DISCONNECT_GRACE_MS } from './connection-disconnect-lifecycle';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  // Extra registry fields the close-forensics snapshot reads. Empty by default
  // so every pre-existing test keeps exercising the "registry knows nothing but
  // the name" path.
  nodeExtras: {} as Record<string, unknown>,
  // When true the registry reports no node at all — the one reachable "unknown"
  // state (deregistered before the socket's close event fired).
  nodeMissing: false,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => mocks.logger,
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
    getNode: (id: string) =>
      mocks.nodeMissing ? undefined : { id, name: id, ...mocks.nodeExtras },
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

  close(code = 1000, reason = ''): void {
    this.readyState = 3; // CLOSED
    this.emit('close', code, Buffer.from(reason));
  }
}

// `handleConnection` is intentionally omitted from this interface: it is
// `private` on `WorkerNodeConnectionServer`, and intersecting a type with a
// public re-declaration of a same-named private class member collapses the
// whole intersection to `never`. It is invoked below via a standalone cast.
interface TestServer {
  isNodeConnected(nodeId: string): boolean;
  sendRpc<T>(nodeId: string, method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

function registerNode(server: TestServer, ws: FakeSocket, nodeId = 'node-1'): void {
  (server as unknown as { handleConnection(ws: FakeSocket): void }).handleConnection(ws);
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
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.debug.mockClear();
    mocks.nodeExtras = {};
    mocks.nodeMissing = false;
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
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 100);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // Re-register within the grace window on a fresh socket → continuous session.
    const ws2 = new FakeSocket();
    registerNode(server, ws2);
    expect(server.isNodeConnected('node-1')).toBe(true);

    // Even well past the original grace window, no disconnect / no RPC failure.
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS + 1);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // Clean up the still-pending RPC by fully disconnecting.
    ws2.close();
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
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
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS - 1);
    expect(disconnected).not.toHaveBeenCalled();
    expect(rejected).toBeNull();

    // After grace elapses: true disconnect.
    await vi.advanceTimersByTimeAsync(1);
    expect(disconnected).toHaveBeenCalledTimes(1);
    await inflight;
    expect(rejected).toBeInstanceOf(Error);
  });

  it('logs the WebSocket close code and reason so a disconnect never has to be inferred', async () => {
    const ws = new FakeSocket();
    registerNode(server, ws);

    ws.close(1006, 'abnormal closure');

    const call = mocks.logger.info.mock.calls.find(
      ([message]) => message === 'Worker WebSocket closed',
    );
    expect(call).toBeDefined();
    const [, meta] = call as [string, Record<string, unknown>];
    expect(meta['nodeId']).toBe('node-1');
    expect(meta['closeCode']).toBe(1006);
    expect(meta['closeReason']).toBe('abnormal closure');

    // Clean up the grace timer this close scheduled.
    await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
  });

  /**
   * Regression cover for the 2026-08-25 windows-pc outage. The worker died at
   * 16:06:44Z and stayed dead 9.3 hours; the coordinator had logged only
   * `{closeCode: 1006, closeReason: ''}`, so reconstructing even the shape of
   * the failure required pulling the node's own log off the machine afterwards.
   * A 1006 never carries a reason, so the close code can never say why — these
   * four fields are what actually discriminate the cases.
   */
  describe('close forensics', () => {
    const findCloseMeta = (): Record<string, unknown> => {
      const call = mocks.logger.info.mock.calls.find(
        ([message]) => message === 'Worker WebSocket closed',
      );
      expect(call).toBeDefined();
      return (call as [string, Record<string, unknown>])[1];
    };

    it('records a fresh heartbeat and a long session — the abrupt-kill signature', async () => {
      const now = Date.now();
      mocks.nodeExtras = {
        connectedAt: now - 9 * 60 * 60 * 1000,
        lastHeartbeat: now - 3_700,
        activeInstances: 1,
      };
      const ws = new FakeSocket();
      registerNode(server, ws);

      ws.close(1006, '');

      const meta = findCloseMeta();
      // Healthy right up to the instant it vanished: points at an external
      // kill (TerminateProcess, closed parent console, power loss) rather than
      // a wedged process.
      expect(meta['heartbeatAgeMs']).toBe(3_700);
      expect(meta['sessionMs']).toBe(9 * 60 * 60 * 1000);
      expect(meta['activeInstances']).toBe(1);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    });

    it('records a stale heartbeat — the already-wedged signature', async () => {
      const now = Date.now();
      mocks.nodeExtras = { connectedAt: now - 60_000, lastHeartbeat: now - 240_000 };
      const ws = new FakeSocket();
      registerNode(server, ws);

      ws.close(1006, '');

      // The discriminating value: the worker had stopped heartbeating long
      // before the socket dropped, so the drop is a symptom, not the event.
      expect(findCloseMeta()['heartbeatAgeMs']).toBe(240_000);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    });

    it('reports in-flight work and its oldest age, so "died mid-task" is visible at the close', async () => {
      mocks.nodeExtras = { connectedAt: Date.now() - 1000, lastHeartbeat: Date.now() };
      const ws = new FakeSocket();
      registerNode(server, ws);

      const settled: Error[] = [];
      const work = server
        .sendRpc('node-1', 'instance.sendInput', {}, 0)
        .catch((err: Error) => void settled.push(err));

      await vi.advanceTimersByTimeAsync(5_000);
      ws.close(1006, '');

      const meta = findCloseMeta();
      expect(meta['inFlightWork']).toBe(1);
      expect(meta['inFlightMethods']).toEqual(['instance.sendInput']);
      expect(meta['oldestInFlightMs']).toBe(5_000);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
      await work;
      expect(settled).toHaveLength(1);
    });

    it('reports zero in-flight work on an idle close, and omits the method list entirely', async () => {
      mocks.nodeExtras = { connectedAt: Date.now() - 1000, lastHeartbeat: Date.now() };
      const ws = new FakeSocket();
      registerNode(server, ws);

      ws.close(1000, 'going away');

      const meta = findCloseMeta();
      expect(meta['inFlightWork']).toBe(0);
      expect(meta['inFlightControl']).toBe(0);
      // Absent rather than an empty array: nothing outstanding is the common
      // case and should not add noise to every clean shutdown line.
      expect(meta).not.toHaveProperty('inFlightMethods');

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    });

    it('says registryNode: absent instead of silently dropping the registry fields', async () => {
      // The only reachable "unknown" case. `registerNode` (rpc-event-router)
      // seeds connectedAt/lastHeartbeat/activeInstances in one object, so a
      // known node always has all three; the sole way to have none is the
      // registry having already dropped the node before this close fired.
      // Reported explicitly so "could not measure" is distinguishable from
      // "measured, and it was zero".
      mocks.nodeMissing = true;
      const ws = new FakeSocket();
      registerNode(server, ws);

      ws.close(1006, '');

      const meta = findCloseMeta();
      expect(meta['registryNode']).toBe('absent');
      expect(meta).not.toHaveProperty('sessionMs');
      expect(meta).not.toHaveProperty('heartbeatAgeMs');
      expect(meta).not.toHaveProperty('activeInstances');
      // The in-flight half does not come from the registry, so it survives.
      expect(meta['inFlightWork']).toBe(0);

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    });

    it('emits the three registry fields together, never a partial set', async () => {
      const now = Date.now();
      mocks.nodeExtras = { connectedAt: now - 5_000, lastHeartbeat: now - 1_000, activeInstances: 2 };
      const ws = new FakeSocket();
      registerNode(server, ws);

      ws.close(1006, '');

      const meta = findCloseMeta();
      expect(meta).toMatchObject({ sessionMs: 5_000, heartbeatAgeMs: 1_000, activeInstances: 2 });
      expect(meta).not.toHaveProperty('registryNode');

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
    });

    it('keeps the close line content-free — counts, ages and method names only', async () => {
      mocks.nodeExtras = { connectedAt: Date.now() - 1000, lastHeartbeat: Date.now() };
      const ws = new FakeSocket();
      registerNode(server, ws);

      const settled: Error[] = [];
      const work = server
        .sendRpc('node-1', 'instance.sendInput', { message: 'SENSITIVE-PAYLOAD' }, 0)
        .catch((err: Error) => void settled.push(err));

      ws.close(1006, '');

      const meta = findCloseMeta();
      // Assert the forensics were actually produced BEFORE checking what they
      // omit. Without this the whole test passes against an empty object, so it
      // would go on passing if the snapshot were removed entirely — proving
      // nothing about the real implementation.
      expect(meta['inFlightWork']).toBe(1);
      expect(meta['inFlightMethods']).toEqual(['instance.sendInput']);
      expect(meta).toHaveProperty('heartbeatAgeMs');
      // The method name crosses; the params it carried do not.
      expect(JSON.stringify(meta)).not.toContain('SENSITIVE-PAYLOAD');

      await vi.advanceTimersByTimeAsync(DISCONNECT_GRACE_MS);
      await work;
      expect(settled).toHaveLength(1);
    });
  });
});
