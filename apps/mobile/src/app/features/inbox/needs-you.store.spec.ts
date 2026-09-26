import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient, type ConnectionState } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobilePromptDto, MobileSnapshot, PairedHost } from '../../core/models';
import {
  HOST_ATTENTION_PROBE_ENVIRONMENT,
  NeedsYouStore,
  type HostAttentionProbeEnvironment,
} from './needs-you.store';

const HOST_A: PairedHost = {
  id: 'host-a', name: 'Studio', host: 'a.example.test', port: 4879,
  token: 'PLACEHOLDER_A', addedAt: 1,
};
const HOST_B: PairedHost = {
  id: 'host-b', name: 'Studio', host: 'b.example.test', port: 4879,
  token: 'PLACEHOLDER_B', addedAt: 2,
};

function prompt(instanceId: string, suffix: string): MobilePromptDto {
  return {
    id: `prompt-${suffix}`, instanceId, requestId: `request-${suffix}`,
    kind: 'permission', title: `Review ${suffix}`, message: `Approve ${suffix}`, createdAt: 10,
  };
}

function snapshot(hostName: string, instanceId: string, unread = false): MobileSnapshot {
  return {
    hostName, serverTime: 1, projects: [], prompts: [],
    pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 1 },
    instances: [{
      id: instanceId, displayName: `Session ${instanceId}`, status: 'idle', provider: 'codex',
      workingDirectory: `/work/${instanceId}`, projectName: instanceId, createdAt: 1,
      lastActivity: 20, pendingApprovalCount: 0, hasUnreadCompletion: unread,
    }],
  };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status, headers: { 'content-type': 'application/json' },
  });
}

function setup(options: {
  hosts?: PairedHost[];
  fetch?: HostAttentionProbeEnvironment['fetch'];
  activeSnapshot?: MobileSnapshot;
  activePrompts?: MobilePromptDto[];
} = {}) {
  const hosts = signal(options.hosts ?? [HOST_A, HOST_B]);
  const activeId = signal<string | null>(HOST_A.id);
  const activeHost = () => hosts().find((host) => host.id === activeId()) ?? null;
  const dataHostId = signal<string | null>(HOST_A.id);
  const state = signal<ConnectionState>('connected');
  const activeSnapshot = signal<MobileSnapshot | null>(options.activeSnapshot ?? snapshot(HOST_A.name, 'active'));
  const activePrompts = signal(options.activePrompts ?? []);
  const setActive = vi.fn(async (id: string) => activeId.set(id));
  const navigate = vi.fn().mockResolvedValue(true);
  let foregroundListener: ((foreground: boolean) => void) | null = null;
  const fetch = vi.fn(options.fetch ?? (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/health')) return json(200, { ok: true });
    if (url.endsWith('/api/prompts')) return json(200, [prompt('remote', 'remote')]);
    return json(200, snapshot(HOST_B.name, 'remote', true));
  }));
  const environment: HostAttentionProbeEnvironment = {
    fetch,
    subscribeForeground: (listener) => { foregroundListener = listener; return () => undefined; },
  };
  const reconnect = vi.fn();

  TestBed.configureTestingModule({ providers: [
    { provide: HostStore, useValue: { hosts, activeId, activeHost, setActive } },
    { provide: GatewayClient, useValue: {
      dataHostId, state, snapshot: activeSnapshot, prompts: activePrompts, reconnect,
    } },
    { provide: Router, useValue: { navigate } },
    { provide: HOST_ATTENTION_PROBE_ENVIRONMENT, useValue: environment },
  ] });
  const store = TestBed.inject(NeedsYouStore);
  store.init();
  TestBed.tick();
  return {
    store, hosts, activeId, dataHostId, state, activeSnapshot, activePrompts,
    setActive, navigate, fetch, reconnect,
    setForeground: (foreground: boolean) => foregroundListener?.(foreground),
  };
}

async function runImmediateProbe(): Promise<void> {
  TestBed.tick();
  await vi.advanceTimersByTimeAsync(0);
  TestBed.tick();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  TestBed.resetTestingModule();
  vi.useRealTimers();
});

