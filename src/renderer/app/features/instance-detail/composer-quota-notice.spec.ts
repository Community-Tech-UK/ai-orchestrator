import { describe, expect, it } from 'vitest';
import type { ProviderQuotaSnapshot, ProviderQuotaWindow } from '../../../../shared/types/provider-quota.types';
import { buildComposerQuotaNotice } from './composer-quota-notice';
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
});
