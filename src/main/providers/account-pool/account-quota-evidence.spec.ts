import { describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../shared/types/provider-quota.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { quotaEvidenceFromSnapshot } from './account-quota-evidence';
import { selectAccount } from './provider-account-selector';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { parseMimoTokenPlanResponses } from '../../core/system/provider-quota/mimo-token-plan-probe';

function window(id: string, used: number, resetsAt: number | null = null): ProviderQuotaWindow {
  return { kind: 'rolling-window', id, label: id, unit: 'percent', used, limit: 100, remaining: 100 - used, resetsAt };
}

function snapshot(overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
  return { provider: 'codex', takenAt: 5_000, source: 'admin-api', ok: true, windows: [], ...overrides };
}

describe('quotaEvidenceFromSnapshot', () => {
  it('reads 5-hour and weekly utilisation and the weekly reset', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({ windows: [window('codex.5h', 40), window('codex.weekly', 70, 9_000)] })))
      .toEqual({ fiveHourPct: 40, weeklyPct: 70, weeklyResetsAt: 9_000, usable: null, creditsOnly: false, observedAt: 5_000 });
  });

  it('treats a spent plan window with credits available as usable on credits only', () => {
    // Shape observed from a topped-up Codex Pro account: weekly spent, included usage refused, credits on hand.
    const evidence = quotaEvidenceFromSnapshot(snapshot({
      windows: [window('codex.weekly', 100, 9_000)],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true },
    }));
    expect(evidence).toMatchObject({ weeklyPct: 100, usable: true, creditsOnly: true });
  });

  it('treats a spent plan window with no credits as unusable', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({
      windows: [window('codex.weekly', 100)],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: false },
    }))).toMatchObject({ usable: false, creditsOnly: false });
  });

  it('trusts the provider refusing included usage even when the windows have room', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({
      windows: [window('codex.weekly', 20)],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: null },
    }))).toMatchObject({ usable: false });
  });

  it('leaves the verdict unknown when the windows are spent but nothing is known about credits', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({ windows: [window('codex.weekly', 100)] }))).toMatchObject({ usable: null });
  });

  it('uses the verdict\'s own observation time when it is older than the snapshot', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({
      windows: [window('codex.weekly', 100)],
      usageAccess: { ordinaryUsageAllowed: null, creditsAvailable: true, observedAt: 1_000 },
    }))).toMatchObject({ usable: true, observedAt: 1_000 });
  });

  it('returns null for a failed or empty snapshot', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({ ok: false }))).toBeNull();
    expect(quotaEvidenceFromSnapshot(snapshot())).toBeNull();
    expect(quotaEvidenceFromSnapshot(null)).toBeNull();
  });
});


describe('MiMo calendar allowance to account selection', () => {
  const profiles: ProviderAccountProfile[] = ['a', 'b'].map((id, priority) => ({
    id, priority, provider: 'opencode', label: id, expectedIdentity: null, expectedAccountKey: null,
    planLabel: null, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
    region: 'ams', createdAt: 1, updatedAt: 1,
  }));
  function allowance(plan: number, monthly: number, compensation?: number) {
    const parsed = parseMimoTokenPlanResponses({ data: { usage: { items: [
      { name: 'plan_total_token', used: plan, limit: 100 },
      { name: 'month_total_token', used: monthly, limit: 100 },
      ...(compensation === undefined ? [] : [{ name: 'compensation_total_token', used: compensation, limit: 100 }]),
    ] } } }, { data: { currentPeriodEnd: '2026-11-01 00:00:00' } });
    return quotaEvidenceFromSnapshot(snapshot({ provider: 'opencode', windows: parsed.windows }));
  }
  function choose(plan: number, monthly: number, compensation?: number, thresholdPct?: number) {
    const evidence = allowance(plan, monthly, compensation);
    return selectAccount({ profiles, origin: 'interactive', parkedProfileIds: [],
      bindings: new Map([['a', 'authenticated'], ['b', 'authenticated']]),
      quotaByProfile: evidence ? new Map([['a', evidence]]) : undefined, thresholdPct,
      allowCredits: false });
  }
  it.each([[90, 10], [10, 90], [95, 10]])('steers at the 90%% plan/monthly boundary (%s, %s)', (plan, monthly) => {
    expect(choose(plan, monthly, undefined, 90)).toMatchObject({ profileId: 'b',
      considered: [{ profileId: 'a', vetoReason: 'over-threshold' }] });
  });
  it('keeps an account below threshold even with spent compensation', () => {
    expect(choose(89, 10, 100, 90).profileId).toBe('a');
  });
  it.each([[100, 10], [10, 100]])('vetoes exhausted allowance without compensation (%s, %s)', (plan, monthly) => {
    expect(choose(plan, monthly)).toMatchObject({ profileId: 'b',
      considered: [{ profileId: 'a', vetoReason: 'exhausted' }] });
  });
  it('uses remaining compensation as free allowance after plan exhaustion', () => {
    expect(allowance(100, 100, 20)).toMatchObject({ allowancePct: 20, usable: null, creditsOnly: false });
    expect(choose(100, 100, 20, 90).profileId).toBe('a');
    expect(choose(100, 100, 90, 90)).toMatchObject({ profileId: 'b',
      considered: [{ profileId: 'a', vetoReason: 'over-threshold' }] });
    expect(choose(100, 100, 100)).toMatchObject({ profileId: 'b',
      considered: [{ profileId: 'a', vetoReason: 'exhausted' }] });
  });
  it('does not count unknown calendar buckets as MiMo allowance', () => {
    expect(quotaEvidenceFromSnapshot(snapshot({ provider: 'opencode', windows: [
      { ...window('opencode.other', 100), kind: 'calendar-period' },
    ] }))).toBeNull();
  });
});
