/**
 * Fable WS2 Task 4 — quota pacing warning → WS10 notification bridging.
 *
 * The renderer badge path is covered by provider-quota.store / chip specs; the
 * builder here is the operator-notification half. Dedupe behaviour itself is
 * the NotificationService's contract (notification-service.spec.ts) — this
 * spec pins the fingerprint inputs that make dedupe key on provider+window.
 */

import { describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  quotaOn: vi.fn(),
  notify: vi.fn(),
  sendToRenderer: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../core/system/provider-quota-service', () => ({
  getProviderQuotaService: () => ({ on: harness.quotaOn }),
}));

vi.mock('../../../notifications/notification-service', () => ({
  getNotificationService: () => ({ notify: harness.notify }),
}));

import {
  buildQuotaPacingNotification,
  buildQuotaReauthNotification,
  registerQuotaHandlers,
} from '../quota-handlers';
import type { ProviderQuotaPacingAlert, ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';

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

describe('buildQuotaReauthNotification', () => {
  it('names the provider and carries the probe instruction', () => {
    const input = buildQuotaReauthNotification({
      provider: 'opencode',
      takenAt: 1,
      source: 'admin-api',
      ok: false,
      error: 'MiMo console session rejected (401/403) — sign in to the MiMo console in Chrome again',
      needsReauth: true,
      windows: [],
    });
    expect(input.kind).toBe('quota-reauth');
    expect(input.title).toContain('opencode');
    expect(input.body).toContain('sign in to the MiMo console');
    expect(input.urgency).toBe('normal');
    expect(input.fingerprintFields).toEqual({ provider: 'opencode', accountProfileId: null });
  });

  it('fingerprints per account profile so pool accounts dedupe separately', () => {
    const base = {
      provider: 'claude' as const,
      takenAt: 1,
      source: 'admin-api' as const,
      ok: false,
      needsReauth: true,
      windows: [],
    };
    expect(buildQuotaReauthNotification(base).fingerprintFields)
      .toEqual({ provider: 'claude', accountProfileId: null });
    expect(buildQuotaReauthNotification({ ...base, accountProfileId: 'max-b' }).fingerprintFields)
      .toEqual({ provider: 'claude', accountProfileId: 'max-b' });
  });
});

describe('quota reauth notification (transition tracking)', () => {
  const snap = (over: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot => ({
    provider: 'opencode',
    takenAt: 1,
    source: 'admin-api',
    ok: true,
    windows: [],
    ...over,
  });

  function drive(): (s: ProviderQuotaSnapshot) => void {
    harness.quotaOn.mockClear();
    harness.notify.mockClear();
    harness.notify.mockImplementation(() => undefined);
    harness.sendToRenderer.mockClear();
    registerQuotaHandlers({ windowManager: { sendToRenderer: harness.sendToRenderer } as never });
    const entry = harness.quotaOn.mock.calls.find(([event]) => event === 'quota-updated');
    expect(entry).toBeTruthy();
    return entry![1] as (s: ProviderQuotaSnapshot) => void;
  }

  it('notifies once on the expiry transition, not on every stale refresh', () => {
    const onUpdated = drive();

    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' }));
    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' }));
    onUpdated(snap({ ok: true, needsReauth: true, error: 'expired' })); // cached bars

    expect(harness.notify).toHaveBeenCalledTimes(1);
    // the wiring path must deliver the reauth builder's payload, not just any call
    expect(harness.notify).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'quota-reauth',
      title: expect.stringContaining('opencode'),
    }));
    // the renderer push is never skipped, stale or not
    expect(harness.sendToRenderer).toHaveBeenCalledTimes(3);
  });

  it('notifies again after a recovery and a new expiry', () => {
    const onUpdated = drive();

    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' }));
    onUpdated(snap({ ok: true })); // session renewed
    onUpdated(snap({ ok: true }));
    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired again' }));

    expect(harness.notify).toHaveBeenCalledTimes(2);
  });

  it('tracks expiry per account profile independently', () => {
    const onUpdated = drive();

    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' }));
    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired', accountProfileId: 'max-b' }));
    onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' })); // legacy already tracked

    expect(harness.notify).toHaveBeenCalledTimes(2);
  });

  it('never lets a notification failure break event forwarding', () => {
    const onUpdated = drive();
    harness.notify.mockImplementation(() => {
      throw new Error('notification backend down');
    });

    expect(() => onUpdated(snap({ ok: false, needsReauth: true, error: 'expired' }))).not.toThrow();
    expect(harness.sendToRenderer).toHaveBeenCalledTimes(1);
  });
});
