import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { RemoteCdpTransport, RemoteCdpTunnelClient, type CdpConnectionTransport } from '../remote-cdp-tunnel';
import { COORDINATOR_TO_NODE } from '../worker-node-rpc';

describe('RemoteCdpTransport', () => {
  it('forwards send/close to the supplied callbacks', () => {
    const send = vi.fn();
    const close = vi.fn();
    const t = new RemoteCdpTransport({ send, close });
    t.send('frame-1');
    t.close();
    expect(send).toHaveBeenCalledWith('frame-1');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('buffers inbound frames until onmessage is set, then flushes in order', () => {
    const t = new RemoteCdpTransport({ send: vi.fn(), close: vi.fn() });
    t.deliverMessage('a');
    t.deliverMessage('b');
    const received: string[] = [];
    t.onmessage = (m) => received.push(m);
    expect(received).toEqual(['a', 'b']);
    // Subsequent frames pass straight through.
    t.deliverMessage('c');
    expect(received).toEqual(['a', 'b', 'c']);
  });

  it('invokes onclose on deliverClose', () => {
    const t = new RemoteCdpTransport({ send: vi.fn(), close: vi.fn() });
    const onclose = vi.fn();
    t.onclose = onclose;
    t.deliverClose();
    expect(onclose).toHaveBeenCalledTimes(1);
  });
});

describe('RemoteCdpTunnelClient', () => {
  let registry: EventEmitter;
  let sendRpc: ReturnType<typeof vi.fn>;
  let sendNotification: ReturnType<typeof vi.fn>;
  let capturedTransport: CdpConnectionTransport | null;
  let client: RemoteCdpTunnelClient;

  beforeEach(() => {
    registry = new EventEmitter();
    sendRpc = vi.fn().mockResolvedValue({ ok: true });
    sendNotification = vi.fn();
    capturedTransport = null;
    client = new RemoteCdpTunnelClient({
      connection: { sendRpc, sendNotification } as never,
      registry: registry as never,
      connectPuppeteer: (transport) => {
        capturedTransport = transport;
        return Promise.resolve(new EventEmitter() as never);
      },
    });
  });

  function openSessionId(): string {
    const call = sendRpc.mock.calls.find((c) => c[1] === COORDINATOR_TO_NODE.BROWSER_CDP_OPEN);
    return call?.[2]?.sessionId as string;
  }

  it('opens a session (service-scoped) and returns a Browser', async () => {
    await client.connectBrowser('node-1');
    const openCall = sendRpc.mock.calls.find((c) => c[1] === COORDINATOR_TO_NODE.BROWSER_CDP_OPEN);
    expect(openCall).toBeTruthy();
    expect(openCall?.[4]).toBe('service'); // scope
    expect(client.activeSessionCount()).toBe(1);
    expect(capturedTransport).not.toBeNull();
  });

  it('routes inbound CDP frames for the right node+session to the transport', async () => {
    await client.connectBrowser('node-1');
    const sessionId = openSessionId();
    const received: string[] = [];
    capturedTransport!.onmessage = (m) => received.push(m);

    // Wrong session — ignored.
    registry.emit('remote:browser-cdp-message', { nodeId: 'node-1', sessionId: 'other', frame: 'x' });
    // Wrong node — ignored.
    registry.emit('remote:browser-cdp-message', { nodeId: 'node-2', sessionId, frame: 'y' });
    // Correct — delivered.
    registry.emit('remote:browser-cdp-message', { nodeId: 'node-1', sessionId, frame: 'hello' });

    expect(received).toEqual(['hello']);
  });

  it('transport.send tunnels a frame via browser.cdp.send (fire-and-forget, service scope)', async () => {
    await client.connectBrowser('node-1');
    const sessionId = openSessionId();
    capturedTransport!.send('cdp-frame');
    expect(sendNotification).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.BROWSER_CDP_SEND,
      { sessionId, frame: 'cdp-frame' },
      'service',
    );
    expect(sendRpc.mock.calls.some((c) => c[1] === COORDINATOR_TO_NODE.BROWSER_CDP_SEND)).toBe(false);
  });

  it('transport.close uses a service-scoped notification', async () => {
    await client.connectBrowser('node-1');
    const sessionId = openSessionId();

    capturedTransport!.close();

    expect(sendNotification).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.BROWSER_CDP_CLOSE,
      { sessionId },
      'service',
    );
  });

  it('closes the session and clears it on browser.cdp.closed', async () => {
    await client.connectBrowser('node-1');
    const sessionId = openSessionId();
    const onclose = vi.fn();
    capturedTransport!.onclose = onclose;
    registry.emit('remote:browser-cdp-closed', { nodeId: 'node-1', sessionId });
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(client.activeSessionCount()).toBe(0);
  });

  it('closes all sessions for a node when that node disconnects', async () => {
    await client.connectBrowser('node-1');
    const onclose = vi.fn();
    capturedTransport!.onclose = onclose;

    registry.emit('node:disconnected', { id: 'node-1' });

    expect(onclose).toHaveBeenCalledTimes(1);
    expect(client.activeSessionCount()).toBe(0);
  });

  it('tears down the session if puppeteer.connect rejects', async () => {
    client = new RemoteCdpTunnelClient({
      connection: { sendRpc, sendNotification } as never,
      registry: registry as never,
      connectPuppeteer: () => Promise.reject(new Error('connect boom')),
    });
    await expect(client.connectBrowser('node-1')).rejects.toThrow(/connect boom/);
    expect(client.activeSessionCount()).toBe(0);
  });
});
