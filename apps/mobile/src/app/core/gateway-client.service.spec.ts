import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import type { PairedHost } from './models';

const HOST: PairedHost = {
  id: 'h1',
  name: 'mac',
  host: '100.64.0.1',
  port: 8899,
  token: 'test-token',
  addedAt: 0,
};

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function makeClient(): { client: GatewayClient; fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  TestBed.configureTestingModule({
    providers: [
      {
        provide: HostStore,
        useValue: { hosts: signal([HOST]), activeHost: signal(HOST) },
      },
    ],
  });
  return { client: TestBed.inject(GatewayClient), fetchMock };
}

describe('GatewayClient.sendInput', () => {
  let client: GatewayClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, fetchMock } = makeClient());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the optimistic bubble and re-syncs when the message really was sent', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const result = await client.sendInput('a', 'hello');

    expect(result).toEqual({ queued: false });
    expect(client.messagesFor('a').map((m) => m.content)).toEqual(['hello']);
  });

  it('retracts the optimistic bubble when the send is rejected', async () => {
    // The regression: a rejected send left the bubble in the transcript while
    // the composer restored the draft, so one message appeared to be in two places.
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Codex app-server runtime already has an active turn' }, false, 500),
    );

    await expect(client.sendInput('a', 'hello')).rejects.toThrow('active turn');

    expect(client.messagesFor('a')).toEqual([]);
  });

  it('retracts the optimistic bubble when the host queued the message instead', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, queued: true, queueId: 'q1' }));

    const result = await client.sendInput('a', 'later');

    expect(result).toEqual({ queued: true });
    expect(client.messagesFor('a')).toEqual([]);
    // No transcript re-sync: the message is not in the host's buffer yet.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('GatewayClient queue + interrupt', () => {
  let client: GatewayClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, fetchMock } = makeClient());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('cancels a queued message and returns its text for the composer', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, message: 'never mind' }));

    await expect(client.cancelQueued('a', 'q1')).resolves.toBe('never mind');

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://100.64.0.1:8899/api/instances/a/queue/q1');
    expect((init as RequestInit).method).toBe('DELETE');
  });

  it('reports an interrupt the host could not accept', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, accepted: false }));
    await expect(client.interrupt('a')).resolves.toEqual({ accepted: false });

    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, accepted: true }));
    await expect(client.interrupt('a')).resolves.toEqual({ accepted: true });
  });
});

/**
 * A rejected WebSocket handshake reaches the browser as a bare close event, with
 * no status. An expired device token therefore looked exactly like an unreachable
 * host, and the UI told the user to check Tailscale while the real fix was to
 * re-pair the phone.
 */
/**
 * Every REST caller surfaces `err.message` straight to the screen, so the gateway's
 * bare "Unauthorized" used to be the entire user-facing explanation on History,
 * History detail and New Session. Translating at the single choke point fixes all
 * of them, including callers added later.
 */
describe('GatewayClient rejected-token REST handling', () => {
  let client: GatewayClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, fetchMock } = makeClient());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces the bare server "Unauthorized" with the re-pair instruction', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, false, 401));

    await expect(client.history()).rejects.toThrow(/no longer paired/);

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, false, 401));
    await expect(client.history()).rejects.not.toThrow(/^Unauthorized$/);
  });

  it('converges the whole app on the unauthorized state from any 401', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, false, 401));

    await expect(client.recentDirs()).rejects.toThrow(/Settings, Mobile/);

    expect(client.state()).toBe('unauthorized');
  });

  it('reflects a rejected token from the push quick-reply path too', async () => {
    // This path builds its own request rather than going through request(), so it
    // needs the same treatment or a push approval fails with a bare "Unauthorized".
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, false, 401));

    await expect(
      client.respondFromPush('mac', 'a', {
        requestId: 'r1',
        decisionAction: 'allow',
        decisionScope: 'once',
      }),
    ).rejects.toThrow(/no longer paired/);

    expect(client.state()).toBe('unauthorized');
  });

  /**
   * A slow 401 from a host the user has since switched away from must not label
   * the new, healthy connection as expired — there is no path back to
   * 'connected' short of another socket open, so the false banner would stick.
   */
  it('ignores a stale 401 once the user has switched to another host', async () => {
    // This case needs its own host-store double, so discard the shared one the
    // suite's beforeEach already instantiated.
    TestBed.resetTestingModule();
    const activeHost = signal(HOST);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [
        { provide: HostStore, useValue: { hosts: signal([HOST]), activeHost } },
      ],
    });
    const scopedClient = TestBed.inject(GatewayClient);

    // Assigned synchronously by the Promise executor below, before any await.
    let release!: (value: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );
    const inFlight = scopedClient.history();

    // The user switches hosts while that request is still outstanding.
    activeHost.set({ ...HOST, id: 'h2', name: 'other-mac' });
    release(jsonResponse({ error: 'Unauthorized' }, false, 401));

    await expect(inFlight).rejects.toThrow(/no longer paired/);
    expect(scopedClient.state()).not.toBe('unauthorized');
  });

  it('leaves other request failures reported as the host described them', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: 'Codex app-server runtime already has an active turn' }, false, 500),
    );

    await expect(client.sendInput('a', 'hello')).rejects.toThrow('active turn');
    expect(client.state()).not.toBe('unauthorized');
  });
});

describe('GatewayClient failed handshake diagnosis', () => {
  class FakeWebSocket {
    static last: FakeWebSocket | null = null;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    readyState = 0;
    constructor(readonly url: string) {
      FakeWebSocket.last = this;
    }
    close(): void {
      /* the test drives onclose directly */
    }
    send(): void {
      /* client events are not under test here */
    }
  }

  beforeEach(() => {
    FakeWebSocket.last = null;
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports an expired pairing when the host answers but rejects the token', async () => {
    const { client, fetchMock } = makeClient();
    TestBed.tick();
    const socket = FakeWebSocket.last;
    expect(socket).not.toBeNull();

    fetchMock.mockResolvedValue(jsonResponse({ error: 'Unauthorized' }, false, 401));
    socket?.onclose?.();

    await vi.waitFor(() => expect(client.state()).toBe('unauthorized'));
    expect(client.online()).toBe(false);
  });

  it('leaves a genuinely unreachable host as disconnected', async () => {
    const { client, fetchMock } = makeClient();
    TestBed.tick();
    const socket = FakeWebSocket.last;

    fetchMock.mockRejectedValue(new TypeError('Load failed'));
    socket?.onclose?.();

    // Wait for the probe itself (not merely any fetch) so this proves the
    // classifier ran and chose 'disconnected', rather than never running.
    await vi.waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/snapshot')),
      ).toBe(true),
    );
    await Promise.resolve();
    expect(client.state()).toBe('disconnected');
  });
});
