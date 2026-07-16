import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { WorkerCdpTunnel } from './worker-cdp-tunnel';

/** Fake Chrome CDP WebSocket. */
class FakeWs extends EventEmitter {
  readyState: typeof WebSocket.CONNECTING | typeof WebSocket.OPEN | typeof WebSocket.CLOSING | typeof WebSocket.CLOSED = WebSocket.CONNECTING;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  });

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
}

function makeTunnel(over: { endpoint?: () => Promise<string>; ws?: FakeWs } = {}) {
  const ws = over.ws ?? new FakeWs();
  const browserManager = {
    getBrowserWsEndpoint: over.endpoint ?? vi.fn(async () => 'ws://127.0.0.1:9333/devtools/browser/abc'),
  };
  const wsFactory = vi.fn(() => ws as unknown as WebSocket);
  const tunnel = new WorkerCdpTunnel({ browserManager, wsFactory, openTimeoutMs: 1_000 });
  return { tunnel, ws, wsFactory, browserManager };
}

describe('WorkerCdpTunnel', () => {
  let messages: Array<{ sessionId: string; frame: string }>;
  let closes: Array<{ sessionId: string }>;

  function attach(tunnel: WorkerCdpTunnel): void {
    messages = [];
    closes = [];
    tunnel.on('message', (e) => messages.push(e));
    tunnel.on('closed', (e) => closes.push(e));
  }

  beforeEach(() => {
    messages = [];
    closes = [];
  });

  it('opens a session against the Chrome CDP endpoint', async () => {
    const { tunnel, ws, wsFactory } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    ws.open();
    await open;
    expect(wsFactory).toHaveBeenCalledWith('ws://127.0.0.1:9333/devtools/browser/abc');
    expect(tunnel.activeSessionCount()).toBe(1);
  });

  it('relays Chrome frames as message events tagged with the sessionId', async () => {
    const { tunnel, ws } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    ws.open();
    await open;
    ws.emit('message', Buffer.from('{"id":1,"result":{}}'));
    expect(messages).toEqual([{ sessionId: 's1', frame: '{"id":1,"result":{}}' }]);
  });

  it('forwards send() to the Chrome socket when open', async () => {
    const { tunnel, ws } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    ws.open();
    await open;
    tunnel.send('s1', '{"id":2,"method":"Page.enable"}');
    expect(ws.send).toHaveBeenCalledWith('{"id":2,"method":"Page.enable"}');
  });

  it('send() is a no-op for an unknown session', () => {
    const { tunnel, ws } = makeTunnel();
    tunnel.send('nope', 'frame');
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('close() tears down the socket and emits closed', async () => {
    const { tunnel, ws } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    ws.open();
    await open;
    tunnel.close('s1');
    expect(ws.close).toHaveBeenCalled();
    expect(closes).toEqual([{ sessionId: 's1' }]);
    expect(tunnel.activeSessionCount()).toBe(0);
  });

  it('is idempotent on repeated open for the same session', async () => {
    const { tunnel, ws, wsFactory } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    ws.open();
    await open;
    await tunnel.open('s1');
    expect(wsFactory).toHaveBeenCalledTimes(1);
  });

  it('rejects (and cleans up) when the Chrome socket errors before opening', async () => {
    const { tunnel, ws, wsFactory } = makeTunnel();
    attach(tunnel);
    const open = tunnel.open('s1');
    // Wait until the endpoint resolves and the tunnel wires the socket listeners
    // (the socket stays CONNECTING — no readyState short-circuit here).
    await vi.waitFor(() => expect(wsFactory).toHaveBeenCalled());
    ws.emit('error', new Error('refused'));
    await expect(open).rejects.toThrow(/refused/);
    expect(tunnel.activeSessionCount()).toBe(0);
  });

  it('closeAll tears down every session', async () => {
    const wsA = new FakeWs();
    const { tunnel } = makeTunnel({ ws: wsA });
    attach(tunnel);
    const open = tunnel.open('s1');
    wsA.open();
    await open;
    tunnel.closeAll();
    expect(tunnel.activeSessionCount()).toBe(0);
    expect(wsA.close).toHaveBeenCalled();
  });
});
