import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import WebSocket from 'ws';
import { MOBILE_ATTENTION_LEVELS } from '../../../../packages/contracts/src/types/mobile-gateway.types';
import { createFixtureState, loadPreviewFixture } from './fixture-state.mjs';
import { createPreviewHost } from './server.mjs';
import { TranscriptStore } from '../../src/app/core/transcript-store';
import { HostStore } from '../../src/app/core/host-store';
import { pairWithHost } from '../../src/app/core/pairing';

const openHosts: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(openHosts.splice(0).map((host) => host.close()));
  TestBed.resetTestingModule();
  localStorage.clear();
  vi.unstubAllGlobals();
});

async function start(scenario = 'default') {
  const host = await createPreviewHost({ port: 0, scenario, scenarioDelayMs: 5 });
  openHosts.push(host);
  return host;
}

async function pair(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingToken: 'preview-only', label: 'Browser preview' }),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { token: string };
  return body.token;
}

function auth(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

describe('preview host gateway contract', () => {
  it.each([
    ['quota-known', 40, 'fresh', false], ['quota-unknown', null, 'fresh', false],
    ['quota-stale', 100, 'stale', false], ['quota-exhausted', 100, 'fresh', true],
    ['quota-reset', 0, 'fresh', false], ['quota-multi-window', 40, 'fresh', false],
  ])('serves the authenticated %s usage fixture', async (scenario, percent, freshness, exhausted) => {
    const host = await start(String(scenario));
    expect((await fetch(`${host.baseUrl}/api/quota`)).status).toBe(401);
    const token = await pair(host.baseUrl);
    const response = await fetch(`${host.baseUrl}/api/quota`, { headers: auth(token) });
    expect(response.status).toBe(200);
    const state = await response.json() as { providers: Array<{ freshness: string; exhausted: boolean; windows: Array<{ percentUsed: number | null }> }> };
    expect(state.providers[0]).toMatchObject({ freshness, exhausted });
    expect(state.providers[0].windows[0].percentUsed).toBe(percent);
    if (scenario === 'quota-multi-window') expect(state.providers[0].windows).toHaveLength(2);
  });

  it('pairs two preview servers into the real HostStore without identity replacement', async () => {
    const first = await createPreviewHost({ port: 0, hostName: 'Studio A' });
    const second = await createPreviewHost({ port: 0, hostName: 'Studio B', scenario: 'empty-inbox' });
    openHosts.push(first, second);
    const store = TestBed.inject(HostStore);
    const runtimeFetch = globalThis.fetch.bind(globalThis);
    // jsdom installs its own AbortSignal, which Node's real fetch rejects. The
    // production pairWithHost path is retained; only this test bridge omits the
    // incompatible signal while exercising the real HTTP servers.
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      runtimeFetch(input, { ...init, signal: undefined }));
    const pairedIds: string[] = [];

    for (const host of [first, second]) {
      const paired = await pairWithHost('127.0.0.1', host.port, 'preview-only', 'Browser preview');
      pairedIds.push(paired.deviceId);
      await store.addHost({
        id: paired.deviceId,
        name: paired.hostName,
        host: '127.0.0.1',
        port: host.port,
        token: paired.token,
        addedAt: host.port,
      });
      await store.setActive(paired.deviceId);
    }

    expect(store.hosts()).toHaveLength(2);
    expect(new Set(store.hosts().map((host) => host.id)).size).toBe(2);
    expect(store.hosts().map((host) => host.name)).toEqual(['Studio A', 'Studio B']);
    await expect(pairWithHost('127.0.0.1', first.port, 'preview-only', 'Browser preview'))
      .resolves.toMatchObject({ deviceId: pairedIds[0] });
  });

  it('provides deterministic cross-host inbox, empty, offline, unauthorized, and stale-probe fixtures', async () => {
    const first = await createPreviewHost({ port: 0, scenario: 'default', hostName: 'Studio A', scenarioDelayMs: 5 });
    const second = await createPreviewHost({ port: 0, scenario: 'empty-inbox', hostName: 'Studio B', scenarioDelayMs: 5 });
    openHosts.push(first, second);
    const firstToken = await pair(first.baseUrl);
    const secondToken = await pair(second.baseUrl);
    const firstSnapshot = await fetch(`${first.baseUrl}/api/snapshot`, { headers: auth(firstToken) }).then((res) => res.json()) as { hostName: string; prompts: unknown[]; instances: Array<{ hasUnreadCompletion: boolean }> };
    const secondSnapshot = await fetch(`${second.baseUrl}/api/snapshot`, { headers: auth(secondToken) }).then((res) => res.json()) as { hostName: string; prompts: unknown[]; instances: Array<{ hasUnreadCompletion: boolean }> };
    expect([firstSnapshot.hostName, secondSnapshot.hostName]).toEqual(['Studio A', 'Studio B']);
    expect(firstSnapshot.prompts.length).toBeGreaterThan(0);
    expect(firstSnapshot.instances.some((instance) => instance.hasUnreadCompletion)).toBe(true);
    expect(secondSnapshot.prompts).toEqual([]);
    expect(secondSnapshot.instances.every((instance) => !instance.hasUnreadCompletion)).toBe(true);

    const offline = await start('offline');
    expect((await fetch(`${offline.baseUrl}/health`)).status).toBe(503);
    const unauthorized = await start('401');
    const unauthorizedToken = await pair(unauthorized.baseUrl);
    expect((await fetch(`${unauthorized.baseUrl}/api/prompts`, { headers: auth(unauthorizedToken) })).status).toBe(401);

    const stale = await start('stale-probe');
    const staleToken = await pair(stale.baseUrl);
    const startedAt = Date.now();
    const staleResponse = await fetch(`${stale.baseUrl}/api/snapshot`, { headers: auth(staleToken) });
    expect(staleResponse.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
  });

  it('keeps fixture and generated attention levels inside the canonical contract', async () => {
    const fixture = await loadPreviewFixture();
    const state = createFixtureState(fixture);
    const allowed = new Set<string>(MOBILE_ATTENTION_LEVELS);

    expect(state.instances().every((instance) => allowed.has(instance.attentionLevel))).toBe(true);
    const created = state.createInstance({ workingDirectory: '/preview/new-session' });
    expect(allowed.has(created.attentionLevel)).toBe(true);
  });

  it('serves pairing, snapshot, messages, prompts, queue, models, history, and pause', async () => {
    const host = await start();
    const token = await pair(host.baseUrl);
    const headers = auth(token);

    const snapshot = await fetch(`${host.baseUrl}/api/snapshot`, { headers }).then((res) => res.json()) as {
      instances: Array<{ id: string }>;
      prompts: unknown[];
    };
    expect(snapshot.instances.map((instance) => instance.id)).toContain('preview-active');
    expect(snapshot.prompts).toHaveLength(1);
    const prompts = await fetch(`${host.baseUrl}/api/prompts`, { headers }).then((res) => res.json()) as unknown[];
    expect(prompts).toHaveLength(1);

    const messages = await fetch(`${host.baseUrl}/api/instances/preview-active/messages`, { headers })
      .then((res) => res.json()) as Array<{ seq: number }>;
    expect(messages.length).toBeGreaterThan(2);
    expect(messages.at(-1)?.seq).toBe(messages.length - 1);

    const fullWithCursor = await fetch(
      `${host.baseUrl}/api/instances/preview-active/messages?withCursor=1`,
      { headers },
    ).then((res) => res.json()) as {
      messages: Array<{ seq: number }>;
      meta: { maxSeq: number; bufferGeneration: number; adapterGeneration: number };
    };
    expect(fullWithCursor.messages).toEqual(messages);
    expect(fullWithCursor.meta).toMatchObject({
      maxSeq: messages.length - 1, bufferGeneration: 0, adapterGeneration: 1,
    });

    const resumed = await fetch(`${host.baseUrl}/api/instances/preview-active/messages?fromSeq=0`, { headers })
      .then((res) => res.json()) as { messages: Array<{ seq: number }>; meta: { fromSeq: number; maxSeq: number } };
    expect(resumed.messages[0]?.seq).toBe(1);
    expect(resumed.meta).toMatchObject({ fromSeq: 0, maxSeq: messages.length - 1 });

    const inclusive = await fetch(
      `${host.baseUrl}/api/instances/preview-active/messages?fromSeq=0&includeFrom=1`,
      { headers },
    ).then((res) => res.json()) as { messages: Array<{ seq: number }> };
    expect(inclusive.messages[0]?.seq).toBe(0);

    const models = await fetch(`${host.baseUrl}/api/models`, { headers }).then((res) => res.json()) as Record<string, unknown[]>;
    expect(models['codex']?.length).toBeGreaterThan(0);
    const history = await fetch(`${host.baseUrl}/api/history`, { headers }).then((res) => res.json()) as Array<{ id: string }>;
    expect(history).toHaveLength(2);
    const historyMessages = await fetch(`${host.baseUrl}/api/history/${encodeURIComponent(history[0].id)}/messages`, { headers })
      .then((res) => res.json()) as unknown[];
    expect(historyMessages.length).toBeGreaterThan(0);

    const cancelled = await fetch(`${host.baseUrl}/api/instances/preview-busy/queue/preview-queue-1`, {
      method: 'DELETE', headers,
    }).then((res) => res.json()) as { message: string };
    expect(cancelled.message).toContain('queued');

    const paused = await fetch(`${host.baseUrl}/api/pause`, {
      method: 'POST', headers, body: JSON.stringify({ paused: true }),
    }).then((res) => res.json()) as { isPaused: boolean };
    expect(paused.isPaused).toBe(true);
  });

  it('serves safe automations and idempotently starts a run through the normal snapshot path', async () => {
    const host = await start();
    expect((await fetch(`${host.baseUrl}/api/automations`)).status).toBe(401);
    const token = await pair(host.baseUrl);
    const headers = auth(token);
    const listed = await fetch(`${host.baseUrl}/api/automations`, { headers }).then(response => response.json()) as Array<Record<string, unknown>>;
    expect(listed[0]).toMatchObject({ id: 'preview-daily-review', name: 'Daily review', model: 'gpt-preview' });
    expect(JSON.stringify(listed)).not.toContain('prompt');
    expect(JSON.stringify(listed)).not.toContain('workingDirectory');

    const request = { method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'mobile-preview-1' }) };
    const first = await fetch(`${host.baseUrl}/api/automations/preview-daily-review/run`, request).then(response => response.json());
    const duplicate = await fetch(`${host.baseUrl}/api/automations/preview-daily-review/run`, request).then(response => response.json());
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ status: 'started' });
    const snapshot = await fetch(`${host.baseUrl}/api/snapshot`, { headers }).then(response => response.json()) as { instances: Array<{ workingDirectory: string }> };
    expect(snapshot.instances.filter(instance => instance.workingDirectory === '/preview/automations')).toHaveLength(1);
  });

  it('switches the active scenario from the browser query flag', async () => {
    const host = await start();
    await fetch(`${host.baseUrl}/?scenario=transcript-1000`);
    const token = await pair(host.baseUrl);
    const messages = await fetch(`${host.baseUrl}/api/instances/preview-active/messages`, {
      headers: auth(token),
    }).then((res) => res.json()) as unknown[];
    expect(messages).toHaveLength(1000);

    await fetch(`${host.baseUrl}/?scenario=401`);
    const unauthorized = await fetch(`${host.baseUrl}/api/snapshot`, { headers: auth(token) });
    expect(unauthorized.status).toBe(401);
  });
});

