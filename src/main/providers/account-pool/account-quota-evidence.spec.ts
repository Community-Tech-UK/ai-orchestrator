import { describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../shared/types/provider-quota.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { quotaEvidenceFromSnapshot } from './account-quota-evidence';

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
