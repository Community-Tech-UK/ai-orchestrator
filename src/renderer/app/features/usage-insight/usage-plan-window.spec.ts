import { describe, expect, it } from 'vitest';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';
import { claudeWeeklyPlanLine } from './usage-plan-window';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const HOUR = 3_600_000;

function window(overrides: Partial<ProviderQuotaWindow> = {}): ProviderQuotaWindow {
  return {
    kind: 'weekly', id: 'claude.weekly', label: 'Weekly (all models)', unit: 'percent',
    used: 62, limit: 100, remaining: 38, resetsAt: NOW + 2 * 24 * HOUR, ...overrides,
  } as ProviderQuotaWindow;
}

function snapshot(windows: ProviderQuotaWindow[], overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
  return { provider: 'claude', takenAt: NOW, source: 'admin-api', ok: true, windows, ...overrides } as ProviderQuotaSnapshot;
}

describe('claudeWeeklyPlanLine', () => {
  it('leads with how much of the weekly allowance is used and when it resets', () => {
    const line = claudeWeeklyPlanLine([snapshot([window()])], NOW)!;
    expect(line.percentUsed).toBe(62);
    expect(line.text).toMatch(/^Claude weekly allowance: 62% used, resets on [A-Z][a-z]+day at \d{2}:\d{2}\.$/);
  });

  it('says just the time when the reset is within 12 hours', () => {
    const line = claudeWeeklyPlanLine([snapshot([window({ resetsAt: NOW + 3 * HOUR })])], NOW)!;
    expect(line.text).toMatch(/^Claude weekly allowance: 62% used, resets at \d{2}:\d{2}\.$/);
  });

  it('leaves out the reset when it is unknown or already past', () => {
    expect(claudeWeeklyPlanLine([snapshot([window({ resetsAt: null })])], NOW)!.text).toBe('Claude weekly allowance: 62% used.');
    expect(claudeWeeklyPlanLine([snapshot([window({ resetsAt: NOW - 1 })])], NOW)!.text).toBe('Claude weekly allowance: 62% used.');
  });

  it('takes the most-used allowance when there are several accounts', () => {
    const line = claudeWeeklyPlanLine([
      snapshot([window({ used: 30 })]),
      snapshot([window({ used: 88 })], { accountProfileId: 'work' }),
    ], NOW)!;
    expect(line.percentUsed).toBe(88);
  });

  it('works out the percentage from used and limit', () => {
    expect(claudeWeeklyPlanLine([snapshot([window({ unit: 'requests', used: 150, limit: 600 })])], NOW)!.percentUsed).toBe(25);
  });

  it('keeps the percentage between 0 and 100', () => {
    expect(claudeWeeklyPlanLine([snapshot([window({ used: 140 })])], NOW)!.percentUsed).toBe(100);
  });

  it.each([
    ['no snapshots', []],
    ['a missing snapshot', [null, undefined]],
    ['a snapshot that failed', [snapshot([window()], { ok: false })]],
    ['another provider', [snapshot([window()], { provider: 'codex' })]],
    ['only the 5-hour window', [snapshot([window({ id: 'claude.5h' })])]],
    ['a window with no limit', [snapshot([window({ limit: 0 })])]],
    ['extra-usage credits', [snapshot([window({ overage: true })])]],
  ])('shows nothing for %s', (_name, snapshots) => {
    expect(claudeWeeklyPlanLine(snapshots as ProviderQuotaSnapshot[], NOW)).toBeNull();
  });
});