describe('preview host WebSocket scenarios', () => {
  it('keeps HTTP and no-gap WebSocket cursors in one generation', async () => {
    const host = await start('streaming');
    const token = await pair(host.baseUrl);
    const headers = auth(token);
    const store = new TranscriptStore();
    const full = await fetch(
      `${host.baseUrl}/api/instances/preview-active/messages?withCursor=1`,
      { headers },
    ).then((response) => response.json());
    await store.loadMessages('preview-active', async () => full as never, () => true);
    await fetch(`${host.baseUrl}/__preview/metrics`, { method: 'DELETE' });

    const frames = await new Promise<Array<{ type: string; data?: Record<string, unknown> }>>((resolve, reject) => {
      const output: Array<{ type: string; data?: Record<string, unknown> }> = [];
      const socket = new WebSocket(`${host.wsUrl}/ws?token=${encodeURIComponent(token)}`);
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString()) as { type: string; data?: Record<string, unknown> };
        if (frame.type !== 'instance-output') return;
        output.push(frame);
        if (output.length === 2) { socket.close(); resolve(output); }
      });
      socket.on('error', reject);
    });

    for (const frame of frames) {
      const data = frame.data as {
        seq: number; streamSeq: number; bufferIndex: number; bufferGeneration: number;
        adapterGeneration: number; message: never;
      };
      expect(store.applyOutput('preview-active', {
        legacySeq: data.seq, streamSeq: data.streamSeq, bufferIndex: data.bufferIndex,
        bufferGeneration: data.bufferGeneration, adapterGeneration: data.adapterGeneration,
      }, data.message)).toBeNull();
    }
    const metrics = await fetch(`${host.baseUrl}/__preview/metrics`).then((response) => response.json()) as {
      requests: Record<string, number>;
    };
    expect(metrics.requests['/api/instances/preview-active/messages']).toBeUndefined();
  });

  async function framesFor(scenario: string): Promise<{
    frames: Array<{ type: string; data?: { seq?: number; streamSeq?: number; bufferIndex?: number } }>;
    closed: boolean;
  }> {
    const host = await start(scenario);
    const token = await pair(host.baseUrl);
    const frames: Array<{ type: string; data?: { seq?: number; streamSeq?: number; bufferIndex?: number } }> = [];
    let closed = false;
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`${host.wsUrl}/ws?token=${encodeURIComponent(token)}`);
      const timeout = setTimeout(() => { socket.close(); resolve(); }, 250);
      socket.on('message', (raw) => {
        frames.push(JSON.parse(raw.toString()) as { type: string; data?: { seq?: number; streamSeq?: number; bufferIndex?: number } });
        if (scenario === 'streaming' && frames.length >= 3) {
          clearTimeout(timeout); socket.close(); resolve();
        }
        if (scenario === 'gap' && frames.length >= 3) {
          clearTimeout(timeout); socket.close(); resolve();
        }
      });
      socket.on('close', () => {
        closed = true;
        if (scenario === 'disconnect') { clearTimeout(timeout); resolve(); }
      });
      socket.on('error', reject);
    });
    return { frames, closed };
  }

  it('streams sequential output frames', async () => {
    const result = await framesFor('streaming');
    expect(result.frames[0]?.type).toBe('snapshot');
    expect(result.frames.filter((frame) => frame.type === 'instance-output').map((frame) => frame.data?.seq))
      .toEqual([4, 9]);
    expect(result.frames.filter((frame) => frame.type === 'instance-output').map((frame) => frame.data?.streamSeq))
      .toEqual([0, 1]);
    expect(result.frames.filter((frame) => frame.type === 'instance-output').map((frame) => frame.data?.bufferIndex))
      .toEqual([4, 5]);
  });

  it('scripts an output sequence gap', async () => {
    const result = await framesFor('gap');
    expect(result.frames.filter((frame) => frame.type === 'instance-output').map((frame) => frame.data?.seq))
      .toEqual([1, 3]);
    expect(result.frames.filter((frame) => frame.type === 'instance-output').map((frame) => frame.data?.streamSeq))
      .toEqual([0, 2]);
  });

  it('answers application-level liveness pings', async () => {
    const host = await start();
    const token = await pair(host.baseUrl);
    const pong = await new Promise<{ type: string; data: { sentAt: number } }>((resolve, reject) => {
      const socket = new WebSocket(`${host.wsUrl}/ws?token=${encodeURIComponent(token)}`);
      socket.on('open', () => socket.send(JSON.stringify({ type: 'ping', sentAt: 123 })));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'pong') { socket.close(); resolve(frame); }
      });
      socket.on('error', reject);
    });
    expect(pong).toEqual({ type: 'pong', data: { sentAt: 123 } });
  });

  it('scripts a server disconnect after the initial snapshot', async () => {
    const result = await framesFor('disconnect');
    expect(result.frames[0]?.type).toBe('snapshot');
    expect(result.closed).toBe(true);
  });
});
