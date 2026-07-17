import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InstanceProviderLimitHandler,
  EARLY_RESUME_PROBE_MS,
  type InstanceProviderLimitHandlerDeps,
} from './instance-provider-limit-handler';
import type { InstanceProvider, InstanceWaitReason } from '../../shared/types/instance.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';

function makeSnapshot(provider: ProviderId, windows: Array<{ used: number; limit: number; resetsAt: number | null }>): ProviderQuotaSnapshot {
  return {
    provider,
    takenAt: Date.now(),
    source: 'header',
    ok: true,
    windows: windows.map((w, i) => ({
      id: `w${i}`,
      label: `w${i}`,
      unit: 'requests',
      used: w.used,
      limit: w.limit,
      remaining: Math.max(0, w.limit - w.used),
      resetsAt: w.resetsAt,
    })),
  } as ProviderQuotaSnapshot;
}

interface Harness {
  handler: InstanceProviderLimitHandler;
  waitReasons: Map<string, InstanceWaitReason | null>;
  resends: Array<{ instanceId: string; prompt: string }>;
  scheduleCalls: number;
  cancels: number;
  enabled: { value: boolean };
  snapshot: { value: ProviderQuotaSnapshot | null };
  resumableIds: Set<string>;
  fireScheduled: (instanceId: string) => void;
  refreshCalls: ProviderId[];
}

function makeHarness(overrides: Partial<InstanceProviderLimitHandlerDeps> = {}): Harness {
  const handler = new InstanceProviderLimitHandler();
  const waitReasons = new Map<string, InstanceWaitReason | null>();
  const resends: Array<{ instanceId: string; prompt: string }> = [];
  const enabled = { value: true };
  const snapshot = { value: null as ProviderQuotaSnapshot | null };
  let scheduleCalls = 0;
  let cancels = 0;
  const refreshCalls: ProviderId[] = [];
  // Capture the scheduler's resumeInstance callback so a test can "fire" it.
  const scheduled = new Map<string, (instanceId: string, opts?: { resumePromptFallback?: string }) => void>();

  const resumableIds = new Set<string>();
  handler.configure({
    isEnabled: () => enabled.value,
    setWaitReason: (id, wr) => waitReasons.set(id, wr),
    resendInput: (id, prompt) => resends.push({ instanceId: id, prompt }),
    getQuotaSnapshot: () => snapshot.value,
    refreshQuotaSnapshot: (provider) => refreshCalls.push(provider),
    getWorkspaceCwd: () => '/tmp/workspace',
    isResumable: (id) => resumableIds.has(id),
    scheduleResume: ({ request, resumeInstance }) => {
      scheduleCalls++;
      scheduled.set(request.instanceId, resumeInstance);
      return () => {
        cancels++;
      };
    },
    ...overrides,
  });

  return {
    handler,
    waitReasons,
    resends,
    get scheduleCalls() { return scheduleCalls; },
    get cancels() { return cancels; },
    enabled,
    snapshot,
    resumableIds,
    fireScheduled: (instanceId) => scheduled.get(instanceId)?.(instanceId),
    refreshCalls,
  };
}

const CLAUDE: InstanceProvider = 'claude';

