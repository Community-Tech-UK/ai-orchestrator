import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';
import { EARLY_RESUME_PROBE_MS } from '../instance/instance-provider-limit-handler';
import { getLogger } from '../logging/logger';
import type { LoopState } from '../../shared/types/loop.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';

const loopSettings = vi.hoisted(() => ({ model: undefined as string | undefined }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({
    defaultCli: 'opencode', loopModelByProvider: { opencode: loopSettings.model },
    auxiliaryLlmRoutingClassificationEnabled: false,
    providerAccountProfiles: [], providerAccountPools: {},
  }) }),
}));
import { LoopAccountFailover } from '../providers/account-pool/loop-account-failover';
import { rememberAdapterAccountRoute } from '../providers/account-pool/adapter-account-routes';
import { ProviderAccountStore } from '../providers/account-pool/provider-account-store';
import { ProviderAccountRoutingService } from '../providers/account-pool/provider-account-routing-service';
import { attachAccountRoute } from '../instance/lifecycle/account-route-preflight';
import { defaultProviderAccountPools, type ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { getModelRouter } from '../routing/model-router';
import type { ProviderLimitEvent } from '../core/system/provider-limit-ledger';
import { ProviderLimitLedger, createProviderLimitLedgerSchema } from '../core/system/provider-limit-ledger';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';

function makeSnapshot(used: number): ProviderQuotaSnapshot {
  return {
    provider: 'claude',
    takenAt: Date.now(),
    source: 'admin-api',
    ok: true,
    windows: [{
      id: 'five_hour',
      label: 'five_hour',
      unit: 'requests',
      used,
      limit: 100,
      remaining: Math.max(0, 100 - used),
      resetsAt: Date.now() + 24 * 60 * 60 * 1000,
    }],
  } as ProviderQuotaSnapshot;
}

function makeLoopState(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    endedAt: null,
    endReason: undefined,
    config: { provider: 'claude', workspaceCwd: '/tmp/ws' },
  } as unknown as LoopState;
}

describe('LoopProviderLimitHandler early-resume quota probe', () => {
  const FAR_FUTURE = 24 * 60 * 60 * 1000; // stale-limit scenario: recorded reset a day away
  let deps: {
    emit: ReturnType<typeof vi.fn>;
    cloneStateForBroadcast: ReturnType<typeof vi.fn>;
    setConvergenceNote: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
    resumeLoop: ReturnType<typeof vi.fn>;
  };
  let handler: LoopProviderLimitHandler;
  let ledger: { record: ReturnType<typeof vi.fn>; getActive: ReturnType<typeof vi.fn>; clearActive: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.useFakeTimers();
    deps = {
      emit: vi.fn(),
      cloneStateForBroadcast: vi.fn((s: LoopState) => s),
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(() => true),
    };
    handler = new LoopProviderLimitHandler(deps);
    ledger = { record: vi.fn(), getActive: vi.fn(() => null), clearActive: vi.fn(() => 1) };
    handler.setProviderLimitLedger(ledger);
    handler.setProviderLimitResumeScheduler(() => () => { /* durable schedule noop */ });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function parkOnLimit(state: LoopState): void {
    const outcome = handler.handleProviderLimit(state, {
      reason: 'limit',
      resumeAt: Date.now() + FAR_FUTURE,
      source: 'quota',
      action: 'throttle',
    });
    expect(outcome).toBe('parked');
  }

  it('resumes early and clears the durable gate when a fresh probe shows headroom', async () => {
    const refresher = vi.fn(async () => makeSnapshot(10));
    handler.setQuotaSnapshotRefresher(refresher);
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(refresher).toHaveBeenCalledWith('claude', null);
    // Gate must be dropped provider-wide before the resume, or the next
    // iteration's ledger preflight instantly re-parks the loop.
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: null, accountProfileId: null });
    expect(deps.resumeLoop).toHaveBeenCalledWith('loop-1');
  });

  it('stays parked while the probe still shows an exhausted window', async () => {
    const refresher = vi.fn(async () => makeSnapshot(100));
    handler.setQuotaSnapshotRefresher(refresher);
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(refresher).toHaveBeenCalled();
    expect(deps.resumeLoop).not.toHaveBeenCalled();
    expect(ledger.clearActive).not.toHaveBeenCalled();
  });

  it('treats a failed probe as still limited', async () => {
    const refresher = vi.fn(async () => null);
    handler.setQuotaSnapshotRefresher(refresher);
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(deps.resumeLoop).not.toHaveBeenCalled();
  });

  it('stops probing once the resume timer is cleared (manual resume path)', async () => {
    const refresher = vi.fn(async () => makeSnapshot(10));
    handler.setQuotaSnapshotRefresher(refresher);
    parkOnLimit(makeLoopState());

    handler.clearResumeTimer('loop-1');
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(refresher).not.toHaveBeenCalled();
    expect(deps.resumeLoop).not.toHaveBeenCalled();
  });

  // Regression: the probe used to resume whenever every window was below 100%,
  // while the pre-iteration pre-flight parks from 90%. Between those two
  // numbers the probe resumed a loop the pre-flight re-parked milliseconds
  // later, forever, every 3 minutes.
  it('stays parked in the 90-100% band the pre-flight would park on', async () => {
    const refresher = vi.fn(async () => makeSnapshot(94));
    handler.setQuotaSnapshotRefresher(refresher);
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(refresher).toHaveBeenCalled();
    expect(deps.resumeLoop).not.toHaveBeenCalled();
    expect(ledger.clearActive).not.toHaveBeenCalled();
  });

  it('stays parked while an overage window would trip the guard', async () => {
    const overageSnapshot: ProviderQuotaSnapshot = {
      provider: 'claude',
      takenAt: Date.now(),
      source: 'admin-api',
      ok: true,
      windows: [{
        kind: 'calendar-period',
        id: 'claude.credits',
        label: 'Credits',
        unit: 'usd',
        used: 5,
        limit: 100,
        remaining: 95,
        resetsAt: Date.now() + 24 * 60 * 60 * 1000,
        overage: true,
      }],
    };
    handler.setQuotaSnapshotRefresher(vi.fn(async () => overageSnapshot));
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(deps.resumeLoop).not.toHaveBeenCalled();
  });

  it('resumes on that same overage snapshot once overage is allowed', async () => {
    const overageSnapshot: ProviderQuotaSnapshot = {
      provider: 'claude',
      takenAt: Date.now(),
      source: 'admin-api',
      ok: true,
      windows: [{
        kind: 'calendar-period',
        id: 'claude.credits',
        label: 'Credits',
        unit: 'usd',
        used: 5,
        limit: 100,
        remaining: 95,
        resetsAt: Date.now() + 24 * 60 * 60 * 1000,
        overage: true,
      }],
    };
    handler.setAllowOverage(true);
    handler.setQuotaSnapshotRefresher(vi.fn(async () => overageSnapshot));
    parkOnLimit(makeLoopState());

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(deps.resumeLoop).toHaveBeenCalledWith('loop-1');
  });

  it('never probes for a wakeup park — that is a scheduled sleep, not a limit', async () => {
    const refresher = vi.fn(async () => makeSnapshot(10));
    handler.setQuotaSnapshotRefresher(refresher);
    handler.scheduleWakeupResume(makeLoopState(), {
      resumeAt: Date.now() + FAR_FUTURE,
      reason: 'scheduled wakeup',
    });

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(refresher).not.toHaveBeenCalled();
    expect(deps.resumeLoop).not.toHaveBeenCalled();
  });
});

