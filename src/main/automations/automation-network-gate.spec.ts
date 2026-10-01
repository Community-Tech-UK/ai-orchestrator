import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { NetworkReadyResult } from '../runtime/network-readiness';
import { createAutomationNetworkGate, needsNetworkGate } from './automation-network-gate';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function run(overrides: Partial<AutomationRun> = {}, action: Record<string, unknown> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    status: 'running',
    trigger: 'scheduled',
    attempt: 1,
    maxAttempts: 3,
    configSnapshot: { action: { prompt: 'p', workingDirectory: '/tmp', ...action } },
    ...overrides,
  } as AutomationRun;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const resolver = () => Promise.resolve({});

describe('needsNetworkGate', () => {
  it('gates the unattended triggers', () => {
    expect(needsNetworkGate(run({ trigger: 'scheduled' }))).toBe(true);
    expect(needsNetworkGate(run({ trigger: 'catchUp' }))).toBe(true);
    expect(needsNetworkGate(run({ trigger: 'providerRuntime' }))).toBe(true);
  });

  it('does not gate a first attempt someone is waiting on', () => {
    expect(needsNetworkGate(run({ trigger: 'manual' }))).toBe(false);
    expect(needsNetworkGate(run({ trigger: 'webhook' }))).toBe(false);
    expect(needsNetworkGate(run({ trigger: 'channel' }))).toBe(false);
  });

  it('gates every retry, whatever triggered the first attempt', () => {
    expect(needsNetworkGate(run({ trigger: 'manual', attempt: 2 }))).toBe(true);
  });

  it('skips runs pinned to a worker node, which has its own network', () => {
    expect(needsNetworkGate(run({}, { forceNodeId: 'windows-pc' }))).toBe(false);
  });

  it('gates provider-limit resume system actions, which re-send to the provider', () => {
    expect(needsNetworkGate(run({}, {
      systemAction: { type: 'loopProviderLimitResume', loopRunId: 'loop-1' },
    }))).toBe(true);
  });
});

describe('createAutomationNetworkGate', () => {
  const liveStore = (status: AutomationRun['status'] | null = 'running') => ({
    getRun: vi.fn(() => (status ? run({ status }) : null)),
  });

  it('dispatches inline without probing when the run is not gated', async () => {
    const probe = vi.fn();
    const dispatch = vi.fn(async () => undefined);
    const gate = createAutomationNetworkGate({ resolver: () => resolver, probe });

    await gate(run({ trigger: 'manual' }), liveStore(), dispatch);

    expect(dispatch).toHaveBeenCalledOnce();
    expect(probe).not.toHaveBeenCalled();
  });

  it('dispatches inline when no resolver exists (fail open)', async () => {
    const dispatch = vi.fn(async () => undefined);
    const gate = createAutomationNetworkGate({ resolver: () => null });

    await gate(run(), liveStore(), dispatch);

    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('dispatches inline and awaits it when the network is up', async () => {
    const order: string[] = [];
    const gate = createAutomationNetworkGate({ resolver: () => resolver, probe: async () => true });

    await gate(run(), liveStore(), async () => { order.push('dispatch'); });
    order.push('returned');

    expect(order).toEqual(['dispatch', 'returned']);
  });

  it('returns without dispatching while offline, then dispatches once the network returns', async () => {
    const waited = deferred<NetworkReadyResult>();
    const dispatch = vi.fn(async () => undefined);
    const store = liveStore();
    const gate = createAutomationNetworkGate({
      resolver: () => resolver,
      probe: async () => false,
      wait: () => waited.promise,
    });

    await gate(run(), store, dispatch);
    expect(dispatch).not.toHaveBeenCalled();

    waited.resolve({ ready: true, waitedMs: 180_000 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    expect(store.getRun).toHaveBeenCalledWith('run-1');
  });

  it('still dispatches when the wait gives up, so normal failure handling applies', async () => {
    const dispatch = vi.fn(async () => undefined);
    const gate = createAutomationNetworkGate({
      resolver: () => resolver,
      probe: async () => false,
      wait: async () => ({ ready: false, waitedMs: 600_000 }),
    });

    await gate(run(), liveStore(), dispatch);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  });

  it.each([
    ['terminalized', 'failed' as const],
    ['deleted', null],
  ])('does not dispatch a run that was %s during the wait', async (_label, status) => {
    const dispatch = vi.fn(async () => undefined);
    const store = liveStore(status);
    const gate = createAutomationNetworkGate({
      resolver: () => resolver,
      probe: async () => false,
      wait: async () => ({ ready: true, waitedMs: 1 }),
    });

    await gate(run(), store, dispatch);

    await vi.waitFor(() => expect(store.getRun).toHaveBeenCalled());
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('shares one probe between concurrent callers', async () => {
    let answer!: (reachable: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((r) => { answer = r; }));
    const gate = createAutomationNetworkGate({ resolver: () => resolver, probe });
    const dispatchA = vi.fn(async () => undefined);
    const dispatchB = vi.fn(async () => undefined);

    const a = gate(run({ id: 'run-a' }), liveStore(), dispatchA);
    const b = gate(run({ id: 'run-b' }), liveStore(), dispatchB);
    answer(true);
    await Promise.all([a, b]);

    expect(probe).toHaveBeenCalledOnce();
    expect(dispatchA).toHaveBeenCalledOnce();
    expect(dispatchB).toHaveBeenCalledOnce();
  });

  it('joins a known outage without probing again, then probes afresh once it ends', async () => {
    const waited = deferred<NetworkReadyResult>();
    const probe = vi.fn(async () => false);
    const wait = vi.fn(() => waited.promise);
    const gate = createAutomationNetworkGate({ resolver: () => resolver, probe, wait });
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);

    await gate(run({ id: 'run-a' }), liveStore(), first);
    await gate(run({ id: 'run-b' }), liveStore(), second);
    expect(probe).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledOnce();

    waited.resolve({ ready: true, waitedMs: 60_000 });
    await vi.waitFor(() => {
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
    });

    probe.mockResolvedValue(true);
    const third = vi.fn(async () => undefined);
    await gate(run({ id: 'run-c' }), liveStore(), third);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(third).toHaveBeenCalledOnce();
  });

  it('contains a deferred dispatch that throws', async () => {
    const dispatch = vi.fn(async () => { throw new Error('spawn blew up'); });
    const gate = createAutomationNetworkGate({
      resolver: () => resolver,
      probe: async () => false,
      wait: async () => ({ ready: true, waitedMs: 1 }),
    });

    await expect(gate(run(), liveStore(), dispatch)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
  });
});