describe('InstanceProviderLimitHandler.maybePark', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('parks and schedules a resume when enabled with a future reset time', () => {
    const resumeAt = Date.now() + 60_000;
    const result = h.handler.maybePark({
      instanceId: 'i1',
      provider: CLAUDE,
      resetAtHint: resumeAt,
      reason: 'limit',
      resumePrompt: 'do the thing',
    });
    expect(result).toBe('parked');
    expect(h.scheduleCalls).toBe(1);
    expect(h.waitReasons.get('i1')).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt });
    expect(h.handler.isParked('i1')).toBe(true);
  });

  it('invokes onParked with the park facts (WS7 Phase B offered-switch seam), fail-soft', () => {
    const parkedCalls: Array<{ instanceId: string; provider: string; resumeAt: number }> = [];
    const resumeAt = Date.now() + 60_000;
    const withOffer = makeHarness({
      onParked: (params) => parkedCalls.push(params),
    });
    withOffer.handler.maybePark({
      instanceId: 'i1', provider: CLAUDE, resetAtHint: resumeAt, reason: 'limit', resumePrompt: null,
    });
    expect(parkedCalls).toEqual([{ instanceId: 'i1', provider: 'claude', resumeAt }]);

    // A throwing offer hook must never break the park itself.
    const withThrowingOffer = makeHarness({
      onParked: () => { throw new Error('offer exploded'); },
    });
    const result = withThrowingOffer.handler.maybePark({
      instanceId: 'i2', provider: CLAUDE, resetAtHint: resumeAt, reason: 'limit', resumePrompt: null,
    });
    expect(result).toBe('parked');
    expect(withThrowingOffer.handler.isParked('i2')).toBe(true);
  });

  it('skips when the feature is disabled', () => {
    h.enabled.value = false;
    expect(h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: null })).toBe('skipped');
    expect(h.scheduleCalls).toBe(0);
    expect(h.waitReasons.get('i1')).toBeUndefined();
  });

  it('skips a provider that is not resolved (auto)', () => {
    expect(h.handler.maybePark({ instanceId: 'i1', provider: 'auto', resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: null })).toBe('skipped');
  });

  it('skips when no reset time can be derived (no hint, no snapshot)', () => {
    expect(h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: null, reason: 'x', resumePrompt: null })).toBe('skipped');
  });

  it('fire-and-forgets a quota snapshot refresh on a park-miss (no hint from any source)', () => {
    expect(h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: null, reason: 'x', resumePrompt: null })).toBe('skipped');
    expect(h.refreshCalls).toEqual(['claude']);
  });

  it('does not refresh the snapshot when a park actually succeeds', () => {
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: null });
    expect(h.refreshCalls).toEqual([]);
  });

  it('derives the reset time from the most-constrained quota window when no hint is given', () => {
    const soon = Date.now() + 30_000;
    const later = Date.now() + 90_000;
    h.snapshot.value = makeSnapshot('claude', [
      { used: 10, limit: 100, resetsAt: soon }, // 10%
      { used: 95, limit: 100, resetsAt: later }, // 95% -> most constrained
    ]);
    const result = h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: null, reason: 'x', resumePrompt: null });
    expect(result).toBe('parked');
    expect(h.waitReasons.get('i1')).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt: later });
  });

  it('records a detected model limit and parks a second instance from that known limit', () => {
    const resumeAt = Date.now() + 60_000;
    const events: Array<{ provider: ProviderId; model: string | null; resumeAt: number; instanceId: string | null }> = [];
    const ledger = {
      record: vi.fn((event) => events.push(event)),
      getActive: vi.fn(() => events.length > 0 ? events[0] : null),
      clearActive: vi.fn(() => 0),
    };
    h = makeHarness({ providerLimitLedger: ledger } as unknown as Partial<InstanceProviderLimitHandlerDeps>);

    expect(h.handler.maybePark({
      instanceId: 'first',
      provider: CLAUDE,
      model: 'claude-sonnet-4-5',
      resetAtHint: resumeAt,
      reason: 'limit',
      resumePrompt: null,
    })).toBe('parked');
    expect(events).toMatchObject([{
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      resumeAt,
      instanceId: 'first',
    }]);

    expect(h.handler.maybePark({
      instanceId: 'second',
      provider: CLAUDE,
      model: 'claude-sonnet-4-5',
      resetAtHint: null,
      reason: 'known limit',
      resumePrompt: null,
    })).toBe('parked');
    expect(h.waitReasons.get('second')).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt });
  });

  it('does not double-park an already-parked instance', () => {
    const resumeAt = Date.now() + 60_000;
    expect(h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: resumeAt, reason: 'x', resumePrompt: null })).toBe('parked');
    expect(h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: resumeAt, reason: 'x', resumePrompt: null })).toBe('already-parked');
    expect(h.scheduleCalls).toBe(1);
  });
});