describe('LoopProviderLimitHandler.clearKnownLimitGate', () => {
  it('clears active gates via the ledger and tolerates a missing ledger', () => {
    const deps = {
      emit: vi.fn(),
      cloneStateForBroadcast: vi.fn((s: LoopState) => s),
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(() => true),
    };
    const handler = new LoopProviderLimitHandler(deps);
    expect(() => handler.clearKnownLimitGate('claude', null)).not.toThrow();

    const ledger = { record: vi.fn(), getActive: vi.fn(() => null), clearActive: vi.fn(() => 2) };
    handler.setProviderLimitLedger(ledger);
    handler.clearKnownLimitGate('claude', 'claude-sonnet-4-5');
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-sonnet-4-5', accountProfileId: null });
  });
});

describe('LoopProviderLimitHandler manual-resume throttle override', () => {
  function makeHandler() {
    const deps = {
      emit: vi.fn(),
      cloneStateForBroadcast: vi.fn((s: LoopState) => s),
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(() => true),
    };
    return { deps, handler: new LoopProviderLimitHandler(deps) };
  }

  // Regression: pressing Resume cleared only the durable ledger gate, so the
  // pre-flight's live-snapshot evaluation re-parked the loop 1-3 ms later and
  // the button looked dead.
  it('lets exactly one iteration past a snapshot that would otherwise park', () => {
    const { handler } = makeHandler();
    handler.setQuotaSnapshotProvider(() => makeSnapshot(100));
    const state = makeLoopState();

    expect(handler.evaluateLoopQuotaThrottle(state).action).toBe('park-exhausted');

    handler.applyManualResumeOverride('claude', state.id);
    expect(handler.evaluateLoopQuotaThrottle(state).action).toBe('continue');
    // One-shot: a genuinely exhausted provider must re-park immediately after.
    expect(handler.evaluateLoopQuotaThrottle(state).action).toBe('park-exhausted');
  });

  it('scopes the override to the loop that was resumed', () => {
    const { handler } = makeHandler();
    handler.setQuotaSnapshotProvider(() => makeSnapshot(100));
    const other = { ...makeLoopState(), id: 'loop-2' } as LoopState;

    handler.applyManualResumeOverride('claude', 'loop-1');
    expect(handler.evaluateLoopQuotaThrottle(other).action).toBe('park-exhausted');
  });

  it('drops a pending override when the park is disarmed', () => {
    const { handler } = makeHandler();
    handler.setQuotaSnapshotProvider(() => makeSnapshot(100));
    const state = makeLoopState();

    handler.applyManualResumeOverride('claude', state.id);
    handler.clearResumeTimer(state.id);
    expect(handler.evaluateLoopQuotaThrottle(state).action).toBe('park-exhausted');
  });
});

describe('LoopProviderLimitHandler allowOverage wiring', () => {
  function overageSnapshot(): ProviderQuotaSnapshot {
    return {
      provider: 'claude',
      takenAt: Date.now(),
      source: 'admin-api',
      ok: true,
      windows: [{
        kind: 'calendar-period',
        id: 'claude.credits',
        label: 'Credits',
        unit: 'usd',
        used: 5,
        limit: 100,
        remaining: 95,
        resetsAt: Date.now() + 60_000,
        overage: true,
      }],
    };
  }

  it('reads the provider lazily so a mid-run settings change applies', () => {
    const deps = {
      emit: vi.fn(),
      cloneStateForBroadcast: vi.fn((s: LoopState) => s),
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(() => true),
    };
    const handler = new LoopProviderLimitHandler(deps);
    handler.setQuotaSnapshotProvider(() => overageSnapshot());

    let allow = false;
    handler.setAllowOverage(() => allow);
    expect(handler.evaluateLoopQuotaThrottle(makeLoopState()).action).toBe('overage-guard');

    allow = true;
    expect(handler.evaluateLoopQuotaThrottle(makeLoopState()).action).toBe('continue');
  });

  it('falls back to never riding overage when the settings read throws', () => {
    const deps = {
      emit: vi.fn(),
      cloneStateForBroadcast: vi.fn((s: LoopState) => s),
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(() => true),
    };
    const handler = new LoopProviderLimitHandler(deps);
    handler.setQuotaSnapshotProvider(() => overageSnapshot());
    handler.setAllowOverage(() => { throw new Error('settings unavailable'); });

    expect(handler.evaluateLoopQuotaThrottle(makeLoopState()).action).toBe('overage-guard');
  });
});

