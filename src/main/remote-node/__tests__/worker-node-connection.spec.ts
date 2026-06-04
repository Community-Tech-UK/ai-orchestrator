import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

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
  getWorkerNodeRegistry: () => new EventEmitter(),
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
function makeFakeWs(): EventEmitter & { send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  const ws = new EventEmitter() as EventEmitter & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  ws.send = vi.fn();
  ws.close = vi.fn();
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
