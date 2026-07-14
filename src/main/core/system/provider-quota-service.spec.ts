import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProviderQuotaService, type ProviderQuotaProbe } from './provider-quota-service';
import type {
  ProviderId,
  ProviderQuotaAlert,
  ProviderQuotaSnapshot,
} from '../../../shared/types/provider-quota.types';

/** Build a snapshot fragment shaped for `ingestFromAdapter`. */
function makeIngest(
  provider: ProviderId,
  used: number,
  limit: number,
  windowId = `${provider}.test-window`,
  windowOverrides: Partial<ProviderQuotaSnapshot['windows'][number]> = {},
): Omit<ProviderQuotaSnapshot, 'takenAt' | 'source'> {
  return {
    provider,
    ok: true,
    windows: [
      {
        kind: 'rolling-window',
        id: windowId,
        label: 'Test Window',
        unit: 'messages',
        used,
        limit,
        remaining: Math.max(0, limit - used),
        resetsAt: null,
        ...windowOverrides,
      },
    ],
  };
}

/** Build a complete snapshot for probe return values. */
function makeSnapshot(
  provider: ProviderId,
  used: number,
  limit: number,
): ProviderQuotaSnapshot {
  return {
    ...makeIngest(provider, used, limit),
    takenAt: Date.now(),
    source: 'slash-command',
  };
}

class FakeProbe implements ProviderQuotaProbe {
  calls = 0;
  constructor(
    public readonly provider: ProviderId,
    private result: ProviderQuotaSnapshot | null,
  ) {}
  async probe(): Promise<ProviderQuotaSnapshot | null> {
    this.calls += 1;
    return this.result;
  }
}

