import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import { defaultProviderAccountPools, type AccountFailoverMode, type ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { ProviderLimitLedger, createProviderLimitLedgerSchema, type ProviderLimitEvent } from '../core/system/provider-limit-ledger';
import type { SqliteDriver } from '../db/sqlite-driver';
import { AccountFailoverCoordinator } from '../providers/account-pool/account-failover-coordinator';
import type { ProviderAccountBindingService } from '../providers/account-pool/provider-account-binding-service';
import type { AccountQuotaEvidence } from '../providers/account-pool/provider-account-selector';
import { ProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { parseInternalInputEnvelope } from './internal-input-provenance';
import { EARLY_RESUME_PROBE_MS, InstanceProviderLimitHandler, type ProviderLimitTurnOutcome } from './instance-provider-limit-handler';
import type { InstanceProviderLimitResumeRequest } from './instance-provider-limit-resume-scheduler';
import { attachUsageOverageStopGuard, configureUsageOverageStop, resetUsageOverageStopForTesting } from './instance-usage-overage-wiring';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../providers/account-pool/provider-account-events', () => ({ emitProviderAccountEvent: () => undefined }));

interface Options {
  mode?: AccountFailoverMode;
  autoResume?: boolean;
  enabled?: boolean;
  signedIn?: boolean;
  quota?: AccountQuotaEvidence;
  freshQuota?: AccountQuotaEvidence;
  apply?: () => Promise<void>;
  probe?: () => Promise<ProviderQuotaSnapshot | null>;
  snapshot?: () => ProviderQuotaSnapshot | null;
  refresh?: () => Promise<void>;
  notify?: () => void;
}

const cleanup: Array<() => void> = [];
const paidOnly: AccountQuotaEvidence = { weeklyPct: 100, usable: true, creditsOnly: true };

function setup(options: Options = {}) {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  createProviderLimitLedgerSchema(db);
  const ledger = new ProviderLimitLedger(db);
  const handler = new InstanceProviderLimitHandler();
  const profiles: ProviderAccountProfile[] = ['legacy', 'alternative'].map((id, priority) => ({
    id, provider: 'claude', label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: id === 'legacy' || options.enabled !== false, automationPolicy: 'allow-routed',
    isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  }));
  const pools = defaultProviderAccountPools();
  pools.claude = { ...pools.claude, failoverMode: options.mode ?? 'automatic', acknowledgedOwnershipAt: 1 };
  const store = new ProviderAccountStore({ read: () => ({ profiles, pools }) });
  const instance = { id: 'session', provider: 'claude', accountProfileId: 'legacy', status: 'busy' } as Instance;
  const state = {
    quota: options.quota ?? { weeklyPct: 10, usable: true },
    wait: null as InstanceWaitReason | null,
    applyCount: 0,
    limitAtApply: null as ProviderLimitEvent | null,
    sent: [] as Array<{ profileId: string | null | undefined; prompt: string }>,
    gates: [] as ProviderLimitTurnOutcome[],
    notices: [] as Array<{ content: string; metadata: Record<string, unknown> }>,
    notifications: [] as string[],
    schedules: [] as InstanceProviderLimitResumeRequest[],
    stops: [] as ProviderLimitTurnOutcome[],
    events: [] as string[],
  };
  const sourceLimit = () => ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'legacy' });
  const resendInput = (_id: string, prompt: string): void => {
    const gate = handler.maybeParkKnown({
      instanceId: instance.id, provider: 'claude', model: null, accountProfileId: instance.accountProfileId,
      resumePrompt: prompt, reason: 'pre-send check',
    });
    state.gates.push(gate);
    if (gate === 'skipped') state.sent.push({ profileId: instance.accountProfileId, prompt });
  };
  const bindingState = options.signedIn === false ? 'unauthenticated' : 'authenticated';
  const bindings = {
    getCached: () => ({ state: bindingState }),
    checkBinding: async () => ({ state: bindingState }),
  } as unknown as ProviderAccountBindingService;
  const coordinator = new AccountFailoverCoordinator({
    store: () => store,
    bindings: () => bindings,
    getParkedProfileIds: (provider, model) => ledger.getParkedProfileIds({ provider, model }),
    getParkedSince: (provider, model) => ledger.getParkedSince({ provider, model }),
    getQuotaEvidence: (_provider, id) => id === 'alternative' ? state.quota : null,
    refreshQuotaEvidence: async () => {
      await options.refresh?.();
      if (options.freshQuota) state.quota = options.freshQuota;
    },
    getInstance: () => instance,
    applyRuntimeChange: async (_id, desired) => {
      state.events.push('apply');
      state.applyCount += 1;
      state.limitAtApply = sourceLimit();
      await options.apply?.();
      instance.accountProfileId = desired.accountProfileId;
      return instance;
    },
    resendInput,
    notify: (input) => { state.notifications.push(input.kind); options.notify?.(); },
  });
  handler.configure({
    isEnabled: () => options.autoResume !== false,
    setWaitReason: (_id, wait) => { state.wait = wait; },
    resendInput,
    getQuotaSnapshot: options.snapshot ?? (() => null),
    probeQuotaSnapshot: options.probe,
    providerLimitLedger: ledger,
    accountFailover: coordinator,
    getWorkspaceCwd: () => '/synthetic-workspace',
    getProviderModel: () => ({ provider: 'claude', model: null, accountProfileId: instance.accountProfileId }),
    emitSystemMessage: (_id, content, metadata) => { state.notices.push({ content, metadata }); },
    scheduleResume: ({ request }) => {
      state.schedules.push(request);
      return () => undefined;
    },
  });
  configureUsageOverageStop({
    getAllowOverageSetting: () => false,
    interruptInstance: () => {
      state.events.push('interrupt');
      instance.status = 'idle';
      return true;
    },
    holdOnUsageLimit: (instanceId, signal) => {
      state.stops.push(handler.maybeParkOnUsageLimit({ instanceId, ...signal }));
    },
  });
  const adapter = new EventEmitter();
  const detach = attachUsageOverageStopGuard(adapter, instance.id);
  const resetAt = Date.now() + 3_600_000;
  const reject = () => adapter.emit('rate-limit-telemetry', {
    status: 'rejected', rateLimitType: 'seven_day', resetsAt: resetAt / 1000,
  });
  cleanup.push(() => { detach(); handler._resetForTesting(); db.close(); });
  return { handler, instance, ledger, state, reject, resetAt, sourceLimit };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
});

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  resetUsageOverageStopForTesting();
  vi.useRealTimers();
});