describe('InstanceProviderLimitHandler.maybeParkKnown', () => {
  it('parks from a matching active ledger gate without recording or probing again', () => {
    const resumeAt = Date.now() + 60_000;
    const ledger = {
      record: vi.fn(),
      getActive: vi.fn(() => ({ resumeAt })),
      clearActive: vi.fn(() => 0),
    };
    const h = makeHarness({ providerLimitLedger: ledger } as unknown as Partial<InstanceProviderLimitHandlerDeps>);

    expect(h.handler.maybeParkKnown({
      instanceId: 'second',
      provider: CLAUDE,
      model: 'claude-sonnet-4-5',
      reason: 'known active limit',
      resumePrompt: 'continue the task',
    })).toBe('parked');

    expect(ledger.getActive).toHaveBeenCalledWith({
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      now: expect.any(Number),
    });
    expect(ledger.record).not.toHaveBeenCalled();
    expect(h.refreshCalls).toEqual([]);
    expect(h.waitReasons.get('second')).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt });
  });
});

describe('InstanceProviderLimitHandler.resumeNow', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('clears the park, clears the waitReason, and re-sends the captured turn', () => {
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });
    const resumed = h.handler.resumeNow('i1');
    expect(resumed).toBe(true);
    expect(h.resends).toEqual([{ instanceId: 'i1', prompt: 'resend me' }]);
    expect(h.waitReasons.get('i1')).toBeNull();
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.cancels).toBe(1);
  });

  it('de-dupes a double fire (timer + automation) — the turn is re-sent once', () => {
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });
    // First fire (e.g. in-process timer)
    h.fireScheduled('i1');
    // Second fire (e.g. durable automation) racing the same window
    const second = h.handler.resumeNow('i1', { resumePromptFallback: 'resend me' });
    expect(second).toBe(false);
    expect(h.resends).toHaveLength(1);
  });

  it('resumes post-restart using the fallback prompt when no in-memory park exists', () => {
    // No maybePark() — simulates a fresh process after restart.
    const resumed = h.handler.resumeNow('i-restarted', { resumePromptFallback: 'original turn' });
    expect(resumed).toBe(true);
    expect(h.resends).toEqual([{ instanceId: 'i-restarted', prompt: 'original turn' }]);
  });
});

describe('InstanceProviderLimitHandler.resumeFromAutomation', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('re-sends directly when an in-memory park exists', () => {
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'captured turn' });
    expect(h.handler.resumeFromAutomation('i1', 'captured turn')).toBe('resent');
    expect(h.resends).toEqual([{ instanceId: 'i1', prompt: 'captured turn' }]);
  });

  it('re-sends the fallback when no park exists but the instance is live (post-restart)', () => {
    h.resumableIds.add('i-live');
    expect(h.handler.resumeFromAutomation('i-live', 'original turn')).toBe('resent');
    expect(h.resends).toEqual([{ instanceId: 'i-live', prompt: 'original turn' }]);
    expect(h.waitReasons.get('i-live')).toBeNull();
  });

  it('falls through when no park exists and the instance is not live', () => {
    expect(h.handler.resumeFromAutomation('i-gone', 'original turn')).toBe('fell-through');
    expect(h.resends).toHaveLength(0);
  });

  it('reports resent (not fell-through) when a recent in-process resume already ran', () => {
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'captured turn' });
    h.fireScheduled('i1'); // in-process timer resumes first
    expect(h.handler.resumeFromAutomation('i1', 'captured turn')).toBe('resent');
    expect(h.resends).toHaveLength(1); // not re-sent again
  });
});

describe('InstanceProviderLimitHandler.cancel', () => {
  it('clears the schedule and waitReason and blocks a racing resume', () => {
    const h = makeHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'nope' });
    expect(h.handler.cancel('i1')).toBe(true);
    expect(h.waitReasons.get('i1')).toBeNull();
    expect(h.cancels).toBe(1);
    // A racing timer/automation must not re-send after an explicit cancel.
    expect(h.handler.resumeNow('i1', { resumePromptFallback: 'nope' })).toBe(false);
    expect(h.resends).toHaveLength(0);
  });
});