describe('LoopProviderLimitHandler account-pool failover', () => {
  function stateFor(id: string) {
    return { id, chatId: 'chat', status: 'running', totalIterations: 2, currentStage: 'IMPLEMENT', config: { provider: 'claude', workspaceCwd: '/w' } } as never;
  }

  it('benches the loop account and continues instead of parking when the pool can switch', () => {
    const emit = vi.fn();
    const requestContextReset = vi.fn();
    const handler = new LoopProviderLimitHandler({
      emit,
      cloneStateForBroadcast: (state) => state,
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(),
      requestContextReset,
    });
    const ledger = { record: vi.fn(), getActive: vi.fn(), clearActive: vi.fn() };
    handler.setProviderLimitLedger(ledger as never);
    const trySwitch = vi.fn(() => true);
    handler.setLoopAccountFailover({ currentProfileId: () => 'max-a', trySwitch });
    const state = stateFor('loop-a');
    const outcome = handler.handleProviderLimit(state, {
      reason: 'limit notice', resumeAt: null, source: 'notice', action: 'notice', mustStop: true,
    });
    expect(outcome).toBe('switched-account');
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ accountProfileId: 'max-a', source: 'loop-notice' }));
    expect(trySwitch).toHaveBeenCalledWith(expect.objectContaining({ loopRunId: 'loop-a', provider: 'claude', iteration: 2 }));
    expect((state as { status: string }).status).toBe('running');
    expect(requestContextReset).toHaveBeenCalledWith('loop-a');
  });

  it('parks as before when failover is disallowed for the signal or no switch is possible', () => {
    const handler = new LoopProviderLimitHandler({
      emit: vi.fn(),
      cloneStateForBroadcast: (state) => state,
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(),
    });
    const trySwitch = vi.fn(() => false);
    handler.setLoopAccountFailover({ currentProfileId: () => 'max-a', trySwitch });
    const resumeAt = Date.now() + 60_000;
    expect(handler.handleProviderLimit(stateFor('loop-b'), { reason: 'x', resumeAt, source: 'quota', action: 'throttle', mustStop: true })).toBe('parked');
    trySwitch.mockClear();
    handler.clearResumeTimer('loop-b');
    expect(handler.handleProviderLimit(stateFor('loop-c'), { reason: 'x', resumeAt, source: 'quota', action: 'throttle', mustStop: true, accountFailover: false })).toBe('parked');
    expect(trySwitch).not.toHaveBeenCalled();
    handler.clearResumeTimer('loop-c');
  });
});

describe('LoopProviderLimitHandler provider failover', () => {
  function stateFor(id: string) {
    return { id, chatId: 'chat', status: 'running', totalIterations: 0, currentStage: 'IMPLEMENT', config: { provider: 'claude', workspaceCwd: '/w' } } as never;
  }

  function makeHandler(tryProviderFailover: (state: LoopState, reason: string) => boolean) {
    const emit = vi.fn();
    const handler = new LoopProviderLimitHandler({
      emit,
      cloneStateForBroadcast: (state) => state,
      setConvergenceNote: vi.fn(),
      terminate: vi.fn(),
      resumeLoop: vi.fn(),
      tryProviderFailover,
    });
    const ledger = { record: vi.fn(), getActive: vi.fn(), clearActive: vi.fn() };
    handler.setProviderLimitLedger(ledger as never);
    handler.setLoopAccountFailover({ currentProfileId: () => null, trySwitch: vi.fn(() => false) });
    return { handler, emit, ledger };
  }

  it('switches provider instead of parking, after recording the limit for the old provider', () => {
    const order: string[] = [];
    const tryProviderFailover = vi.fn(() => { order.push('switch'); return true; });
    const { handler, emit, ledger } = makeHandler(tryProviderFailover);
    ledger.record.mockImplementation(() => { order.push('record'); });
    const state = stateFor('loop-p');

    const outcome = handler.handleProviderLimit(state, {
      reason: 'weekly limit', resumeAt: Date.now() + 60_000, source: 'quota', action: 'throttle',
    });

    expect(outcome).toBe('switched-provider');
    expect(tryProviderFailover).toHaveBeenCalledWith(state, 'weekly limit');
    expect(order).toEqual(['record', 'switch']);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude' }));
    expect((state as { status: string }).status).toBe('running');
    expect(emit).not.toHaveBeenCalledWith('loop:provider-limit', expect.anything());
  });

  it('tries a switch before terminating when no reset time is known, recording an assumed limit window', () => {
    const { handler, ledger } = makeHandler(() => true);
    const now = Date.now();
    expect(handler.handleProviderLimit(stateFor('loop-t'), {
      reason: 'limit notice', resumeAt: null, source: 'notice', action: 'notice', mustStop: true,
    })).toBe('switched-provider');
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      source: 'loop-notice',
      resumeAt: expect.any(Number),
    }));
    expect(ledger.record.mock.calls[0][0].resumeAt).toBeGreaterThan(now);
  });

  it('parks when no switch is possible, the switch throws, or the signal is a burst throttle', () => {
    const resumeAt = Date.now() + 60_000;
    const opts = { reason: 'x', resumeAt, source: 'quota' as const, action: 'throttle' as const, mustStop: true };

    const none = makeHandler(() => false);
    expect(none.handler.handleProviderLimit(stateFor('loop-n'), opts)).toBe('parked');
    none.handler.clearResumeTimer('loop-n');

    const throws = makeHandler(() => { throw new Error('boom'); });
    expect(throws.handler.handleProviderLimit(stateFor('loop-x'), opts)).toBe('parked');
    throws.handler.clearResumeTimer('loop-x');

    const burstSwitch = vi.fn(() => true);
    const burst = makeHandler(burstSwitch);
    expect(burst.handler.handleProviderLimit(stateFor('loop-b'), { ...opts, accountFailover: false })).toBe('parked');
    expect(burstSwitch).not.toHaveBeenCalled();
    burst.handler.clearResumeTimer('loop-b');
  });
});


