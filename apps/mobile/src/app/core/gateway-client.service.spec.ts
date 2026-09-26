import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import type { PairedHost } from './models';
import { MOBILE_REQUEST_TIMEOUT_MS } from './gateway-request-state';

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

describe('GatewayClient.steerInput', () => {
  beforeEach(() => vi.stubGlobal('WebSocket', class {
    close(): void { /* no network in this HTTP boundary test */ }
    send(): void { /* no network in this HTTP boundary test */ }
  }));
  afterEach(() => vi.unstubAllGlobals());
  const attachments = [{ name: 'photo.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' }];

  it('optimistically renders then reconciles steering text and attachments through the steer route', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(jsonResponse([]));
    TestBed.tick();
    fetchMock.mockClear();
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }));
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'host-message', type: 'user', timestamp: Date.now(), content: 'Change course', hasAttachments: true }]));
    const pending = client.steerInput('a', 'Change course', attachments);
    expect(client.messagesFor('a')).toEqual([expect.objectContaining({ content: 'Change course', hasAttachments: true })]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://100.64.0.1:8899/api/instances/a/steer');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: 'Change course', attachments });
    finish(jsonResponse({ ok: true }));
    await pending;
    await vi.waitFor(() => expect(client.messagesFor('a').map(message => message.id)).toEqual(['host-message']));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/input'))).toBe(false);
  });

  it('retracts the optimistic steering bubble after rejection', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Steer refused' }, false, 500));
    await expect(client.steerInput('a', 'Change course', attachments)).rejects.toThrow('Steer refused');
    expect(client.messagesFor('a')).toEqual([]);
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

  it('cancels a queued message and returns its text and attachments for the composer', async () => {
    const attachments = [{ name: 'photo.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' }];
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, message: 'never mind', attachments }));

    await expect(client.cancelQueued('a', 'q1')).resolves.toEqual({ message: 'never mind', attachments });

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

describe('GatewayClient automations', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads the safe list and sends a bounded idempotency key to run-now', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: 'daily-review', name: 'Daily review' }]));
    await expect(client.automations()).resolves.toEqual([{ id: 'daily-review', name: 'Daily review' }]);
    expect(fetchMock.mock.calls[0]![0]).toBe('http://100.64.0.1:8899/api/automations');

    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'queued', runId: 'run-1' }));
    await expect(client.runAutomation('daily/review', 'mobile-key')).resolves.toEqual({ status: 'queued', runId: 'run-1' });
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('http://100.64.0.1:8899/api/automations/daily%2Freview/run');
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ idempotencyKey: 'mobile-key' }) });
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
      client.respondFromPush(undefined, 'mac', 'a', {
        requestId: 'r1',
        decisionAction: 'allow',
        decisionScope: 'once',
      }),
    ).rejects.toThrow(/no longer paired/);

    expect(client.state()).toBe('unauthorized');
  });

  it('routes push approval by host device id when two hosts share a name', async () => {
    TestBed.resetTestingModule();
    const twin = { ...HOST, id: 'h2', host: '100.64.0.2' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({ providers: [
      { provide: HostStore, useValue: { hosts: signal([HOST, twin]), activeHost: signal(HOST) } },
    ] });
    const scopedClient = TestBed.inject(GatewayClient);

    await scopedClient.respondFromPush('h2', 'mac', 'a', {
      requestId: 'r1', decisionAction: 'allow', decisionScope: 'once',
    });

    expect(fetchMock.mock.calls[0]![0]).toBe('http://100.64.0.2:8899/api/instances/a/respond');
  });

  it('does not fall back to a same-named host when a supplied device id is unknown', async () => {
    TestBed.resetTestingModule();
    const twin = { ...HOST, id: 'h2', host: '100.64.0.2' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({ providers: [
      { provide: HostStore, useValue: { hosts: signal([HOST, twin]), activeHost: signal(HOST) } },
    ] });
    const scopedClient = TestBed.inject(GatewayClient);

    await expect(scopedClient.respondFromPush('missing-host-id', 'mac', 'a', {
      requestId: 'r1', decisionAction: 'allow', decisionScope: 'once',
    })).rejects.toThrow('not paired');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an ambiguous legacy hostname instead of choosing the first match', async () => {
    TestBed.resetTestingModule();
    const twin = { ...HOST, id: 'h2', host: '100.64.0.2' };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({ providers: [
      { provide: HostStore, useValue: { hosts: signal([HOST, twin]), activeHost: signal(HOST) } },
    ] });
    const scopedClient = TestBed.inject(GatewayClient);

    await expect(scopedClient.respondFromPush(undefined, 'mac', 'a', {
      requestId: 'r1', decisionAction: 'allow', decisionScope: 'once',
    })).rejects.toThrow('not paired');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds a stalled push quick action so the UI can recover', async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValueOnce(new Promise<Response>(() => undefined));

    const pending = client.respondFromPush('h1', undefined, 'a', {
      requestId: 'r1', decisionAction: 'allow', decisionScope: 'once',
    });
    const rejected = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(MOBILE_REQUEST_TIMEOUT_MS);

    await rejected;
    vi.useRealTimers();
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

  it('scopes quota events and authenticated reads to the active host', async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockResolvedValue(jsonResponse([])); TestBed.tick();
    const socket = FakeWebSocket.last!;
    const data = { serverTime: 1, providers: [] };
    socket.onmessage?.({ data: JSON.stringify({ type: 'quota-state', data }) } as MessageEvent);
    expect(client.quotaEvent()).toEqual({ hostId: 'h1', data });
    fetchMock.mockResolvedValueOnce(jsonResponse(data));
    await expect(client.quota()).resolves.toEqual(data);
    expect(fetchMock).toHaveBeenLastCalledWith('http://100.64.0.1:8899/api/quota', expect.objectContaining({
      method: 'GET', headers: expect.objectContaining({ authorization: 'Bearer test-token' }),
    }));
    const hosts = TestBed.inject(HostStore) as unknown as { activeHost: { set(value: PairedHost): void } };
    hosts.activeHost.set({ ...HOST, id: 'h2' }); TestBed.tick();
    expect(client.quotaEvent()).toBeNull();
    expect(socket.onmessage).toBeNull();
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
