import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';
import { EARLY_RESUME_PROBE_MS } from '../instance/instance-provider-limit-handler';
import type { LoopState } from '../../shared/types/loop.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';

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
    expect(refresher).toHaveBeenCalledWith('claude');
    // Gate must be dropped provider-wide before the resume, or the next
    // iteration's ledger preflight instantly re-parks the loop.
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: null });
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
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-sonnet-4-5' });
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
