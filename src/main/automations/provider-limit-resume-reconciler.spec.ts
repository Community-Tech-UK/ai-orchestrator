import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../../shared/types/automation.types';
import type { ProviderQuotaSnapshot } from '../../shared/types/provider-quota.types';
import {
  reconcileProviderLimitResumeAutomations,
  startProviderLimitResumeReconciler,
} from './provider-limit-resume-reconciler';

const NOW = 1_784_000_000_000;

function makeResumeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'resume-1',
    name: 'Resume session after codex quota reset',
    enabled: true,
    active: true,
    workspaceId: '/repo',
    schedule: { type: 'oneTime', runAt: NOW + 6 * 60 * 60_000, timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'runOnce',
    concurrencyPolicy: 'skip',
    destination: { kind: 'thread', instanceId: 'inst-1', reviveIfArchived: true },
    action: {
      prompt: 'Continue the previous task.',
      workingDirectory: '/repo',
      provider: 'codex',
      systemAction: { type: 'instanceProviderLimitResume', instanceId: 'inst-1' },
    },
    nextFireAt: NOW + 6 * 60 * 60_000,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  };
}

function liftedSnapshot(): ProviderQuotaSnapshot {
  return {
    provider: 'codex',
    takenAt: NOW,
    source: 'admin-api',
    ok: true,
    windows: [{
      kind: 'rolling-window',
      id: 'codex.weekly',
      label: 'Weekly',
      unit: 'requests',
      used: 49,
      limit: 100,
      remaining: 51,
      resetsAt: NOW + 5 * 24 * 60 * 60_000,
    }],
  };
}

function pinnedSnapshot(): ProviderQuotaSnapshot {
  const snapshot = liftedSnapshot();
  snapshot.windows[0] = { ...snapshot.windows[0], used: 100, remaining: 0 };
  return snapshot;
}

describe('reconcileProviderLimitResumeAutomations', () => {
  it('fires a pending resume automation when the live quota shows the limit lifted', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'started' });
    const probeQuota = vi.fn().mockResolvedValue(liftedSnapshot());

    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [makeResumeAutomation()],
      fire,
      probeQuota,
      now: () => NOW,
    });

    expect(fired).toBe(1);
    expect(probeQuota).toHaveBeenCalledWith('codex');
    expect(fire).toHaveBeenCalledWith(expect.objectContaining({ id: 'resume-1' }), 'codex');
  });

  it('keeps waiting while any quota window is still pinned', async () => {
    const fire = vi.fn();
    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [makeResumeAutomation()],
      fire,
      probeQuota: vi.fn().mockResolvedValue(pinnedSnapshot()),
      now: () => NOW,
    });
    expect(fired).toBe(0);
    expect(fire).not.toHaveBeenCalled();
  });

  it('treats a probe failure or errored snapshot as still limited', async () => {
    const fire = vi.fn();
    await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [makeResumeAutomation()],
      fire,
      probeQuota: vi.fn().mockRejectedValue(new Error('offline')),
      now: () => NOW,
    });
    await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [makeResumeAutomation()],
      fire,
      probeQuota: vi.fn().mockResolvedValue(null),
      now: () => NOW,
    });
    expect(fire).not.toHaveBeenCalled();
  });

  it('ignores non-candidates: disabled, inactive, cron, imminent, and non-resume automations', async () => {
    const fire = vi.fn();
    const probeQuota = vi.fn().mockResolvedValue(liftedSnapshot());
    const automations = [
      makeResumeAutomation({ id: 'a-disabled', enabled: false }),
      makeResumeAutomation({ id: 'a-inactive', active: false }),
      makeResumeAutomation({
        id: 'a-cron',
        schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      }),
      makeResumeAutomation({
        id: 'a-imminent',
        schedule: { type: 'oneTime', runAt: NOW + 30_000, timezone: 'UTC' },
      }),
      makeResumeAutomation({
        id: 'a-plain',
        action: { prompt: 'daily digest', workingDirectory: '/repo', provider: 'codex' },
      }),
    ];

    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => automations,
      fire,
      probeQuota,
      now: () => NOW,
    });

    expect(fired).toBe(0);
    expect(probeQuota).not.toHaveBeenCalled();
    expect(fire).not.toHaveBeenCalled();
  });

  it('probes each provider once and fires every lifted candidate for it', async () => {
    const fire = vi.fn().mockResolvedValue({ status: 'started' });
    const probeQuota = vi.fn().mockResolvedValue(liftedSnapshot());
    const automations = [
      makeResumeAutomation({ id: 'resume-1' }),
      makeResumeAutomation({ id: 'resume-2' }),
    ];

    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => automations,
      fire,
      probeQuota,
      now: () => NOW,
    });

    expect(fired).toBe(2);
    expect(probeQuota).toHaveBeenCalledTimes(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('keeps firing remaining candidates when one fire call throws', async () => {
    const fire = vi.fn()
      .mockRejectedValueOnce(new Error('dispatch failed'))
      .mockResolvedValue({ status: 'started' });
    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [
        makeResumeAutomation({ id: 'resume-1' }),
        makeResumeAutomation({ id: 'resume-2' }),
      ],
      fire,
      probeQuota: vi.fn().mockResolvedValue(liftedSnapshot()),
      now: () => NOW,
    });
    expect(fired).toBe(1);
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('skips automations without a concrete provider', async () => {
    const probeQuota = vi.fn();
    const automation = makeResumeAutomation();
    automation.action = { ...automation.action, provider: undefined };
    const fired = await reconcileProviderLimitResumeAutomations({
      listAutomations: async () => [automation],
      fire: vi.fn(),
      probeQuota,
      now: () => NOW,
    });
    expect(fired).toBe(0);
    expect(probeQuota).not.toHaveBeenCalled();
  });
});

describe('startProviderLimitResumeReconciler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs after the initial delay and again on the interval; stopper disarms both', async () => {
    vi.useFakeTimers();
    const listAutomations = vi.fn().mockResolvedValue([]);
    const stop = startProviderLimitResumeReconciler(
      { listAutomations, fire: vi.fn(), probeQuota: vi.fn() },
      { initialDelayMs: 1_000, intervalMs: 10_000 },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(listAutomations).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(listAutomations).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listAutomations).toHaveBeenCalledTimes(2);
  });
});
