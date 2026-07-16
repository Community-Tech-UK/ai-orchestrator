/**
 * Fable WS2 Task 4 — quota pacing warning → WS10 notification bridging.
 *
 * The renderer badge path is covered by provider-quota.store / chip specs; the
 * builder here is the operator-notification half. Dedupe behaviour itself is
 * the NotificationService's contract (notification-service.spec.ts) — this
 * spec pins the fingerprint inputs that make dedupe key on provider+window.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

import { buildQuotaPacingNotification } from '../quota-handlers';
import type { ProviderQuotaPacingAlert } from '../../../../shared/types/provider-quota.types';

function alert(over: Partial<ProviderQuotaPacingAlert> = {}): ProviderQuotaPacingAlert {
  return {
    provider: 'claude',
    window: {
      kind: 'rolling-window',
      id: 'claude.5h-messages',
      label: '5-hour messages',
      unit: 'messages',
      used: 90,
      limit: 100,
      remaining: 10,
      resetsAt: 10_000,
    } as ProviderQuotaPacingAlert['window'],
    utilizationPercent: 90.4,
    elapsedPercent: 41.6,
    utilizationThresholdPercent: 90,
    latestElapsedPercent: 72,
    timestamp: 1_000,
    ...over,
  };
}

describe('buildQuotaPacingNotification', () => {
  it('produces an operator-readable pacing notification', () => {
    const input = buildQuotaPacingNotification(alert());
    expect(input.kind).toBe('quota-pacing');
    expect(input.title).toContain('claude');
    expect(input.body).toContain('5-hour messages');
    expect(input.body).toContain('90%');
    expect(input.body).toContain('42%');
    expect(input.urgency).toBe('normal');
  });

  it('fingerprints on provider + window id so repeats within a window dedupe', () => {
    const a = buildQuotaPacingNotification(alert());
    const b = buildQuotaPacingNotification(alert({ utilizationPercent: 95, timestamp: 2_000 }));
    expect(a.fingerprintFields).toEqual({ provider: 'claude', windowId: 'claude.5h-messages' });
    // Volatile fields (percent, timestamp) must NOT be part of the fingerprint.
    expect(b.fingerprintFields).toEqual(a.fingerprintFields);

    const other = buildQuotaPacingNotification(alert({
      window: { ...alert().window, id: 'claude.weekly-messages', label: 'Weekly messages' },
    }));
    expect(other.fingerprintFields).not.toEqual(a.fingerprintFields);
  });
});