describe('ProviderQuotaService', () => {
  let svc: ProviderQuotaService;

  beforeEach(() => {
    svc = new ProviderQuotaService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    svc._resetForTesting();
  });

  describe('initial state', () => {
    it('returns null for every provider', () => {
      const all = svc.getAll();
      expect(all.snapshots.claude).toBeNull();
      expect(all.snapshots.codex).toBeNull();
      expect(all.snapshots.gemini).toBeNull();
      expect(all.snapshots.copilot).toBeNull();
      expect(all.snapshots.cursor).toBeNull();
    });

    it('getSnapshot returns null when no snapshot stored', () => {
      expect(svc.getSnapshot('claude')).toBeNull();
    });
  });

  describe('ingestFromAdapter', () => {
    it('stores the snapshot with takenAt and default source=header', () => {
      svc.ingestFromAdapter('claude', makeIngest('claude', 10, 100));
      const snap = svc.getSnapshot('claude');
      expect(snap).not.toBeNull();
      expect(snap!.takenAt).toBeGreaterThan(0);
      expect(snap!.source).toBe('header');
      expect(snap!.windows[0].used).toBe(10);
    });

    it('honours an explicit source override', () => {
      svc.ingestFromAdapter('claude', makeIngest('claude', 10, 100), 'cli-result');
      expect(svc.getSnapshot('claude')!.source).toBe('cli-result');
    });

    it('emits quota-updated', () => {
      const handler = vi.fn();
      svc.on('quota-updated', handler);
      svc.ingestFromAdapter('claude', makeIngest('claude', 10, 100));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].provider).toBe('claude');
    });
  });

  describe('quota pacing', () => {
    it('emits an early pacing warning when a five-hour window is 90% used before 72% elapsed', () => {
      const warnings: unknown[] = [];
      svc.on('quota-pacing-warning', (warning) => warnings.push(warning));
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      svc.ingestFromAdapter(
        'claude',
        makeIngest('claude', 90, 100, 'claude.5h', {
          label: '5-hour messages',
          resetsAt: now + 90 * 60_000,
        }),
      );

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        provider: 'claude',
        utilizationPercent: 90,
        elapsedPercent: 70,
      });
    });
  });

  describe('refresh()', () => {
    it('returns null when no probe is registered', async () => {
      expect(await svc.refresh('codex')).toBeNull();
    });

    it('stores the snapshot returned by the probe', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      const out = await svc.refresh('claude');
      expect(out).not.toBeNull();
      expect(svc.getSnapshot('claude')).not.toBeNull();
      expect(probe.calls).toBe(1);
    });

    it('retries a transient probe failure through the shared backoff policy', async () => {
      let calls = 0;
      const probe: ProviderQuotaProbe = {
        provider: 'claude',
        async probe() {
          calls += 1;
          if (calls === 1) throw new Error('network timeout');
          return makeSnapshot('claude', 50, 100);
        },
      };
      svc.registerProbe(probe);

      const out = await svc.refresh('claude');

      expect(calls).toBe(2);
      expect(out).toMatchObject({ provider: 'claude', ok: true });
    });

    it('returns null without storing when probe returns null', async () => {
      const probe = new FakeProbe('claude', null);
      svc.registerProbe(probe);
      const out = await svc.refresh('claude');
      expect(out).toBeNull();
      expect(svc.getSnapshot('claude')).toBeNull();
    });

    it('stores an error snapshot when probe throws', async () => {
      const probe: ProviderQuotaProbe = {
        provider: 'claude',
        async probe() {
          throw new Error('boom');
        },
      };
      svc.registerProbe(probe);
      const out = await svc.refresh('claude');
      expect(out).not.toBeNull();
      expect(out!.ok).toBe(false);
      expect(out!.error).toContain('boom');
      expect(out!.windows).toEqual([]);
      expect(svc.getSnapshot('claude')).not.toBeNull();
    });
  });

  describe('CLI-installed gating', () => {
    it('skips the probe and stores a cliNotInstalled snapshot when the CLI is missing', async () => {
      const probe = new FakeProbe('cursor', makeSnapshot('cursor', 50, 100));
      svc.registerProbe(probe);
      svc.setCliInstalledCheck(async () => false);

      const handler = vi.fn();
      svc.on('quota-updated', handler);

      const out = await svc.refresh('cursor');
      expect(probe.calls).toBe(0);
      expect(out).not.toBeNull();
      expect(out!.ok).toBe(false);
      expect(out!.cliNotInstalled).toBe(true);
      expect(out!.windows).toEqual([]);
      expect(svc.getSnapshot('cursor')!.cliNotInstalled).toBe(true);
      // The marker snapshot is pushed so the renderer replaces stale data.
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('replaces a previously stored snapshot when the CLI disappears', async () => {
      const probe = new FakeProbe('cursor', makeSnapshot('cursor', 50, 100));
      svc.registerProbe(probe);
      svc.ingestFromAdapter('cursor', makeIngest('cursor', 50, 100));
      expect(svc.getSnapshot('cursor')!.ok).toBe(true);

      svc.setCliInstalledCheck(async () => false);
      await svc.refresh('cursor');
      expect(svc.getSnapshot('cursor')!.cliNotInstalled).toBe(true);
    });

    it('probes normally when the CLI is installed', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.setCliInstalledCheck(async () => true);
      const out = await svc.refresh('claude');
      expect(probe.calls).toBe(1);
      expect(out!.ok).toBe(true);
      expect(out!.cliNotInstalled).toBeUndefined();
    });

    it('fails open (probes anyway) when the check throws', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.setCliInstalledCheck(async () => {
        throw new Error('detection exploded');
      });
      const out = await svc.refresh('claude');
      expect(probe.calls).toBe(1);
      expect(out!.ok).toBe(true);
    });

    it('gates per provider on refreshAll()', async () => {
      const claudeProbe = new FakeProbe('claude', makeSnapshot('claude', 1, 100));
      const cursorProbe = new FakeProbe('cursor', makeSnapshot('cursor', 2, 100));
      svc.registerProbe(claudeProbe);
      svc.registerProbe(cursorProbe);
      svc.setCliInstalledCheck(async (provider) => provider === 'claude');

      const out = await svc.refreshAll();
      expect(claudeProbe.calls).toBe(1);
      expect(cursorProbe.calls).toBe(0);
      expect(out.find((s) => s.provider === 'claude')!.ok).toBe(true);
      expect(out.find((s) => s.provider === 'cursor')!.cliNotInstalled).toBe(true);
    });
  });

  describe('refreshAll()', () => {
    it('returns [] when no probes registered', async () => {
      const out = await svc.refreshAll();
      expect(out).toEqual([]);
    });

    it('calls every registered probe', async () => {
      const claudeProbe = new FakeProbe('claude', makeSnapshot('claude', 1, 100));
      const codexProbe = new FakeProbe('codex', makeSnapshot('codex', 2, 100));
      svc.registerProbe(claudeProbe);
      svc.registerProbe(codexProbe);
      const out = await svc.refreshAll();
      expect(out).toHaveLength(2);
      expect(claudeProbe.calls).toBe(1);
      expect(codexProbe.calls).toBe(1);
    });
  });

  describe('alert thresholds', () => {
    it('emits quota-warning at 50% crossing', () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 60, 100));
      expect(warnings.some((w) => w.threshold === 50)).toBe(true);
    });

    it('emits all crossed warning thresholds in one snapshot', () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 91, 100));
      const thresholds = warnings.map((w) => w.threshold).sort((a, b) => a - b);
      expect(thresholds).toEqual([50, 75, 90]);
    });

    it('emits quota-exhausted (not quota-warning) at 100%', () => {
      const warnings: ProviderQuotaAlert[] = [];
      const exhausted: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.on('quota-exhausted', (a: ProviderQuotaAlert) => exhausted.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 100, 100));
      expect(exhausted).toHaveLength(1);
      expect(warnings.find((w) => w.threshold === 100)).toBeUndefined();
    });

    it('does not re-emit a threshold for repeated snapshots above it', () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 60, 100));
      svc.ingestFromAdapter('claude', makeIngest('claude', 65, 100));
      expect(warnings.filter((w) => w.threshold === 50)).toHaveLength(1);
    });

    it('re-emits thresholds after a window reset (used drops)', () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 60, 100));
      svc.ingestFromAdapter('claude', makeIngest('claude', 5, 100));   // window reset
      svc.ingestFromAdapter('claude', makeIngest('claude', 60, 100));  // re-cross 50%
      expect(warnings.filter((w) => w.threshold === 50)).toHaveLength(2);
    });

    it('does not emit alerts when limit is 0 (unknown/unlimited)', () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      svc.ingestFromAdapter('claude', makeIngest('claude', 100, 0));
      expect(warnings).toHaveLength(0);
    });

    it('does not emit alerts on a failed snapshot', async () => {
      const warnings: ProviderQuotaAlert[] = [];
      svc.on('quota-warning', (a: ProviderQuotaAlert) => warnings.push(a));
      const probe: ProviderQuotaProbe = {
        provider: 'claude',
        async probe() {
          throw new Error('boom');
        },
      };
      svc.registerProbe(probe);
      await svc.refresh('claude');
      expect(warnings).toHaveLength(0);
    });
  });

  describe('polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('fires an immediate refresh and then on the configured interval', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startPolling('claude', 1000);
      // Drain microtasks so the immediate refresh resolves, but DO NOT
      // advance fake-timer time yet — the 1000ms interval tick must remain
      // pending so we can observe it on the next step.
      await Promise.resolve();
      await Promise.resolve();
      expect(probe.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.calls).toBe(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.calls).toBe(3);
    });

    it('stopPolling cancels future refreshes', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startPolling('claude', 1000);
      await vi.runOnlyPendingTimersAsync();
      const before = probe.calls;
      svc.stopPolling('claude');
      await vi.advanceTimersByTimeAsync(5000);
      expect(probe.calls).toBe(before);
    });

    it('startPolling with intervalMs=0 does not schedule', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startPolling('claude', 0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probe.calls).toBe(0);
    });

    it('calling startPolling twice replaces the prior timer', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startPolling('claude', 1000);
      await vi.runOnlyPendingTimersAsync();
      svc.startPolling('claude', 5000); // replace
      await vi.runOnlyPendingTimersAsync();
      const after = probe.calls; // 1 (first start) + 1 (re-start immediate)
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.calls).toBe(after); // would be > if old 1s timer still alive
      await vi.advanceTimersByTimeAsync(4000);
      expect(probe.calls).toBe(after + 1); // exactly one tick of the 5s timer
    });
  });

  describe('idle refresh', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('does NOT fire immediately but refreshes every interval', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startIdleRefresh(1000);
      await Promise.resolve();
      await Promise.resolve();
      expect(probe.calls).toBe(0); // no immediate burst on idle poll
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(probe.calls).toBe(2);
    });

    it('refreshes every registered probe on a tick', async () => {
      const claude = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      const codex = new FakeProbe('codex', makeSnapshot('codex', 10, 100));
      svc.registerProbe(claude);
      svc.registerProbe(codex);
      svc.startIdleRefresh(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(claude.calls).toBe(1);
      expect(codex.calls).toBe(1);
    });

    it('stopIdleRefresh cancels future ticks', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startIdleRefresh(1000);
      await vi.advanceTimersByTimeAsync(1000);
      const before = probe.calls;
      svc.stopIdleRefresh();
      await vi.advanceTimersByTimeAsync(5000);
      expect(probe.calls).toBe(before);
    });

    it('intervalMs=0 disables the idle poll', async () => {
      const probe = new FakeProbe('claude', makeSnapshot('claude', 50, 100));
      svc.registerProbe(probe);
      svc.startIdleRefresh(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(probe.calls).toBe(0);
    });
  });
});