describe('NeedsYouStore cross-host probes', () => {
  it('probes only non-active hosts immediately and every 60 seconds without touching the active socket', async () => {
    const { store, fetch, reconnect, activeId, dataHostId } = setup();
    await runImmediateProbe();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      'http://b.example.test:4879/health',
      'http://b.example.test:4879/api/prompts',
      'http://b.example.test:4879/api/snapshot',
    ]);
    expect(fetch.mock.calls[0][1]?.headers).toBeUndefined();
    expect(fetch.mock.calls[1][1]?.headers).toEqual({ authorization: 'Bearer PLACEHOLDER_B' });
    expect(store.items().map((item) => item.kind).sort()).toEqual(['completion', 'prompt']);
    expect(reconnect).not.toHaveBeenCalled();
    expect(activeId()).toBe(HOST_A.id);
    expect(dataHostId()).toBe(HOST_A.id);

    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('stops all retries in the background, resumes immediately, and caps failure backoff', async () => {
    const { fetch, setForeground } = setup({ fetch: async () => { throw new Error('offline'); } });
    await runImmediateProbe();
    expect(fetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(3);

    setForeground(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    setForeground(true);
    await runImmediateProbe();
    expect(fetch).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(240_000);
    await vi.advanceTimersByTimeAsync(299_999);
    const beforeCap = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(beforeCap + 1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetch).toHaveBeenCalledTimes(beforeCap + 2);
  });

  it('times out a hanging probe and reports the host offline without retaining attention', async () => {
    const { store } = setup({ fetch: (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    TestBed.tick();
    expect(store.stateFor(HOST_B.id)).toBe('offline');
    expect(store.items()).toEqual([]);
  });

  it('distinguishes rejected credentials from network failure and never keeps failed data live', async () => {
    let unauthorized = true;
    const { store } = setup({ fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) return json(200, { ok: true });
      if (unauthorized) return json(401, { error: 'Unauthorized' });
      throw new Error('unreachable');
    } });
    await runImmediateProbe();
    expect(store.stateFor(HOST_B.id)).toBe('unauthorized');
    expect(store.items()).toEqual([]);

    unauthorized = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.stateFor(HOST_B.id)).toBe('offline');
    expect(store.items()).toEqual([]);
  });

  it.each(['unauthorized-first', 'network-first']) (
    'gives unauthorized precedence when the sibling attention request fails (%s)',
    async (order) => {
      let resolveUnauthorized!: (response: Response) => void;
      let rejectNetwork!: (error: Error) => void;
      const unauthorized = new Promise<Response>((resolve) => { resolveUnauthorized = resolve; });
      const network = new Promise<Response>((_resolve, reject) => { rejectNetwork = reject; });
      const { store } = setup({ fetch: async (input) => {
        const url = String(input);
        if (url.endsWith('/health')) return json(200, { ok: true });
        return url.endsWith('/api/prompts') ? unauthorized : network;
      } });
      await vi.advanceTimersByTimeAsync(0);

      if (order === 'unauthorized-first') {
        resolveUnauthorized(json(401, { error: 'Unauthorized' }));
        await Promise.resolve();
        rejectNetwork(new Error('snapshot failed'));
      } else {
        rejectNetwork(new Error('snapshot failed'));
        await Promise.resolve();
        resolveUnauthorized(json(401, { error: 'Unauthorized' }));
      }
      await Promise.allSettled([unauthorized, network]);
      await Promise.resolve(); await Promise.resolve();

      expect(store.stateFor(HOST_B.id)).toBe('unauthorized');
      expect(store.items()).toEqual([]);
    },
  );

  it.each([null, {}])('fails closed for malformed snapshot instance %#', async (malformed) => {
    const { store } = setup({ fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) return json(200, { ok: true });
      if (url.endsWith('/api/prompts')) return json(200, []);
      return json(200, { hostName: HOST_B.name, instances: [malformed] });
    } });
    await runImmediateProbe();

    expect(() => store.items()).not.toThrow();
    expect(store.stateFor(HOST_B.id)).toBe('offline');
    expect(store.items()).toEqual([]);
  });

  it('drops stale in-flight results after host removal or host selection changes', async () => {
    let resolvePrompts!: (response: Response) => void;
    let resolveSnapshot!: (response: Response) => void;
    const { store, hosts, activeId } = setup({ fetch: async (input) => {
      const url = String(input);
      if (url.endsWith('/health')) return json(200, { ok: true });
      if (url.endsWith('/api/prompts')) return new Promise((resolve) => { resolvePrompts = resolve; });
      return new Promise((resolve) => { resolveSnapshot = resolve; });
    } });
    await vi.advanceTimersByTimeAsync(0);
    hosts.set([HOST_A]);
    TestBed.tick();
    resolvePrompts(json(200, [prompt('removed', 'removed')]));
    resolveSnapshot(json(200, snapshot(HOST_B.name, 'removed', true)));
    await Promise.resolve(); await Promise.resolve();
    expect(store.items()).toEqual([]);
    expect(store.stateFor(HOST_B.id)).toBe('checking');

    hosts.set([HOST_A, HOST_B]);
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    activeId.set(HOST_B.id);
    TestBed.tick();
    expect(store.items()).toEqual([]);
  });

  it('routes duplicate host names by stable ID and leaves completion unread until the host clears it', async () => {
    const active = snapshot(HOST_A.name, 'done', true);
    const { store, setActive, navigate, activeSnapshot } = setup({ activeSnapshot: active });
    await runImmediateProbe();
    const localCompletion = store.items().find((item) => item.hostId === HOST_A.id && item.kind === 'completion');
    expect(localCompletion).toBeDefined();
    await store.open(localCompletion!);
    expect(store.items()).toContain(localCompletion);
    activeSnapshot.set({ ...active, instances: [{ ...active.instances[0], hasUnreadCompletion: false }] });
    expect(store.items().some((item) => item.hostId === HOST_A.id && item.kind === 'completion')).toBe(false);

    const remote = store.items().find((item) => item.hostId === HOST_B.id && item.kind === 'prompt');
    expect(remote?.hostName).toBe('Studio');
    await store.open(remote!);
    expect(setActive).toHaveBeenCalledWith(HOST_B.id);
    expect(navigate).toHaveBeenLastCalledWith(['/projects', '/work/remote', 'sessions', 'remote']);
  });
});
