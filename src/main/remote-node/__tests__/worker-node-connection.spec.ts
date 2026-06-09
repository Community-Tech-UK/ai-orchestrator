import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';

// Mock the logger to avoid electron / filesystem dependencies
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// The connection server only touches the registry inside start(); the handshake
// path under test does not. Mock it to avoid pulling in electron deps on import.
vi.mock('../worker-node-registry', () => ({
  getWorkerNodeRegistry: () => Object.assign(new EventEmitter(), {
    getAllNodes: vi.fn(() => []),
    getNode: vi.fn((nodeId: string) => ({ id: nodeId, name: nodeId })),
  }),
}));

// Auth is exercised in remote-auth.spec.ts — here every registration succeeds.
const mockRemoteAuth = {
  authenticateRegistration: vi.fn((params: { nodeId: string }) => ({
    status: 'registered' as const,
    session: { sessionId: 'sess-1', nodeId: params.nodeId, token: 'session-token' },
  })),
};

vi.mock('../../auth/remote-auth', () => ({
  getRemoteAuthService: () => mockRemoteAuth,
}));

import { WorkerNodeConnectionServer } from '../worker-node-connection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake `ws` WebSocket: an EventEmitter with send/close spies. */
function makeFakeWs(): EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
} {
  const ws = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    readyState: number;
  };
  ws.send = vi.fn();
  ws.close = vi.fn();
  // sendRpc only transmits when the socket reports OPEN.
  ws.readyState = WebSocket.OPEN;
  return ws;
}

const NODE_ID = 'win-1';

function registerMessage(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'node.register',
    params: {
      nodeId: NODE_ID,
      name: 'windows-pc',
      token: 'pairing-token',
      capabilities: { platform: 'win32', supportedClis: ['claude'] },
    },
  });
}

describe('WorkerNodeConnectionServer — socket replacement race', () => {
  beforeEach(() => {
    WorkerNodeConnectionServer._resetForTesting();
    mockRemoteAuth.authenticateRegistration.mockClear();
  });

  it('does not deregister a node when a replaced (stale) socket later closes', () => {
    const server = WorkerNodeConnectionServer.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = server as any;

    const disconnected: string[] = [];
    server.on('node:ws-disconnected', (id: string) => disconnected.push(id));

    // Socket A connects and registers.
    const wsA = makeFakeWs();
    internals.handleConnection(wsA);
    wsA.emit('message', registerMessage());
    expect(internals.nodeToSocket.get(NODE_ID)).toBe(wsA);

    // Socket B reconnects with the same nodeId — replaces A in the map. The
    // server calls A.close(), whose 'close' event fires asynchronously (later).
    const wsB = makeFakeWs();
    internals.handleConnection(wsB);
    wsB.emit('message', registerMessage());
    expect(wsA.close).toHaveBeenCalled();
    expect(internals.nodeToSocket.get(NODE_ID)).toBe(wsB);

    // A's deferred close now fires. It must NOT tear down B's live mapping.
    wsA.emit('close');
    expect(disconnected).toEqual([]);
    expect(internals.nodeToSocket.get(NODE_ID)).toBe(wsB);

    // A genuine close of the active socket B does emit a disconnect.
    wsB.emit('close');
    expect(disconnected).toEqual([NODE_ID]);
    expect(internals.nodeToSocket.has(NODE_ID)).toBe(false);
  });
});

describe('WorkerNodeConnectionServer — sendRpc timeout & disconnect', () => {
  beforeEach(() => {
    WorkerNodeConnectionServer._resetForTesting();
    mockRemoteAuth.authenticateRegistration.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function connectNode() {
    const server = WorkerNodeConnectionServer.getInstance();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internals = server as any;
    const ws = makeFakeWs();
    internals.handleConnection(ws);
    ws.emit('message', registerMessage());
    return { server, internals, ws };
  }

  it('does not time out an RPC when the timeout is disabled (timeoutMs <= 0)', async () => {
    vi.useFakeTimers();
    const { server, internals } = connectNode();

    let settled: 'resolved' | 'rejected' | 'pending' = 'pending';
    const promise = server
      .sendRpc(NODE_ID, 'instance.sendInput', { instanceId: 'i-1' }, 0)
      .then(() => { settled = 'resolved'; })
      .catch(() => { settled = 'rejected'; });

    // The default 30s RPC timeout must NOT fire — a blocking remote turn can run
    // far longer than that while output streams back over notifications.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe('pending');
    expect(internals.pending.size).toBe(1);

    // Worker eventually responds → the RPC resolves.
    const [pendingId] = [...internals.pending.keys()];
    internals.handleRpcResponse({ jsonrpc: '2.0', id: pendingId, result: { ok: true } });
    await promise;
    expect(settled).toBe('resolved');
    expect(internals.pending.size).toBe(0);
  });

  it('still times out an RPC that uses the default timeout', async () => {
    vi.useFakeTimers();
    const { server, internals } = connectNode();

    const rejection = server
      .sendRpc(NODE_ID, 'node.ping', {})
      .catch((err: Error) => err.message);

    await vi.advanceTimersByTimeAsync(30_000);
    const message = await rejection;
    expect(message).toContain('RPC timeout after 30000ms');
    expect(internals.pending.size).toBe(0);
  });

  it('rejects pending RPCs when the node disconnects', async () => {
    const { server, internals, ws } = connectNode();

    const rejection = server
      .sendRpc(NODE_ID, 'instance.sendInput', { instanceId: 'i-1' }, 0)
      .catch((err: Error) => err.message);

    expect(internals.pending.size).toBe(1);

    // The node's active socket closes — in-flight RPCs must reject immediately
    // rather than hang (the timeout is disabled for this request).
    ws.emit('close');

    const message = await rejection;
    expect(message).toContain('Node disconnected');
    expect(internals.pending.size).toBe(0);
  });

  it('can send a service-scoped notification to a connected node', () => {
    const { server, ws } = connectNode();

    (server as unknown as {
      sendNotification(nodeId: string, method: string, params?: unknown, scope?: string): void;
    }).sendNotification(NODE_ID, 'browser.cdp.send', { sessionId: 's1', frame: 'f' }, 'service');

    const sent = JSON.parse(ws.send.mock.calls.at(-1)?.[0] as string);
    expect(sent).toMatchObject({
      jsonrpc: '2.0',
      method: 'browser.cdp.send',
      scope: 'service',
      params: { sessionId: 's1', frame: 'f' },
    });
    expect(sent.id).toBeUndefined();
  });
});
