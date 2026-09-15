import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountBindingStatus, ProviderAccountPoolPolicy, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';
import type { DesiredRuntime, Instance } from '../../../shared/types/instance.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const events = vi.hoisted(() => [] as Array<{ event: string }>);
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: (event: { event: string }) => events.push(event) }));

import { AccountFailoverCoordinator, type AccountFailoverParams } from './account-failover-coordinator';
import { ProviderAccountStore } from './provider-account-store';
import type { ProviderAccountBindingService } from './provider-account-binding-service';

function profile(id: string, priority: number): ProviderAccountProfile {
  return {
    id, provider: 'claude', label: `Label ${id}`, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

interface Harness {
  coordinator: AccountFailoverCoordinator;
  instances: Map<string, Instance>;
  applied: Array<{ id: string; desired: DesiredRuntime }>;
  resent: Array<{ id: string; prompt: string }>;
  notified: Array<{ kind: string }>;
  parked: string[];
  policy: ProviderAccountPoolPolicy;
  bindingStates: Record<string, AccountBindingStatus['state']>;
  clock: { now: number };
  quota: Record<string, { fiveHourPct: number }>;
}

function harness(overrides: Partial<ProviderAccountPoolPolicy> = {}, profiles = [profile('legacy', 0), profile('max-b', 1), profile('max-c', 2)]): Harness {
  const pools = defaultProviderAccountPools();
  pools.claude = { ...pools.claude, failoverMode: 'automatic', acknowledgedOwnershipAt: 1, switchCooldownMs: 0, ...overrides };
  const state: Harness = {
    coordinator: undefined as unknown as AccountFailoverCoordinator,
    instances: new Map(),
    applied: [],
    resent: [],
    notified: [],
    parked: [],
    policy: pools.claude,
    bindingStates: {},
    clock: { now: 10_000 },
    quota: {},
  };
  const store = new ProviderAccountStore({ read: () => ({ profiles, pools }) });
  const bindings = {
    getCached: (_provider: string, id: string) => (state.bindingStates[id] ? { state: state.bindingStates[id] } : null),
    checkBinding: async (entry: ProviderAccountProfile) => ({ state: state.bindingStates[entry.id] ?? 'authenticated' }),
  } as unknown as ProviderAccountBindingService;
  state.coordinator = new AccountFailoverCoordinator({
    store: () => store,
    bindings: () => bindings,
    getParkedProfileIds: () => state.parked,
    getQuotaEvidence: (_provider, id) => state.quota[id] ?? null,
    getInstance: (id) => state.instances.get(id),
    applyRuntimeChange: async (id, desired) => {
      await Promise.resolve();
      state.applied.push({ id, desired });
      const instance = state.instances.get(id)!;
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    },
    resendInput: (id, prompt) => state.resent.push({ id, prompt }),
    notify: (input) => state.notified.push(input),
    now: () => state.clock.now,
    sleep: async () => undefined,
  });
  return state;
}

function addInstance(h: Harness, id: string, accountProfileId?: string): void {
  h.instances.set(id, { id, provider: 'claude', status: 'idle', accountProfileId } as unknown as Instance);
}

function params(id: string, overrides: Partial<AccountFailoverParams> = {}): AccountFailoverParams {
  return {
    instanceId: id, provider: 'claude', model: null, exhaustedProfileId: 'legacy', resumeAt: 20_000,
    resumePrompt: 'keep going', reason: 'limit', ...overrides,
  };
}

beforeEach(() => {
  events.length = 0;
});

describe('AccountFailoverCoordinator', () => {
  it('switches to the next profile by priority, re-sends once and notifies once', async () => {
    const h = harness();
    addInstance(h, 'i1');
    h.parked = ['legacy'];
    const outcome = await h.coordinator.perform(params('i1'));
    expect(outcome).toMatchObject({ outcome: 'switched', toProfileId: 'max-b' });
    expect(h.applied).toEqual([{ id: 'i1', desired: expect.objectContaining({ accountProfileId: 'max-b', accountHandoffKind: 'failover' }) }]);
    expect(h.resent).toEqual([{ id: 'i1', prompt: 'keep going' }]);
    expect(h.notified).toEqual([expect.objectContaining({ kind: 'account-switched' })]);
    expect(events.map((event) => event.event)).toContain('account_failover_performed');
  });

  it('makes one switch when the same instance reports the limit twice concurrently', async () => {
    const h = harness();
    addInstance(h, 'i1');
    const [a, b] = await Promise.all([h.coordinator.perform(params('i1')), h.coordinator.perform(params('i1'))]);
    expect(a).toMatchObject({ outcome: 'switched', toProfileId: 'max-b' });
    expect(b).toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: false });
    expect(h.applied).toHaveLength(1);
    expect(h.resent).toHaveLength(1);
  });

  it('answers a late report for the profile it already left as already-moved, not cooldown, and sends nothing', async () => {
    const h = harness({ switchCooldownMs: 300_000 });
    addInstance(h, 'i1');
    const first = h.coordinator.perform(params('i1'));
    const second = h.coordinator.perform(params('i1'));
    expect(await first).toMatchObject({ outcome: 'switched', toProfileId: 'max-b' });
    expect(await second).toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: false });
    h.clock.now += 1_000;
    expect(await h.coordinator.perform(params('i1'))).toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: false });
    expect(h.applied).toHaveLength(1);
    expect(h.resent).toHaveLength(1);
  });

  it('never sends a different turn caught by the switch; it reports it as not sent', async () => {
    const h = harness({ switchCooldownMs: 300_000 });
    addInstance(h, 'i1');
    const first = h.coordinator.perform(params('i1', { resumePrompt: 'turn A' }));
    const held = h.coordinator.perform(params('i1', { resumePrompt: 'turn B' }));
    await Promise.all([first, held]);
    expect(await held).toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.applied).toHaveLength(1);
    expect(h.resent).toEqual([{ id: 'i1', prompt: 'turn A' }]);
  });

  it('does not report a turn a switch already re-sent as unsent, even after later switches', async () => {
    const h = harness({ switchCooldownMs: 0 });
    addInstance(h, 'i1');
    h.parked = ['legacy'];
    await h.coordinator.perform(params('i1', { resumePrompt: 'turn A' }));
    await h.coordinator.perform(params('i1', { exhaustedProfileId: 'max-b', resumePrompt: 'turn C' }));
    expect(h.instances.get('i1')!.accountProfileId).toBe('max-c');
    expect(await h.coordinator.perform(params('i1', { exhaustedProfileId: 'legacy', resumePrompt: 'turn A' })))
      .toEqual({ outcome: 'already-moved', toProfileId: 'max-c', turnNotSent: false });
    expect(h.resent.map((entry) => entry.prompt)).toEqual(['turn A', 'turn C']);
  });

  it('treats identical text reported well after a re-send as a new, unsent turn', async () => {
    const h = harness({ switchCooldownMs: 300_000 });
    addInstance(h, 'i1');
    await h.coordinator.perform(params('i1', { resumePrompt: 'continue' }));
    expect(await h.coordinator.perform(params('i1', { resumePrompt: 'continue' })))
      .toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: false });
    h.clock.now += 120_000;
    expect(await h.coordinator.perform(params('i1', { resumePrompt: 'continue' })))
      .toEqual({ outcome: 'already-moved', toProfileId: 'max-b', turnNotSent: true });
  });

  it('serialises decisions per provider so concurrent instances pick the same target', async () => {
    const h = harness();
    for (const id of ['i1', 'i2', 'i3']) addInstance(h, id);
    await Promise.all(['i1', 'i2', 'i3'].map((id) => h.coordinator.perform(params(id))));
    expect(new Set(h.applied.map((entry) => entry.desired.accountProfileId))).toEqual(new Set(['max-b']));
  });

  it('offers instead of switching in ask mode and before ownership is acknowledged', async () => {
    const ask = harness({ failoverMode: 'ask' });
    addInstance(ask, 'i1');
    expect(await ask.coordinator.perform(params('i1'))).toEqual({ outcome: 'offered', toProfileId: 'max-b' });
    expect(ask.applied).toEqual([]);
    expect(ask.notified).toEqual([expect.objectContaining({ kind: 'account-failover-offer' })]);

    const unacknowledged = harness({ acknowledgedOwnershipAt: null });
    addInstance(unacknowledged, 'i1');
    expect((await unacknowledged.coordinator.perform(params('i1'))).outcome).toBe('offered');
  });

  it('does nothing in off mode or without a pool', async () => {
    const off = harness({ failoverMode: 'off' });
    addInstance(off, 'i1');
    expect(await off.coordinator.perform(params('i1'))).toMatchObject({ outcome: 'not-switched', reason: 'mode-off' });
    const single = harness({}, [profile('legacy', 0)]);
    addInstance(single, 'i1');
    expect(await single.coordinator.perform(params('i1'))).toMatchObject({ outcome: 'not-switched', reason: 'no-pool' });
  });

  it('reports no candidate with named vetoes when every other profile is parked or signed out', async () => {
    const h = harness();
    addInstance(h, 'i1');
    h.parked = ['legacy', 'max-b'];
    h.bindingStates = { 'max-c': 'unauthenticated' };
    const outcome = await h.coordinator.perform(params('i1'));
    expect(outcome).toMatchObject({ outcome: 'not-switched', reason: 'no-candidate' });
    expect(events.map((event) => event.event)).toContain('account_pool_exhausted');
  });

  it('counts a second rejection in the same turn against the per-turn cap', async () => {
    const h = harness({ maxSwitchesPerTurn: 1 });
    addInstance(h, 'i1');
    h.parked = ['legacy'];
    await h.coordinator.perform(params('i1'));
    const second = await h.coordinator.perform(params('i1', { exhaustedProfileId: 'max-b' }));
    expect(second).toMatchObject({ outcome: 'not-switched', reason: 'cap-reached' });
    // A new user turn resets the cap.
    const nextTurn = await h.coordinator.perform(params('i1', { exhaustedProfileId: 'max-b', resumePrompt: 'new turn' }));
    expect(nextTurn).toMatchObject({ outcome: 'switched', toProfileId: 'max-c' });
  });

  it('honours the switch cooldown', async () => {
    const h = harness({ switchCooldownMs: 300_000 });
    addInstance(h, 'i1');
    await h.coordinator.perform(params('i1'));
    h.clock.now += 60_000;
    expect(await h.coordinator.perform(params('i1', { exhaustedProfileId: 'max-b', resumePrompt: 'another' })))
      .toMatchObject({ outcome: 'not-switched', reason: 'cooldown' });
  });

  it('gives up when the instance never settles', async () => {
    const h = harness();
    addInstance(h, 'i1');
    h.instances.get('i1')!.status = 'busy';
    const clock = h.clock;
    const coordinator = new AccountFailoverCoordinator({
      ...(h.coordinator as unknown as { deps: ConstructorParameters<typeof AccountFailoverCoordinator>[0] }).deps,
      sleep: async () => { clock.now += 1_000; },
    });
    expect(await coordinator.perform(params('i1'))).toMatchObject({ outcome: 'not-switched', reason: 'busy' });
  });

  it('pre-emptively switches only when enabled, over threshold, and onto an account under it', async () => {
    const off = harness();
    addInstance(off, 'i1');
    off.quota = { legacy: { fiveHourPct: 95 } };
    expect(off.coordinator.shouldSwitchPreemptively(params('i1', { handoffKind: 'preemptive' }))).toBe(false);

    const on = harness({ preemptive: { newSessions: true, liveSessionsAtTurnBoundary: true, thresholdPct: 90 } });
    addInstance(on, 'i1');
    on.quota = { legacy: { fiveHourPct: 80 } };
    expect(on.coordinator.shouldSwitchPreemptively(params('i1', { handoffKind: 'preemptive' }))).toBe(false);
    on.quota = { legacy: { fiveHourPct: 95 }, 'max-b': { fiveHourPct: 97 }, 'max-c': { fiveHourPct: 10 } };
    expect(on.coordinator.shouldSwitchPreemptively(params('i1', { handoffKind: 'preemptive' }))).toBe(true);
    const outcome = await on.coordinator.perform(params('i1', { handoffKind: 'preemptive' }));
    expect(outcome).toMatchObject({ outcome: 'switched', toProfileId: 'max-c' });
    expect(on.applied[0]?.desired).toMatchObject({ accountHandoffKind: 'preemptive' });
  });
});