describe('InstanceProviderLimitHandler.release', () => {
  it('drops the park and cancels the scheduled resume on a normal terminate', () => {
    const h = makeHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });

    h.handler.release('i1');

    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.cancels).toBe(1);
    // Termination is not a user override: waitReason untouched (instance is
    // being deleted), and the resume-dedupe marker is gone with the instance.
    expect(h.waitReasons.get('i1')).toEqual({ kind: 'quota-park', provider: 'claude', resumeAt: expect.any(Number) });
  });

  it('preserves the durable resume on shutdown-style release', () => {
    const h = makeHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });

    h.handler.release('i1', { preserveDurableResume: true });

    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.cancels).toBe(0); // durable automation left standing for post-restart resume
  });

  it('does not clear the ledger known-limit gate (provider is still limited for others)', () => {
    const ledger = { record: vi.fn(), getActive: vi.fn(() => null), clearActive: vi.fn(() => 1) };
    const h = makeHarness({
      providerLimitLedger: ledger,
      getProviderModel: () => ({ provider: CLAUDE, model: 'claude-sonnet-4-5' }),
    } as unknown as Partial<InstanceProviderLimitHandlerDeps>);
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, model: 'claude-sonnet-4-5', resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: null });

    h.handler.release('i1');

    expect(ledger.clearActive).not.toHaveBeenCalled();
  });

  it('clears the resume-dedupe marker so the id can park fresh later, and is a no-op for unknown ids', () => {
    const h = makeHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'turn' });
    h.handler.cancel('i1'); // sets the dedupe marker
    h.handler.release('i1');

    // A fresh park + resume on a recycled id must not be swallowed by the
    // dedupe marker of the terminated predecessor.
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'turn 2' });
    expect(h.handler.resumeNow('i1')).toBe(true);
    expect(h.resends).toEqual([{ instanceId: 'i1', prompt: 'turn 2' }]);

    expect(() => h.handler.release('never-parked')).not.toThrow();
  });

  it('stops the early-resume probe on release', async () => {
    vi.useFakeTimers();
    try {
      const probe = vi.fn(async () => null);
      const h = makeHarness({ probeQuotaSnapshot: probe });
      h.handler.maybePark({
        instanceId: 'i1',
        provider: CLAUDE,
        resetAtHint: Date.now() + 24 * 60 * 60 * 1000,
        reason: 'limit',
        resumePrompt: 'resend me',
      });

      h.handler.release('i1');
      await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InstanceProviderLimitHandler known-limit gate override', () => {
  function makeOverrideHarness() {
    const calls: string[] = [];
    const resends: Array<{ instanceId: string; prompt: string }> = [];
    const ledger = {
      record: vi.fn(() => { calls.push('record'); }),
      getActive: vi.fn(() => null),
      clearActive: vi.fn(() => { calls.push('clearActive'); return 1; }),
    };
    const h = makeHarness({
      providerLimitLedger: ledger,
      getProviderModel: (id: string) => id === 'i-gone'
        ? null
        : { provider: CLAUDE, model: 'claude-sonnet-4-5' },
      resendInput: (id: string, prompt: string) => { calls.push('resend'); resends.push({ instanceId: id, prompt }); },
    } as unknown as Partial<InstanceProviderLimitHandlerDeps>);
    return { h, ledger, calls, resends };
  }

  it('resumeNow drops the durable gate before re-sending, so the preflight cannot re-park the turn', () => {
    const { h, ledger, calls, resends } = makeOverrideHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, model: 'claude-sonnet-4-5', resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });

    expect(h.handler.resumeNow('i1')).toBe(true);
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-sonnet-4-5' });
    // The gate must be gone before the turn is re-dispatched.
    expect(calls).toEqual(['record', 'clearActive', 'resend']);
    expect(resends).toEqual([{ instanceId: 'i1', prompt: 'resend me' }]);
  });

  it('cancel drops the durable gate so the next typed message is not instantly re-held', () => {
    const { h, ledger, resends } = makeOverrideHarness();
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, model: 'claude-sonnet-4-5', resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'nope' });

    expect(h.handler.cancel('i1')).toBe(true);
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-sonnet-4-5' });
    expect(resends).toHaveLength(0);
  });

  it('resumeFromAutomation live-instance branch drops the durable gate before re-sending', () => {
    const { h, ledger, resends } = makeOverrideHarness();
    h.resumableIds.add('i-live');

    expect(h.handler.resumeFromAutomation('i-live', 'original turn')).toBe('resent');
    expect(ledger.clearActive).toHaveBeenCalledWith({ provider: 'claude', model: 'claude-sonnet-4-5' });
    expect(resends).toEqual([{ instanceId: 'i-live', prompt: 'original turn' }]);
  });

  it('tolerates a vanished instance (no provider/model) without touching the ledger', () => {
    const { h, ledger, resends } = makeOverrideHarness();
    expect(h.handler.resumeNow('i-gone', { resumePromptFallback: 'turn' })).toBe(true);
    expect(ledger.clearActive).not.toHaveBeenCalled();
    expect(resends).toEqual([{ instanceId: 'i-gone', prompt: 'turn' }]);
  });

  it('tolerates a missing getProviderModel dep (legacy wiring) without throwing', () => {
    const ledger = { record: vi.fn(), getActive: vi.fn(() => null), clearActive: vi.fn(() => 0) };
    const h = makeHarness({ providerLimitLedger: ledger } as unknown as Partial<InstanceProviderLimitHandlerDeps>);
    h.handler.maybePark({ instanceId: 'i1', provider: CLAUDE, resetAtHint: Date.now() + 60_000, reason: 'x', resumePrompt: 'resend me' });
    expect(h.handler.resumeNow('i1')).toBe(true);
    expect(ledger.clearActive).not.toHaveBeenCalled();
  });
});