describe('weekly usage safety stop through real account failover', () => {
  it.each([true, false])('switches and continues once with automatic resume %s', async (autoResume) => {
    const h = setup({ autoResume });
    h.reject();
    await settle();

    expect(h.state.events).toEqual(['interrupt', 'apply']);
    expect(h.state.limitAtApply).toMatchObject({ accountProfileId: null, source: 'usage-overage', resumeAt: h.resetAt });
    expect(h.sourceLimit()).toMatchObject({ source: 'usage-overage', resumeAt: h.resetAt });
    expect(h.ledger.getActive({ provider: 'claude', model: null, accountProfileId: 'alternative' })).toBeNull();
    expect(h.state.stops).toEqual(['switching-account']);
    expect(h.state.gates).toEqual(['skipped']);
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0].profileId).toBe('alternative');
    const continuation = parseInternalInputEnvelope(h.state.sent[0].prompt);
    expect(continuation?.source).toBe('provider-limit-resume');
    expect(continuation?.text).toContain('Continue the interrupted task');
    expect(continuation?.text).toContain('do not repeat completed steps');
    expect(continuation?.text).not.toMatch(/has reset|limit has lifted|cancel these automations/i);
    expect(h.handler.isParked('session')).toBe(false);
    expect(h.state.wait).toBeNull();
    expect(h.state.schedules).toEqual([]);
    expect(h.state.notices.some((notice) => notice.metadata['providerLimitParked'])).toBe(false);
  });

  it.each([
    { label: 'ask policy', mode: 'ask' as const },
    { label: 'off policy', mode: 'off' as const },
    { label: 'disabled alternative', enabled: false },
    { label: 'signed-out alternative', signedIn: false },
    { label: 'exhausted alternative', quota: { usable: false, weeklyPct: 100 } },
    { label: 'paid-only alternative', quota: paidOnly },
  ])('holds without spending under $label even with automatic resume off', async ({ label, ...options }) => {
    const h = setup({ ...options, autoResume: false });
    h.reject();
    await settle();

    expect(h.handler.isParked('session')).toBe(true);
    expect(h.state.wait).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt: h.resetAt });
    expect(h.state.sent).toEqual([]);
    expect(h.state.applyCount).toBe(0);
    expect(h.state.schedules).toEqual([]);
    expect(h.sourceLimit()).toMatchObject({ source: 'usage-overage' });
    expect(h.state.notifications).toEqual(label === 'ask policy' ? ['account-failover-offer'] : []);
  });

  it('holds if a candidate becomes paid-only during its fresh quota check', async () => {
    const h = setup({ freshQuota: paidOnly, autoResume: false });
    h.reject();
    await settle();

    expect(h.state.stops).toEqual(['switching-account']);
    expect(h.state.quota).toEqual(paidOnly);
    expect(h.state.applyCount).toBe(0);
    expect(h.handler.isParked('session')).toBe(true);
    expect(h.state.wait?.kind).toBe('quota-park');
    expect(h.state.sent).toEqual([]);
    expect(h.state.schedules).toEqual([]);
  });

  it('suppresses duplicate telemetry and errors while applying, then lets the new-account continuation through', async () => {
    const applying = deferred();
    const h = setup({ apply: () => applying.promise });
    h.reject();
    await settle();
    expect(h.state.applyCount).toBe(1);

    h.reject();
    expect(h.handler.maybePark({
      instanceId: 'session', provider: 'claude', model: null, accountProfileId: 'legacy',
      resetAtHint: h.resetAt, reason: 'duplicate provider error', resumePrompt: 'cancel these automations',
    })).toBe('switching-account');
    expect(h.handler.maybeParkKnown({
      instanceId: 'session', provider: 'claude', model: null, accountProfileId: 'legacy',
      reason: 'racing pre-send check', resumePrompt: 'cancel these automations',
    })).toBe('switching-account');
    expect(h.state.notices.some((notice) => /message was not sent.*moving.*send it again/is.test(notice.content))).toBe(true);
    expect(h.handler.isParked('session')).toBe(false);
    expect(h.state.sent).toEqual([]);

    applying.resolve();
    await settle();
    expect(h.state.applyCount).toBe(1);
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0].profileId).toBe('alternative');
    expect(h.state.sent[0].prompt).not.toContain('cancel these automations');
    expect(h.state.gates).toEqual(['skipped']);
    expect(h.handler.isParked('session')).toBe(false);
    expect(h.state.schedules).toEqual([]);
    expect(h.state.notices.some((notice) => notice.metadata['providerLimitParked'])).toBe(false);
  });

  it('holds a failed runtime handoff even when automatic resume is disabled', async () => {
    const h = setup({ autoResume: false, apply: async () => { throw new Error('synthetic worker rejection'); } });
    h.reject();
    await settle();

    expect(h.state.applyCount).toBe(1);
    expect(h.instance.accountProfileId).toBe('legacy');
    expect(h.handler.isParked('session')).toBe(true);
    expect(h.state.wait?.kind).toBe('quota-park');
    expect(h.state.sent).toEqual([]);
    expect(h.state.schedules).toEqual([]);
    expect(h.sourceLimit()).not.toBeNull();
    expect(h.state.notices.some((notice) => /will (?:auto-)?resume/i.test(notice.content))).toBe(false);
  });

  it('does not resurrect a hold when the session is released before a delayed apply failure', async () => {
    const applying = deferred();
    const h = setup({ apply: () => applying.promise, autoResume: false });
    h.reject();
    await settle();
    expect(h.state.applyCount).toBe(1);
    h.handler.release('session');
    const noticesAtRelease = h.state.notices.length;

    applying.reject(new Error('synthetic failure after termination'));
    await settle();
    expect(h.handler.isParked('session')).toBe(false);
    expect(h.state.wait).toBeNull();
    expect(h.state.sent).toEqual([]);
    expect(h.state.schedules).toEqual([]);
    expect(h.state.notices).toHaveLength(noticesAtRelease);
    expect(h.sourceLimit()).not.toBeNull();
  });

  it('does not start a queued handoff after the session is released', async () => {
    const h = setup();
    h.reject();
    h.handler.release('session');
    await settle();

    expect(h.state.applyCount).toBe(0);
    expect(h.state.sent).toEqual([]);
    expect(h.handler.isParked('session')).toBe(false);
  });

  it('does not apply a handoff after release during the fresh quota check', async () => {
    const refreshing = deferred();
    const h = setup({ refresh: () => refreshing.promise });
    h.reject();
    await settle();
    expect(h.state.applyCount).toBe(0);
    h.handler.release('session');
    refreshing.resolve();
    await settle();

    expect(h.state.applyCount).toBe(0);
    expect(h.state.sent).toEqual([]);
    expect(h.handler.isParked('session')).toBe(false);
  });

  it('does not send a continuation if released while the handoff applies', async () => {
    const applying = deferred();
    const h = setup({ apply: () => applying.promise });
    h.reject();
    await settle();
    expect(h.state.applyCount).toBe(1);
    h.handler.release('session');
    applying.resolve();
    await settle();

    expect(h.state.sent).toEqual([]);
    expect(h.state.notifications).toEqual([]);
    expect(h.handler.isParked('session')).toBe(false);
  });

  it('does not send a continuation after a switch notification releases the session', async () => {
    const h = setup({ notify: () => h.handler.release('session') });
    h.reject();
    await settle();

    expect(h.state.applyCount).toBe(1);
    expect(h.state.sent).toEqual([]);
    expect(h.handler.isParked('session')).toBe(false);
  });

  it.each(['known', 'error'])('retains the paid-only sibling veto on the %s path of a durable safety limit', async (path) => {
    const h = setup({ autoResume: false, quota: paidOnly });
    h.reject();
    h.handler.release('session');
    expect(h.sourceLimit()?.source).toBe('usage-overage');

    const turn = {
      instanceId: 'session', provider: 'claude', model: null, accountProfileId: 'legacy',
      reason: 'send after restart', resumePrompt: 'a new user turn',
    } as const;
    expect(path === 'known' ? h.handler.maybeParkKnown(turn)
      : h.handler.maybePark({ ...turn, resetAtHint: h.resetAt })).toBe('parked');
    await settle();
    expect(h.state.applyCount).toBe(0);
    expect(h.state.sent).toEqual([]);
    expect(h.sourceLimit()).not.toBeNull();
  });

  it('does not clear a durable safety stop just because newer paid credits appear', async () => {
    const h = setup({ autoResume: false, quota: { usable: false, weeklyPct: 100 }, snapshot: () => ({
      provider: 'claude', takenAt: Date.now(), source: 'admin-api', ok: true,
      windows: [{ kind: 'rolling-window', id: 'claude.weekly', label: 'Weekly', unit: 'percent', used: 100, limit: 100, remaining: 0, resetsAt: null }],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true },
    }) });
    h.reject();
    h.handler.release('session');
    vi.setSystemTime(Date.now() + 1000);

    expect(h.handler.maybeParkKnown({
      instanceId: 'session', provider: 'claude', model: null, accountProfileId: 'legacy',
      reason: 'send after restart with credits', resumePrompt: 'a new user turn',
    })).toBe('parked');
    expect(h.sourceLimit()).not.toBeNull();
    expect(h.state.sent).toEqual([]);
  });

  it('ignores paid-only recovery during early probes, then switches when included usage returns', async () => {
    const probe = vi.fn(async (): Promise<ProviderQuotaSnapshot> => ({
      provider: 'claude', ok: true, source: 'admin-api', takenAt: Date.now(),
      windows: [{ kind: 'rolling-window', id: 'claude.weekly', label: 'Weekly', unit: 'percent', used: 100, limit: 100, remaining: 0, resetsAt: null }],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true },
    }));
    const h = setup({ quota: paidOnly, probe });
    h.reject();
    expect(h.handler.isParked('session')).toBe(true);

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(h.handler.isParked('session')).toBe(true);
    expect(h.state.sent).toEqual([]);
    expect(h.sourceLimit()).not.toBeNull();

    h.state.quota = { weeklyPct: 5, usable: true };
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS);
    await settle();
    expect(h.state.sent).toHaveLength(1);
    expect(h.state.sent[0].profileId).toBe('alternative');
    expect(parseInternalInputEnvelope(h.state.sent[0].prompt)?.text).toContain('Continue the interrupted task');
    expect(h.handler.isParked('session')).toBe(false);
    expect(h.state.wait).toBeNull();
    expect(h.sourceLimit()).not.toBeNull();
  });

  it('allows a later user turn to fail over again after the first account recovers', async () => {
    const h = setup();
    h.reject();
    await settle();
    expect(h.instance.accountProfileId).toBe('alternative');

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    h.ledger.clearActive({ provider: 'claude', model: null, accountProfileId: 'legacy' });
    expect(h.handler.maybeParkKnown({
      instanceId: 'session', provider: 'claude', model: null, accountProfileId: 'alternative',
      reason: 'new user turn', resumePrompt: 'a different user task',
    })).toBe('skipped');
    h.reject();
    await settle();

    expect(h.instance.accountProfileId).toBe('legacy');
    expect(h.state.sent.map((turn) => turn.profileId)).toEqual(['alternative', 'legacy']);
    expect(h.handler.isParked('session')).toBe(false);
  });
});
