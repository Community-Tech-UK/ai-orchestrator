import { describe, expect, it } from 'vitest';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';
import { buildComposerQuotaNotice, formatQuotaWindow } from './composer-quota-notice';
const now = 10000000;
const window = (used: number, id = 'claude.5h'): ProviderQuotaWindow => ({ id, used, limit: 100, remaining: 100 - used,
  label: '5-hour', kind: 'rolling-window', unit: 'percent', resetsAt: now + 1000 });
const snapshot = (used: number): ProviderQuotaSnapshot => ({ provider: 'claude', ok: true, takenAt: now, source: 'admin-api', windows: [window(used)] });
describe('composer quota notice', () => {
  it('appears at 75 percent, strengthens at 90 and never rounds a tiny remainder to zero', () => {
    expect(buildComposerQuotaNotice({ snapshot: snapshot(74), now })).toBeNull();
    expect(buildComposerQuotaNotice({ snapshot: snapshot(76), now })?.text).toContain('24% left');
    expect(buildComposerQuotaNotice({ snapshot: snapshot(92), now })).toMatchObject({ strong: true });
    expect(buildComposerQuotaNotice({ snapshot: snapshot(99.6), now })?.text).toContain('<1% left');
  });
  it('filters overage and model-scoped windows', () => {
    const snap = snapshot(1); snap.windows.push({ ...window(99), id: 'extra', overage: true }, window(95, 'claude.weekly-opus'));
    expect(buildComposerQuotaNotice({ snapshot: snap, sessionModel: 'claude-sonnet-4-6', now })).toBeNull();
    expect(buildComposerQuotaNotice({ snapshot: snap, sessionModel: 'claude-opus-5', now })?.text).toContain('5% left');
  });
  it('retains previous warnings through failed or stale refreshes until fresh data clears them', () => {
    const previous = buildComposerQuotaNotice({ snapshot: snapshot(82), now });
    expect(buildComposerQuotaNotice({ snapshot: { ...snapshot(10), ok: false }, previous, now })?.text).toContain('may be out of date');
    expect(buildComposerQuotaNotice({ snapshot: snapshot(10), previous, now })).toBeNull();
  });
  describe('when the limit resets', () => {
    // Local times on purpose: the day a reset falls on is the reader's own calendar day.
    const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime();
    const resetsAt = (reset: number, current: number) => formatQuotaWindow({ ...window(80), resetsAt: reset }, current).reset;
    it('shows only the time when the reset is later today', () => {
      expect(resetsAt(at(7, 18, 30), at(7, 14, 0))).toBe('18:30');
    });
    it('names the day when the reset is not today, so a weekly reset does not read as later today', () => {
      expect(resetsAt(at(9, 9, 0), at(7, 14, 0))).toBe('Mon 09:00');
      expect(resetsAt(at(8, 0, 30), at(7, 23, 30))).toBe('Sun 00:30');
    });
    it('gives the date when the reset is a week or more away, since a weekday would be ambiguous', () => {
      expect(resetsAt(at(14, 9, 0), at(7, 14, 0))).toBe('14 Nov 09:00');
    });
    it('carries the day into the notice text', () => {
      const weekly = { ...window(80, 'claude.weekly'), label: 'Weekly', resetsAt: at(9, 9, 0) };
      const snap: ProviderQuotaSnapshot = { provider: 'claude', ok: true, takenAt: at(7, 14, 0), source: 'admin-api', windows: [weekly] };
      expect(buildComposerQuotaNotice({ snapshot: snap, now: at(7, 14, 0) })?.text).toBe('Claude Weekly limit: 20% left · resets Mon 09:00');
    });
  });
});
