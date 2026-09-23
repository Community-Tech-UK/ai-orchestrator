import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { ProviderQuotaService } from '../../core/system/provider-quota-service';
import { attachAccountTelemetryBridge, claudeAccessAfterFullWindow, claudeTelemetryWindow } from './account-telemetry-bridge';

let service: ProviderQuotaService;

beforeEach(() => {
  service = new ProviderQuotaService();
});

describe('account telemetry bridge', () => {
  it('maps Claude rate_limit_info to windows by type, fraction or percent, rejected as exhausted', () => {
    expect(claudeTelemetryWindow({ rateLimitType: 'five_hour', utilization: 0.42, resetsAt: 100 })).toMatchObject({ id: 'claude.5h', used: 42, resetsAt: 100_000 });
    expect(claudeTelemetryWindow({ rateLimitType: 'seven_day_opus', utilization: 55 })).toMatchObject({ id: 'claude.weekly-opus', used: 55 });
    expect(claudeTelemetryWindow({ rateLimitType: 'five_hour', status: 'rejected' })).toMatchObject({ used: 100 });
    expect(claudeTelemetryWindow({ rateLimitType: 'overage', utilization: 0.5 })).toBeNull();
    expect(claudeTelemetryWindow({ rateLimitType: 'five_hour', status: 'allowed' })).toBeNull();
  });

  it('merges Claude telemetry into the profile snapshot without touching the legacy one', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, { provider: 'claude', profileId: 'max-b', source: 'default', executionNodeId: 'local' }, service);
    service.ingestFromAdapter('claude', {
      provider: 'claude', ok: true,
      windows: [{ kind: 'rolling-window', id: 'claude.weekly', label: 'Weekly', unit: 'messages', used: 10, limit: 100, remaining: 90, resetsAt: null }],
    }, 'admin-api', 'max-b');
    adapter.emit('rate-limit-telemetry', { rateLimitType: 'five_hour', utilization: 0.9, resetsAt: 50 });
    const snapshot = service.getSnapshot('claude', 'max-b');
    expect(snapshot?.accountProfileId).toBe('max-b');
    expect(snapshot?.windows.map((window) => [window.id, window.used]).sort()).toEqual([['claude.5h', 90], ['claude.weekly', 10]]);
    expect(service.getSnapshot('claude')).toBeNull();
    expect(service.getAll().accountSnapshots).toHaveLength(1);
  });

  it('lets a full Claude window override the usage probe\'s older "allowed" verdict', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, { provider: 'claude', profileId: 'max-b', source: 'default', executionNodeId: 'local' }, service);
    const probe = (): void => service.ingestFromAdapter('claude', {
      provider: 'claude', ok: true,
      windows: [{ kind: 'rolling-window', id: 'claude.weekly', label: 'Weekly', unit: 'messages', used: 10, limit: 100, remaining: 90, resetsAt: null }],
      usageAccess: { ordinaryUsageAllowed: true, creditsAvailable: null },
    }, 'admin-api', 'max-b');

    // A window with headroom leaves the verdict alone.
    probe();
    const probedAt = service.getSnapshot('claude', 'max-b')!.takenAt;
    adapter.emit('rate-limit-telemetry', { rateLimitType: 'five_hour', utilization: 0.4 });
    expect(service.getSnapshot('claude', 'max-b')?.usageAccess)
      .toEqual({ ordinaryUsageAllowed: true, creditsAvailable: null, observedAt: probedAt });

    // A rejected account-wide window says the included usage is spent now.
    adapter.emit('rate-limit-telemetry', { rateLimitType: 'seven_day', status: 'rejected' });
    const rejected = service.getSnapshot('claude', 'max-b')?.usageAccess;
    expect(rejected).toMatchObject({ ordinaryUsageAllowed: false, creditsAvailable: null });
    expect(rejected?.observedAt).toBeGreaterThanOrEqual(probedAt);

    // A rejected model-scoped window only makes the account-wide verdict unknown.
    probe();
    adapter.emit('rate-limit-telemetry', { rateLimitType: 'seven_day_opus', status: 'rejected' });
    expect(service.getSnapshot('claude', 'max-b')?.usageAccess).toBeUndefined();
  });

  it('keeps credits and a not-allowed verdict when a model-scoped Claude window fills', () => {
    expect(claudeAccessAfterFullWindow({ id: 'claude.weekly-opus' }, { ordinaryUsageAllowed: true, creditsAvailable: true, observedAt: 5 }))
      .toEqual({ ordinaryUsageAllowed: null, creditsAvailable: true, observedAt: 5 });
    const spent = { ordinaryUsageAllowed: false, creditsAvailable: null, observedAt: 5 };
    expect(claudeAccessAfterFullWindow({ id: 'claude.weekly-opus' }, spent)).toBe(spent);
    expect(claudeAccessAfterFullWindow({ id: 'claude.weekly-opus' }, undefined)).toBeUndefined();
  });

  it('merges sparse Codex updates across events', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, { provider: 'codex', profileId: 'pro-b', source: 'default', executionNodeId: 'local' }, service);
    adapter.emit('account-rate-limits', { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 10 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 20 } });
    adapter.emit('account-rate-limits', { primary: { usedPercent: 70, windowDurationMins: 300, resetsAt: 10 } });
    const windows = service.getSnapshot('codex', 'pro-b')?.windows ?? [];
    expect(windows.map((window) => [window.id, window.used])).toEqual([['codex.5h', 70], ['codex.weekly', 5]]);
  });

  it('keeps usage access across live Codex updates without making an old verdict look new', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, { provider: 'codex', profileId: 'pro-b', source: 'default', executionNodeId: 'local' }, service);
    service.ingestFromAdapter('codex', {
      provider: 'codex', ok: true,
      windows: [{ kind: 'rolling-window', id: 'codex.weekly', label: 'Weekly', unit: 'percent', used: 100, limit: 100, remaining: 0, resetsAt: null }],
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: true },
    }, 'admin-api', 'pro-b');
    const probedAt = service.getSnapshot('codex', 'pro-b')!.takenAt;

    // No credits block: the credits verdict survives with its original time; the included-usage verdict is dropped.
    adapter.emit('account-rate-limits', { primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 20 } });
    expect(service.getSnapshot('codex', 'pro-b')?.usageAccess)
      .toEqual({ ordinaryUsageAllowed: null, creditsAvailable: true, observedAt: probedAt });

    // A credits block is new evidence.
    adapter.emit('account-rate-limits', { credits: { hasCredits: false, unlimited: false } });
    const access = service.getSnapshot('codex', 'pro-b')?.usageAccess;
    expect(access).toMatchObject({ ordinaryUsageAllowed: null, creditsAvailable: false });
    expect(access?.observedAt).toBeGreaterThanOrEqual(probedAt);
  });

  it('parses a raw app-server update that carries rateLimitReachedType instead of mistaking it for a parsed snapshot', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, { provider: 'codex', profileId: 'pro-b', source: 'default', executionNodeId: 'local' }, service);
    // The real `account/rateLimits/updated` shape: resetsAt in seconds, credits as a block.
    adapter.emit('account-rate-limits', {
      limitId: 'codex',
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_790_169_067 },
      secondary: null,
      credits: { hasCredits: true, unlimited: false, balance: '12' },
      planType: 'pro',
      rateLimitReachedType: null,
    });
    const snapshot = service.getSnapshot('codex', 'pro-b');
    expect(snapshot?.usageAccess).toMatchObject({ ordinaryUsageAllowed: null, creditsAvailable: true });
    expect(snapshot?.windows[0]?.resetsAt).toBe(1_790_169_067_000);
  });

  it('does nothing without a route', () => {
    const adapter = new EventEmitter();
    attachAccountTelemetryBridge(adapter, undefined, service);
    expect(adapter.listenerCount('rate-limit-telemetry')).toBe(0);
  });
});
