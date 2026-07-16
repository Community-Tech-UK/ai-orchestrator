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