describe('LoopProviderLimitHandler MiMo production account isolation', () => {
  const mimo = 'xiaomi-token-plan-ams/mimo-v2.6-pro';
  let routingEnabled = true;
  beforeEach(() => {
    routingEnabled = getModelRouter().getConfig().enabled;
    getModelRouter().updateConfig({ enabled: false });
    loopSettings.model = mimo;
  });
  afterEach(() => {
    getModelRouter().updateConfig({ enabled: routingEnabled });
    loopSettings.model = undefined;
    vi.useRealTimers();
  });

  function harness(options: { initialRoute?: boolean; legacyOnly?: boolean; automatic?: boolean; ledger?: ProviderLimitLedger } = {}) {
    const profiles: ProviderAccountProfile[] = ['legacy', ...(options.legacyOnly ? [] : ['placeholder-b'])].map((id, priority) => ({
      id, provider: 'opencode', label: id, priority, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
      enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', region: 'ams', createdAt: 1, updatedAt: 1,
    }));
    const pools = defaultProviderAccountPools();
    pools.opencode = { ...pools.opencode, failoverMode: options.automatic ? 'automatic' : 'off', acknowledgedOwnershipAt: 1, switchCooldownMs: 0 };
    const store = new ProviderAccountStore({ read: () => ({ profiles, pools }) });
    const recycle = vi.fn();
    const notify = vi.fn();
    const accounts = new LoopAccountFailover({ store: () => store, cachedBindingState: () => 'authenticated',
      getParkedProfileIds: (provider, model) => options.ledger?.getParkedProfileIds({ provider, model }) ?? [],
      getParkedSince: (provider, model) => options.ledger?.getParkedSince({ provider, model }) ?? new Map(), getQuotaEvidence: () => null, notify });
    const state = { ...makeLoopState(), config: { ...makeLoopState().config, provider: 'opencode', initialPrompt: 'placeholder goal' },
      totalIterations: 2, currentStage: 'IMPLEMENT' } as LoopState;
    if (options.initialRoute !== false) {
      const adapter = {};
      rememberAdapterAccountRoute(adapter, { provider: 'opencode', profileId: 'legacy', source: 'default', executionNodeId: 'local', region: 'ams' });
      accounts.noteIterationAdapter(state.id, adapter, { provider: 'opencode', model: mimo });
    }
    accounts.registerRecycler(state.id, recycle);
    const emit = vi.fn();
    const reset = vi.fn();
    const handler = new LoopProviderLimitHandler({ emit, cloneStateForBroadcast: (s) => s,
      setConvergenceNote: vi.fn(), terminate: vi.fn(), resumeLoop: vi.fn(), requestContextReset: reset });
    handler.setLoopAccountFailover(accounts);
    handler.setProviderLimitResumeScheduler(() => () => { /* synthetic durable scheduler */ });
    const records: unknown[] = [];
    const ledger = {
      getActive: vi.fn<(_: unknown) => ProviderLimitEvent | null>(() => null),
      record: vi.fn((record) => { records.push(record); return { id: 'placeholder-limit', ...record }; }),
      clearActive: vi.fn(() => 1),
    };
    handler.setProviderLimitLedger(ledger);
    const quota = vi.fn(() => ({ ...makeSnapshot(100), provider: 'opencode' as const }));
    handler.setQuotaSnapshotProvider(quota);
    return { state, handler, accounts, store, ledger, quota, records, recycle, notify, emit, reset };
  }

  function known(model: string | null, accountProfileId: string | null = null): ProviderLimitEvent {
    return { id: 'placeholder-limit', provider: 'opencode', model, accountProfileId,
      source: 'synthetic-limit', detectedAt: Date.now(), resumeAt: Date.now() + 600_000, instanceId: null };
  }

  it.each([mimo, null])('actual account selection vetoes a candidate gated by %s without recycling', (candidateModel) => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    const ledger = new ProviderLimitLedger(db);
    const h = harness({ automatic: true, ledger });
    try {
      const base = { provider: 'opencode' as const, detectedAt: Date.now() - 100, resumeAt: Date.now() + 600_000,
        source: 'historical regular refusal', instanceId: null };
      const candidate = ledger.record({ ...base, model: candidateModel, accountProfileId: 'placeholder-b' });
      const native = ledger.record({ ...base, model: 'opencode/big-pickle', accountProfileId: null });
      h.handler.setProviderLimitLedger(ledger);
      loopSettings.model = 'opencode/big-pickle'; // reactive selection retains CURRENT MiMo authority
      expect(h.handler.handleProviderLimit(h.state, { reason: 'current MiMo refused', resumeAt: base.resumeAt,
        source: 'notice', action: 'notice', mustStop: true })).toBe('parked');
      expect(h.accounts.currentProfileId(h.state.id, 'opencode')).toBe('legacy');
      expect(h.recycle).not.toHaveBeenCalled();
      expect(ledger.list().map((row) => row.id)).toEqual(expect.arrayContaining([candidate.id, native.id]));
      expect(ledger.list().filter((row) => row.accountProfileId === null && row.model === null)).toHaveLength(1);
      expect(ledger.list().filter((row) => row.accountProfileId === null && row.model === mimo)).toHaveLength(0);
    } finally { h.handler.clearResumeTimer(h.state.id); db.close(); }
  });

  it.each([
    ['manual', mimo], ['early', mimo], ['manual', null], ['early', null],
  ] as const)('%s recovery consumes accepted historical/account-wide gate %s after model/profile mutation', async (mode, gateModel) => {
    vi.useFakeTimers();
    const db = new Database(':memory:') as unknown as SqliteDriver;
    createProviderLimitLedgerSchema(db);
    const ledger = new ProviderLimitLedger(db);
    const h = harness({ initialRoute: false, legacyOnly: true });
    try {
      const base = { provider: 'opencode' as const, detectedAt: Date.now() - 100, resumeAt: Date.now() + 600_000,
        source: 'historical regular refusal', instanceId: null };
      ledger.record({ ...base, model: gateModel, accountProfileId: 'legacy' });
      const native = ledger.record({ ...base, model: 'opencode/big-pickle', accountProfileId: null });
      const foreign = ledger.record({ ...base, model: mimo, accountProfileId: 'placeholder-b' });
      const expired = ledger.record({ ...base, model: mimo, accountProfileId: null,
        detectedAt: Date.now() - 1000, resumeAt: Date.now() - 1 });
      h.handler.setProviderLimitLedger(ledger);
      const refresh = vi.fn(async () => ({ ...makeSnapshot(10), provider: 'opencode' as const }));
      h.handler.setQuotaSnapshotRefresher(refresh);
      expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      // A later account-wide refusal and mutable account/settings do not replace the accepted park scope.
      if (gateModel !== null) ledger.record({ ...base, model: null, accountProfileId: null });
      loopSettings.model = 'opencode/big-pickle';
      const replacement = {};
      rememberAdapterAccountRoute(replacement, { provider: 'opencode', profileId: 'placeholder-b', source: 'default', executionNodeId: 'local', region: 'sgp' });
      h.accounts.noteIterationAdapter(h.state.id, replacement, { provider: 'opencode', model: 'xiaomi-token-plan-sgp/mimo-v2.6-pro' });
      if (mode === 'manual') {
        h.handler.clearResumeTimer(h.state.id, true);
        h.handler.applyManualResumeOverride('opencode', h.state.id);
        expect(refresh).not.toHaveBeenCalled();
      } else {
        await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 1);
        expect(refresh).toHaveBeenCalledWith('opencode', null);
        expect(refresh).toHaveBeenCalledTimes(1);
      }
      expect(ledger.list().map((row) => row.id).sort()).toEqual([native.id, foreign.id, expired.id].sort());
      expect(ledger.getActive({ provider: 'opencode', model: mimo, accountProfileId: 'legacy' })).toBeNull();
    } finally { h.handler.clearResumeTimer(h.state.id); db.close(); }
  });

  it.each(['opencode/big-pickle', 'openrouter/placeholder-model', 'auto', '', undefined, 'aio-mimo-placeholder-b/mimo-v2.6-pro'])(
    'bypasses stale MiMo quota and account-wide ledger before the %s replacement exists', (model) => {
      const h = harness({ automatic: true });
      h.ledger.getActive.mockReturnValue(known(null, 'legacy'));
      loopSettings.model = model;
      expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('skipped');
      expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('continue');
      expect(h.quota).not.toHaveBeenCalled();
      expect(h.state.status).toBe('running');
      expect(h.records).toEqual([]);
      expect(h.recycle).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
      if (h.ledger.getActive.mock.calls.length) {
        expect(h.ledger.getActive).toHaveBeenCalledWith(expect.objectContaining({ model, accountProfileId: null }));
      }
    },
  );

  it.each(['xiaomi-token-plan/mimo-v2.6-pro', 'xiaomi-token-plan-ams/mimo-v2.6-pro', 'xiaomi-token-plan-sgp/mimo-v2.6-pro', 'xiaomi-token-plan-cn/mimo-v2.6-pro'])(
    'retains confirmed current MiMo preventive account scope for %s', (model) => {
      const h = harness();
      loopSettings.model = model;
      h.ledger.getActive.mockReturnValue(known(null, 'legacy'));
      expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('park-exhausted');
      expect(h.quota).toHaveBeenCalledWith('opencode', 'legacy');
      h.handler.clearResumeTimer(h.state.id);
    },
  );

  it('uses effective enabled routing rather than treating a configured MiMo default as the routed model', () => {
    const h = harness();
    getModelRouter().updateConfig({ enabled: true });
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('skipped');
    expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('continue');
    expect(h.ledger.getActive).not.toHaveBeenCalled();
    expect(h.quota).not.toHaveBeenCalled();
    // An explicit downshift follows the same concrete-model precedence as invocation.
    expect(h.handler.evaluateLoopQuotaThrottle(h.state, mimo).action).toBe('park-exhausted');
  });

  it.each([false, true])('lets real route preflight select usable nonlegacy after unknown pooled attribution (old Zen: %s)', async (oldZen) => {
    const h = harness({ initialRoute: false });
    if (oldZen) h.accounts.noteIterationAdapter(h.state.id, {}, { provider: 'opencode', model: 'opencode/big-pickle' });
    h.ledger.getActive.mockReturnValue(known(null, 'legacy'));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('skipped');
    expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('continue');
    expect(h.ledger.getActive).not.toHaveBeenCalled();
    expect(h.quota).not.toHaveBeenCalled();
    const routing = new ProviderAccountRoutingService({ store: h.store,
      bindingService: { checkBinding: async () => ({ state: 'authenticated' }) } as never,
      getParkedProfileIds: () => ['legacy'], getParkedSince: () => new Map([['legacy', Date.now()]]),
      getQuotaEvidence: (_provider, id) => id === 'legacy' ? { allowancePct: 100 } : { allowancePct: 10 } });
    const options = await attachAccountRoute('opencode', { model: mimo }, 'loop', { routingService: routing });
    expect(options.accountRoute?.profileId).toBe('placeholder-b');
    const adapter = {};
    rememberAdapterAccountRoute(adapter, options.accountRoute);
    h.accounts.noteIterationAdapter(h.state.id, adapter, { provider: 'opencode', model: mimo });
    h.quota.mockImplementation(() => ({ ...makeSnapshot(10), provider: 'opencode' }));
    h.ledger.getActive.mockReturnValue(null);
    expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('continue');
    expect(h.quota).toHaveBeenCalledWith('opencode', 'placeholder-b');
  });

  it('retains initial legacy-only MiMo global preventive checks without inventing a pool', () => {
    const h = harness({ initialRoute: false, legacyOnly: true });
    h.ledger.getActive.mockReturnValue(known(null));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
    expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('park-exhausted');
    expect(h.quota).toHaveBeenCalledWith('opencode', null);
    h.handler.clearResumeTimer(h.state.id);
  });

  it.each(['known-ledger', 'live-quota'])('early-lifts an accepted initial legacy MiMo %s park using its immutable scope', async (source) => {
    vi.useFakeTimers();
    const h = harness({ initialRoute: false, legacyOnly: true });
    const db = new Database(':memory:');
    const resume = vi.fn(() => true);
    const handler = new LoopProviderLimitHandler({ emit: vi.fn(), cloneStateForBroadcast: (state) => state,
      setConvergenceNote: vi.fn(), terminate: vi.fn(), resumeLoop: resume });
    try {
      createProviderLimitLedgerSchema(db as unknown as SqliteDriver);
      const ledger = new ProviderLimitLedger(db as unknown as SqliteDriver);
      const resumeAt = Date.now() + 600_000;
      ledger.record({ provider: 'opencode', model: 'opencode/big-pickle', detectedAt: Date.now(), resumeAt, source: 'native control', instanceId: null });
      if (source === 'known-ledger') ledger.record({ provider: 'opencode', model: null, detectedAt: Date.now(), resumeAt, source: 'legacy control', instanceId: null });
      handler.setLoopAccountFailover(h.accounts);
      handler.setProviderLimitLedger(ledger);
      handler.setProviderLimitResumeScheduler(() => vi.fn());
      const refresh = vi.fn(async () => ({ ...makeSnapshot(10), provider: 'opencode' as const }));
      handler.setQuotaSnapshotRefresher(refresh);
      if (source === 'known-ledger') {
        expect(handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      } else {
        handler.setQuotaSnapshotProvider(() => ({ ...makeSnapshot(100), provider: 'opencode' }));
        const decision = handler.evaluateLoopQuotaThrottle(h.state);
        expect(decision.action).toBe('park-exhausted');
        expect(Object.isFrozen(decision.limitScope)).toBe(true);
        loopSettings.model = 'opencode/big-pickle';
        expect(handler.handleProviderLimit(h.state, { reason: 'accepted allowance exhaustion', resumeAt,
          source: 'quota', action: decision.action, limitScope: decision.limitScope })).toBe('parked');
      }
      expect(h.accounts.currentModel(h.state.id, 'opencode')).toBeNull();
      await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 1);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith('opencode', null);
      expect(resume).toHaveBeenCalledWith(h.state.id);
      expect(ledger.list().filter((row) => row.model === null)).toHaveLength(0);
      expect(ledger.list().map((row) => row.model)).toEqual(['opencode/big-pickle']);
    } finally {
      handler.clearResumeTimer(h.state.id);
      db.close();
    }
  });

  it.each([
    [0, false, 1, 1], [0, true, 1, 1], [1, false, 2, 1], [2, false, 2, 0],
  ])('writes one limit per signal while retaining durability retry (fail writes %s, switch %s)', (failWrites, switched, expectedWrites, expectedRows) => {
    const h = harness();
    const db = new Database(':memory:');
    const warn = vi.spyOn(getLogger('LoopProviderLimitHandler'), 'warn');
    try {
      createProviderLimitLedgerSchema(db as unknown as SqliteDriver);
      const ledger = new ProviderLimitLedger(db as unknown as SqliteDriver);
      const record = vi.fn((opts: Parameters<ProviderLimitLedger['record']>[0]) => {
        if (record.mock.calls.length <= failWrites) throw new Error('synthetic write failure');
        return ledger.record(opts);
      });
      h.handler.setProviderLimitLedger({ record, getActive: (opts) => ledger.getActive(opts), clearActive: (opts) => ledger.clearActive(opts) });
      h.handler.setLoopAccountFailover({ currentProfileId: () => 'legacy', currentModel: () => mimo, trySwitch: () => switched });
      expect(h.handler.handleProviderLimit(h.state, { reason: 'same signal', resumeAt: Date.now() + 600_000,
        source: 'notice', action: 'notice', mustStop: true })).toBe(switched ? 'switched-account' : 'parked');
      expect(record).toHaveBeenCalledTimes(expectedWrites);
      expect(warn).toHaveBeenCalledTimes(failWrites);
      expect(ledger.list()).toHaveLength(expectedRows);
      expect(ledger.list().every((row) => row.model === null)).toBe(true);
    } finally {
      h.handler.clearResumeTimer(h.state.id);
      warn.mockRestore();
      db.close();
    }
  });

  it('retains current MiMo model:null native-limit rotation after live settings select Zen', () => {
    const h = harness({ automatic: true });
    loopSettings.model = 'opencode/big-pickle';
    expect(h.handler.handleProviderLimit(h.state, { reason: 'MiMo native limit', resumeAt: null,
      source: 'notice', action: 'notice', mustStop: true })).toBe('switched-account');
    expect(h.accounts.currentProfileId(h.state.id, 'opencode')).toBe('placeholder-b');
    expect(h.records).toEqual([expect.objectContaining({ model: null, accountProfileId: 'legacy' })]);
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.reset).toHaveBeenCalledWith(h.state.id);
  });

  it('parks a route-less Zen rejection and keeps only its exact durable model scope', async () => {
    const h = harness({ automatic: true });
    const options = await attachAccountRoute('opencode', { model: 'opencode/big-pickle' }, 'loop');
    expect(options.accountRoute).toBeUndefined();
    h.accounts.noteIterationAdapter(h.state.id, {}, { provider: 'opencode', model: options.model });
    expect(h.handler.handleProviderLimit(h.state, { reason: 'Zen native limit', resumeAt: Date.now() + 600_000,
      source: 'notice', action: 'notice', mustStop: true })).toBe('parked');
    expect(h.accounts.currentProfileId(h.state.id, 'opencode')).toBeNull();
    expect(h.records).toEqual([expect.objectContaining({ model: 'opencode/big-pickle', accountProfileId: null })]);
    expect(h.recycle).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.emit).toHaveBeenCalledWith('loop:provider-limit', expect.objectContaining({ willResume: true }));
    h.handler.clearResumeTimer(h.state.id, true);
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).toHaveBeenCalledWith({ provider: 'opencode', model: 'opencode/big-pickle', accountProfileId: null, includeAccountWideFallback: false });
    h.handler.clearResumeTimer(h.state.id);
  });

  it('parks unknown native rejection without poisoning the legacy MiMo account-wide ledger', () => {
    const h = harness({ automatic: true });
    h.accounts.noteIterationAdapter(h.state.id, {});
    expect(h.handler.handleProviderLimit(h.state, { reason: 'unknown native limit', resumeAt: Date.now() + 600_000,
      source: 'notice', action: 'notice', mustStop: true })).toBe('parked');
    expect(h.records).toEqual([]);
    expect(h.recycle).not.toHaveBeenCalled();
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).not.toHaveBeenCalled();
    h.handler.clearResumeTimer(h.state.id);
  });

  it('rejects a foreign MiMo profile even when a sink offers the exact native model', () => {
    const h = harness();
    loopSettings.model = 'opencode/big-pickle';
    h.ledger.getActive.mockReturnValue(known('opencode/big-pickle', 'placeholder-b'));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('skipped');
    expect(h.state.status).toBe('running');
  });

  it('honors an exact Zen durable gate before replacement without rotating or probing the old MiMo adapter', async () => {
    vi.useFakeTimers();
    const h = harness({ automatic: true });
    loopSettings.model = 'opencode/big-pickle';
    const refresh = vi.fn(async () => ({ ...makeSnapshot(10), provider: 'opencode' as const }));
    h.handler.setQuotaSnapshotRefresher(refresh);
    h.ledger.getActive.mockReturnValue(known('opencode/big-pickle'));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
    expect(h.records).toEqual([]);
    expect(h.recycle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 1);
    expect(refresh).not.toHaveBeenCalled();
    h.handler.clearResumeTimer(h.state.id, true);
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).toHaveBeenCalledWith({ provider: 'opencode', model: 'opencode/big-pickle', accountProfileId: null, includeAccountWideFallback: false });
    h.handler.clearResumeTimer(h.state.id);
  });

  it.each([false, true])('manual native resume preserves the real MiMo legacy gate after cancellation (replacement=%s)', (replacement) => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    const h = harness();
    try {
      createProviderLimitLedgerSchema(db);
      const ledger = new ProviderLimitLedger(db);
      const base = { provider: 'opencode' as const, detectedAt: Date.now() - 100, resumeAt: Date.now() + 600_000, source: 'synthetic', instanceId: null };
      ledger.record({ ...base, model: null, accountProfileId: 'legacy' });
      ledger.record({ ...base, model: 'opencode/big-pickle' });
      h.handler.setProviderLimitLedger(ledger);
      loopSettings.model = 'opencode/big-pickle';
      if (replacement) h.accounts.noteIterationAdapter(h.state.id, {}, { provider: 'opencode', model: loopSettings.model });
      expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      h.handler.clearResumeTimer(h.state.id, true);
      h.handler.applyManualResumeOverride('opencode', h.state.id);
      expect(ledger.list({ provider: 'opencode' })).toEqual([expect.objectContaining({ model: null, accountProfileId: null })]);
      expect(h.handler.evaluateLoopQuotaThrottle(h.state).action).toBe('continue');
    } finally {
      h.handler.clearResumeTimer(h.state.id);
      db.close();
    }
  });

  it('default cleanup removes a remembered preventive native park scope', () => {
    const h = harness();
    loopSettings.model = 'opencode/big-pickle';
    h.ledger.getActive.mockReturnValue(known(loopSettings.model));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
    h.handler.clearResumeTimer(h.state.id);
    h.accounts.clear(h.state.id);
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).not.toHaveBeenCalled();
  });

  it('ignores an old MiMo refresh that completes after a native Zen park replaces it', async () => {
    vi.useFakeTimers();
    const h = harness();
    const db = new Database(':memory:') as unknown as SqliteDriver;
    try {
      createProviderLimitLedgerSchema(db);
      const ledger = new ProviderLimitLedger(db);
      const base = { provider: 'opencode' as const, detectedAt: Date.now() - 100, resumeAt: Date.now() + 600_000, source: 'synthetic', instanceId: null };
      ledger.record({ ...base, model: null, accountProfileId: 'legacy' });
      ledger.record({ ...base, model: 'opencode/big-pickle' });
      let resolveRefresh!: (snapshot: ProviderQuotaSnapshot) => void;
      const refresh = vi.fn(() => new Promise<ProviderQuotaSnapshot>((resolve) => { resolveRefresh = resolve; }));
      const resumeLoop = vi.fn(() => true);
      const handler = new LoopProviderLimitHandler({ emit: h.emit, cloneStateForBroadcast: (s) => s,
        setConvergenceNote: vi.fn(), terminate: vi.fn(), resumeLoop });
      handler.setLoopAccountFailover(h.accounts);
      handler.setProviderLimitLedger(ledger);
      handler.setProviderLimitResumeScheduler(() => () => { /* synthetic schedule */ });
      handler.setQuotaSnapshotRefresher(refresh);
      expect(handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 1);
      expect(refresh).toHaveBeenCalledWith('opencode', 'legacy');
      loopSettings.model = 'opencode/big-pickle';
      expect(handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
      resolveRefresh({ ...makeSnapshot(10), provider: 'opencode' });
      await vi.advanceTimersByTimeAsync(0);
      expect(resumeLoop).not.toHaveBeenCalled();
      expect(h.state.status).toBe('provider-limit');
      expect(ledger.list({ provider: 'opencode' }).map((event) => event.model)).toEqual([null, 'opencode/big-pickle']);
      expect(vi.getTimerCount()).toBe(0);
      handler.clearResumeTimer(h.state.id);
    } finally {
      h.handler.clearResumeTimer(h.state.id);
      db.close();
    }
  });

  it('retains a native park through banner cancellation and consumes its scope on later manual resume', () => {
    const h = harness();
    loopSettings.model = 'opencode/big-pickle';
    h.ledger.getActive.mockReturnValue(known(loopSettings.model));
    expect(h.handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
    h.handler.clearResumeTimer(h.state.id, true);
    expect(h.state.status).toBe('provider-limit');
    h.handler.clearResumeTimer(h.state.id, true);
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).toHaveBeenLastCalledWith({ provider: 'opencode', model: loopSettings.model, accountProfileId: null, includeAccountWideFallback: false });
    h.accounts.clear(h.state.id);
    h.ledger.clearActive.mockClear();
    h.handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).not.toHaveBeenCalled();
  });

  it.each(['resume', 'decline', 'throw'] as const)('cleans an in-process native park after timer callback %s', async (outcome) => {
    vi.useFakeTimers();
    const h = harness();
    loopSettings.model = 'opencode/big-pickle';
    h.ledger.getActive.mockReturnValue(known(loopSettings.model));
    h.handler.setProviderLimitResumeScheduler(null);
    const resumeLoop = vi.fn(() => {
      if (outcome === 'throw') throw new Error('synthetic resume failure');
      if (outcome === 'decline') return false;
      h.handler.clearResumeTimer(h.state.id, true);
      h.handler.applyManualResumeOverride('opencode', h.state.id);
      return true;
    });
    // Existing constructor port; exercise the real scheduled timer callback.
    const handler = new LoopProviderLimitHandler({ emit: h.emit, cloneStateForBroadcast: (s) => s,
      setConvergenceNote: vi.fn(), terminate: vi.fn(), resumeLoop });
    handler.setLoopAccountFailover(h.accounts);
    handler.setProviderLimitLedger(h.ledger);
    // Use this handler for the coordinator's synchronous resume callback.
    resumeLoop.mockImplementation(() => {
      if (outcome === 'throw') throw new Error('synthetic resume failure');
      if (outcome === 'decline') return false;
      handler.clearResumeTimer(h.state.id, true);
      handler.applyManualResumeOverride('opencode', h.state.id);
      return true;
    });
    expect(handler.maybeParkKnownProviderLimit(h.state)).toBe('parked');
    if (outcome === 'throw') await expect(vi.advanceTimersByTimeAsync(605_001)).rejects.toThrow('synthetic resume failure');
    else await vi.advanceTimersByTimeAsync(605_001);
    expect(resumeLoop).toHaveBeenCalledTimes(1);
    if (outcome === 'resume') expect(h.ledger.clearActive).toHaveBeenCalledWith({ provider: 'opencode', model: loopSettings.model, accountProfileId: null, includeAccountWideFallback: false });
    h.accounts.clear(h.state.id);
    h.ledger.clearActive.mockClear();
    handler.applyManualResumeOverride('opencode', h.state.id);
    expect(h.ledger.clearActive).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    handler.clearResumeTimer(h.state.id);
  });
});