describe('InstanceProviderLimitHandler early-resume quota probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const FAR_FUTURE = 24 * 60 * 60 * 1000; // recorded reset a day away (stale-limit scenario)

  function parkWithProbe(probe: (provider: ProviderId) => Promise<ProviderQuotaSnapshot | null>) {
    const h = makeHarness({ probeQuotaSnapshot: probe });
    h.handler.maybePark({
      instanceId: 'i1',
      provider: CLAUDE,
      resetAtHint: Date.now() + FAR_FUTURE,
      reason: 'limit',
      resumePrompt: 'resend me',
    });
    return h;
  }

  it('resumes early when a fresh probe shows every window has headroom', async () => {
    const probe = vi.fn(async () => makeSnapshot('claude', [
      { used: 10, limit: 100, resetsAt: Date.now() + FAR_FUTURE },
    ]));
    const h = parkWithProbe(probe);

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(probe).toHaveBeenCalledWith('claude');
    expect(h.resends).toEqual([{ instanceId: 'i1', prompt: 'resend me' }]);
    expect(h.handler.isParked('i1')).toBe(false);
    expect(h.waitReasons.get('i1')).toBeNull();
  });

  it('stays parked while any window is still exhausted, then resumes once it clears', async () => {
    let exhausted = true;
    const probe = vi.fn(async () => makeSnapshot('claude', [
      { used: exhausted ? 100 : 0, limit: 100, resetsAt: Date.now() + FAR_FUTURE },
      { used: 20, limit: 100, resetsAt: Date.now() + FAR_FUTURE },
    ]));
    const h = parkWithProbe(probe);

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(h.resends).toHaveLength(0);
    expect(h.handler.isParked('i1')).toBe(true);

    exhausted = false; // reset credit applied
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(h.resends).toEqual([{ instanceId: 'i1', prompt: 'resend me' }]);
  });

  it('treats a failed or error probe as still limited', async () => {
    const probe = vi.fn(async () => null);
    const h = parkWithProbe(probe);

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(probe).toHaveBeenCalled();
    expect(h.resends).toHaveLength(0);
    expect(h.handler.isParked('i1')).toBe(true);
  });

  it('stops probing after resumeNow and cancel', async () => {
    const probe = vi.fn(async () => null);
    const h = parkWithProbe(probe);

    h.handler.resumeNow('i1');
    probe.mockClear();
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2 + 5);
    expect(probe).not.toHaveBeenCalled();
  });

  it('skips probing when the scheduled resume is imminent', async () => {
    const probe = vi.fn(async () => makeSnapshot('claude', [
      { used: 0, limit: 100, resetsAt: Date.now() + 60_000 },
    ]));
    const h = makeHarness({ probeQuotaSnapshot: probe });
    // Recorded reset lands before the first probe tick would fire meaningfully.
    h.handler.maybePark({
      instanceId: 'i1',
      provider: CLAUDE,
      resetAtHint: Date.now() + EARLY_RESUME_PROBE_MS + 30_000,
      reason: 'limit',
      resumePrompt: 'resend me',
    });

    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS + 5);
    expect(probe).not.toHaveBeenCalled(); // within 60s of resumeAt — the timer path owns it
  });
});
