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
