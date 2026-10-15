import { afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceProviderLimitHandler, EARLY_RESUME_PROBE_MS, type InstanceProviderLimitHandlerDeps } from './instance-provider-limit-handler';
import type { ProviderLimitEvent, RecordProviderLimitEvent } from '../core/system/provider-limit-ledger';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';

describe('Copilot quota-blind chat parks', () => {
  afterEach(() => vi.useRealTimers());
  it('ignores the monthly horizon, probes nothing, and preserves blindness for another instance preflight', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const resumeAt = now + 6 * 60 * 60_000;
    const snapshot = { provider: 'copilot', takenAt: now + 1, ok: true, source: 'header',
      usageAccess: { ordinaryUsageAllowed: true }, windows: [{ id: 'monthly', label: 'month', unit: 'requests', used: 0, limit: 100, remaining: 100, resetsAt: now + 20 * 86400_000 }],
    } as ProviderQuotaSnapshot;
    const probe = vi.fn(async () => snapshot);
    const getSnapshot = vi.fn(() => snapshot);
    const resend = vi.fn();
    const schedule = vi.fn<NonNullable<InstanceProviderLimitHandlerDeps['scheduleResume']>>(() => vi.fn());
    let recorded: ProviderLimitEvent | null = null;
    const ledger = { record: vi.fn((entry: RecordProviderLimitEvent) => { recorded = { ...entry, id: 'test-limit' }; return recorded; }), getActive: vi.fn(() => recorded),
      clearActive: vi.fn(() => 1), getParkedSince: vi.fn(() => new Map([['legacy', now]])), };
    const handler = new InstanceProviderLimitHandler();
    handler.configure({ isEnabled: () => true, setWaitReason: vi.fn(), resendInput: resend,
      getQuotaSnapshot: getSnapshot, probeQuotaSnapshot: probe, getWorkspaceCwd: () => '/tmp/project',
      scheduleResume: schedule, providerLimitLedger: ledger });
    expect(handler.maybePark({ instanceId: 'copilot-1', provider: 'copilot', resetAtHint: resumeAt,
      reason: 'weekly rate limit', resumePrompt: 'continue', quotaBlind: true })).toBe('parked');
    expect(schedule.mock.calls[0]?.[0].request).toMatchObject({ resumeAt, quotaBlind: true });
    expect(getSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EARLY_RESUME_PROBE_MS * 2);
    expect(probe).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
    expect(handler.maybeParkKnown({ instanceId: 'copilot-2', provider: 'copilot', reason: 'known', resumePrompt: 'continue' })).toBe('parked');
    expect(ledger.clearActive).not.toHaveBeenCalled();
    expect(schedule.mock.calls[1]?.[0].request).toMatchObject({ resumeAt, quotaBlind: true });
    handler._resetForTesting();
  });
});
