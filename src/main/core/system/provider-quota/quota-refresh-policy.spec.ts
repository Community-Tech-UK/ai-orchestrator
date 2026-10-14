import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs, shouldSkipPostTurnRefresh } from './quota-refresh-policy';
import type { ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';

describe('quota refresh policy', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const snapshot: ProviderQuotaSnapshot = { provider: 'claude', source: 'header', ok: true, takenAt: now - 599_999, windows: [] };
  it('skips only successful header snapshots under ten minutes old', () => {
    expect(shouldSkipPostTurnRefresh(snapshot, now)).toBe(true);
    for (const other of [null, { ...snapshot, source: 'admin-api' as const }, { ...snapshot, ok: false }, { ...snapshot, takenAt: now - 600_000 }, { ...snapshot, takenAt: now + 1 }])
      expect(shouldSkipPostTurnRefresh(other, now)).toBe(false);
  });
  it('reads whole seconds and HTTP date hints', () => {
    expect(parseRetryAfterMs('120', now)).toBe(120_000);
    expect(parseRetryAfterMs('Sat, 10 Oct 2026 12:02:00 GMT', now)).toBe(120_000);
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs('invalid', now)).toBeUndefined();
  });
});
