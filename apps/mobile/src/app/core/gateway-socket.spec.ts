import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedHost } from './models';
import { GatewaySocket } from './gateway-socket';

const lifecycle = vi.hoisted(() => ({
  listeners: [] as ((state: { isActive: boolean }) => void)[],
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, listener: (state: { isActive: boolean }) => void) => {
      lifecycle.listeners.push(listener);
      return { remove: vi.fn() };
    }),
  },
}));

const HOST: PairedHost = {
  id: 'host', name: 'Host', host: 'host.invalid', port: 8899,
  token: 'TEST_ONLY', addedAt: 0,
};

class SocketDouble {
  static readonly OPEN = 1;
  static readonly sockets: SocketDouble[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readyState = 0;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) { SocketDouble.sockets.push(this); }
  open(): void { this.readyState = SocketDouble.OPEN; this.onopen?.(); }
  close(): void { this.readyState = 3; }
  receive(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
  }
  send(frame: string): void { this.sent.push(JSON.parse(frame)); }
}

describe('GatewaySocket reconnect and foreground liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    vi.stubGlobal('WebSocket', SocketDouble);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    SocketDouble.sockets.length = 0;
    lifecycle.listeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('backs failed handshakes off at 1, 2, 4, 8, then 15 seconds', async () => {
    const socket = new GatewaySocket();
    socket.connect(HOST, () => undefined);
    const delays = [1_000, 2_000, 4_000, 8_000, 15_000];

    for (const delay of delays) {
      SocketDouble.sockets.at(-1)?.onclose?.();
      await vi.advanceTimersByTimeAsync(delay - 1);
      const count = SocketDouble.sockets.length;
      await vi.advanceTimersByTimeAsync(1);
      expect(SocketDouble.sockets).toHaveLength(count + 1);
    }
  });

  it('reconnects a silent socket after foreground ping timeout and catches up the viewed session', async () => {
    const catchUp = vi.fn();
    const socket = new GatewaySocket();
    socket.connect(HOST, () => undefined, catchUp);
    SocketDouble.sockets[0].open();
    socket.setActiveView('session');
    await vi.waitFor(() => expect(lifecycle.listeners).toHaveLength(1));

    lifecycle.listeners[0]({ isActive: true });
    expect(SocketDouble.sockets[0].sent.at(-1)).toMatchObject({ type: 'ping' });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(SocketDouble.sockets).toHaveLength(2);
    SocketDouble.sockets[1].open();

    expect(catchUp).toHaveBeenCalledWith('session');
  });

  it('keeps a live socket when the foreground ping receives a pong', async () => {
    const socket = new GatewaySocket();
    socket.connect(HOST, () => undefined);
    SocketDouble.sockets[0].open();
    await vi.waitFor(() => expect(lifecycle.listeners).toHaveLength(1));

    lifecycle.listeners[0]({ isActive: true });
    SocketDouble.sockets[0].receive({ type: 'pong', data: { sentAt: Date.now() } });
    await vi.advanceTimersByTimeAsync(3_001);

    expect(SocketDouble.sockets).toHaveLength(1);
    expect(socket.state()).toBe('connected');
  });

  it('tears down and retries after 30 seconds when REST marks the host unauthorized', async () => {
    const socket = new GatewaySocket();
    socket.connect(HOST, () => undefined);
    SocketDouble.sockets[0].open();

    socket.markUnauthorized();

    expect(socket.state()).toBe('unauthorized');
    expect(SocketDouble.sockets[0].readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(SocketDouble.sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(SocketDouble.sockets).toHaveLength(2);
    expect(socket.state()).toBe('connecting');
  });

  it('clears server freshness when switching hosts', () => {
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const socket = new GatewaySocket();
    socket.connect(HOST, () => undefined);
    SocketDouble.sockets[0].open();
    SocketDouble.sockets[0].receive({ type: 'snapshot', data: {} });
    expect(socket.lastServerFrameAt()).toBe(Date.now());

    socket.connect({ ...HOST, id: 'other-host', host: 'other.invalid' }, () => undefined);

    expect(socket.lastServerFrameAt()).toBeNull();
  });
});
