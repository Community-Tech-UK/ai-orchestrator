import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderContextActionExecutor } from '../context-evidence/provider-context-action-executor';
import { CompactionCoordinator } from './compaction-coordinator';

describe('CompactionCoordinator strategy selection', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  it('uses native compaction when supported and successful', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => true,
    });

    const result = await coordinator.compactInstance('inst-native');

    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('uses restart-with-summary when native compaction is not supported', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => false,
    });

    const result = await coordinator.compactInstance('inst-restart');

    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    expect(nativeCompact).not.toHaveBeenCalled();
    expect(restartCompact).toHaveBeenCalledTimes(1);
  });

  it('falls back to restart-with-summary when native compaction fails', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => false);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => true,
    });

    const result = await coordinator.compactInstance('inst-fallback');

    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(restartCompact).toHaveBeenCalledTimes(1);
  });
});

describe('CompactionCoordinator self-managed auto-compaction', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  it('skips background auto-trigger at 80% when adapter self-manages auto-compaction', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => false,
      selfManagesAutoCompaction: () => true,
    });

    coordinator.onContextUpdate('inst-self', {
      used: 800_000,
      total: 1_000_000,
      percentage: 80,
    });

    // Yield twice for any deferred microtasks the coordinator may post.
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeCompact).not.toHaveBeenCalled();
    expect(restartCompact).not.toHaveBeenCalled();
    expect(coordinator.isSelfManagedAutoCompaction('inst-self')).toBe(true);
  });

  it('skips blocking auto-trigger at 95% when adapter self-manages auto-compaction', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => false,
      selfManagesAutoCompaction: () => true,
    });

    coordinator.onContextUpdate('inst-self', {
      used: 950_000,
      total: 1_000_000,
      percentage: 95,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(nativeCompact).not.toHaveBeenCalled();
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('still runs the strategy chain for manual compactInstance() even when adapter self-manages', async () => {
    // Critical: explicit user-driven compaction (Compact button / IPC
    // `instance:compact` / orchestrator `/compact`) must NOT silently no-op
    // just because the adapter says it self-manages auto-compaction. Without
    // a callable native hook, the coordinator falls through to
    // restart-with-summary so a real compaction occurs.
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => false);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => false,
      selfManagesAutoCompaction: () => true,
    });

    const result = await coordinator.compactInstance('inst-manual');

    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    expect(restartCompact).toHaveBeenCalledTimes(1);
  });

  it('skips auto-trigger but keeps manual native compaction for self-managed native adapters', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);

    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => true,
      selfManagesAutoCompaction: () => true,
    });

    coordinator.onContextUpdate('inst-codex-app-server', {
      used: 850_000,
      total: 1_000_000,
      percentage: 85,
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(nativeCompact).not.toHaveBeenCalled();
    expect(restartCompact).not.toHaveBeenCalled();

    const result = await coordinator.compactInstance('inst-codex-app-server');

    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(nativeCompact).toHaveBeenCalledTimes(1);
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('still emits context-warning events for self-managed adapters so the UI shows pressure', () => {
    const coordinator = CompactionCoordinator.getInstance();

    coordinator.configure({
      nativeCompact: vi.fn(async () => true),
      restartCompact: vi.fn(async () => true),
      supportsNativeCompaction: () => false,
      selfManagesAutoCompaction: () => true,
    });

    const warnings: { percentage: number; level: string }[] = [];
    coordinator.on('context-warning', (payload) => {
      warnings.push({ percentage: payload.percentage, level: payload.level });
    });

    coordinator.onContextUpdate('inst-self', {
      used: 800_000,
      total: 1_000_000,
      percentage: 80,
    });
    coordinator.onContextUpdate('inst-self', {
      used: 950_000,
      total: 1_000_000,
      percentage: 95,
    });

    // 80% emits a `critical`, 95% emits an `emergency`.
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.some((w) => w.level === 'critical')).toBe(true);
    expect(warnings.some((w) => w.level === 'emergency')).toBe(true);
  });
});

describe('CompactionCoordinator cumulative-token trigger (claude2_todo #34b)', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  // Background compaction is fire-and-forget; let its async chain settle.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  function configured() {
    const coordinator = CompactionCoordinator.getInstance();
    const nativeCompact = vi.fn(async () => true);
    const restartCompact = vi.fn(async () => true);
    coordinator.configure({
      nativeCompact,
      restartCompact,
      supportsNativeCompaction: () => false, // force the restart path so we can assert on it
    });
    return { coordinator, nativeCompact, restartCompact };
  }

  it('normalizes the trigger value (negative/NaN/0 → disabled; positive → floored)', () => {
    const { coordinator } = configured();
    coordinator.setCumulativeTokenTrigger(-5);
    expect(coordinator.getCumulativeTokenTrigger()).toBe(0);
    coordinator.setCumulativeTokenTrigger(Number.NaN);
    expect(coordinator.getCumulativeTokenTrigger()).toBe(0);
    coordinator.setCumulativeTokenTrigger(250_000.9);
    expect(coordinator.getCumulativeTokenTrigger()).toBe(250_000);
  });

  it('does NOT compact on cumulative spend when disabled (default 0), even far above any threshold', async () => {
    const { coordinator, restartCompact } = configured();
    coordinator.onContextUpdate('inst-a', {
      used: 100_000,
      total: 1_000_000,
      percentage: 10,
      cumulativeTokens: 5_000_000,
    });
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('keeps the legacy custom cumulative trigger as deprecated telemetry only', async () => {
    const { coordinator, restartCompact } = configured();
    coordinator.setCumulativeTokenTrigger(100_000);
    coordinator.onContextUpdate('inst-b', {
      used: 120_000,
      total: 1_000_000,
      percentage: 12, // well below the 80% background threshold
      cumulativeTokens: 150_000,
    });
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('does NOT trigger when cumulative spend is below the threshold', async () => {
    const { coordinator, restartCompact } = configured();
    coordinator.setCumulativeTokenTrigger(100_000);
    coordinator.onContextUpdate('inst-c', {
      used: 50_000,
      total: 1_000_000,
      percentage: 5,
      cumulativeTokens: 50_000,
    });
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('respects the auto-compact master switch (no cumulative trigger when auto-compact is off)', async () => {
    const { coordinator, restartCompact } = configured();
    coordinator.setCumulativeTokenTrigger(100_000);
    coordinator.setAutoCompact(false);
    coordinator.onContextUpdate('inst-d', {
      used: 120_000,
      total: 1_000_000,
      percentage: 12,
      cumulativeTokens: 500_000,
    });
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();
  });

  it('does not restore a second policy owner when the legacy trigger is configured', async () => {
    const { coordinator, restartCompact } = configured();
    coordinator.setCumulativeTokenTrigger(100_000);
    const usage = {
      used: 120_000,
      total: 1_000_000,
      percentage: 12,
      cumulativeTokens: 150_000,
    };
    coordinator.onContextUpdate('inst-e', usage);
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();

    // Same cumulative spend arrives again — baseline reset + guards must
    // prevent a re-trigger.
    coordinator.onContextUpdate('inst-e', usage);
    await flush();
    expect(restartCompact).not.toHaveBeenCalled();
  });
});

describe('CompactionCoordinator shared safety policy', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  it('marks legacy warning events deprecated without using their thresholds as action owners', async () => {
    const coordinator = CompactionCoordinator.getInstance();
    const warnings: Record<string, unknown>[] = [];
    const actions: string[] = [];
    coordinator.on('context-warning', (event) => warnings.push(event));
    coordinator.configure({
      getContextCapabilities: () => ({
        toolResultControl: 'post-retention',
        toolResultVisibility: 'full',
        transcriptControl: 'native-compaction',
        occupancyReporting: 'current',
        cumulativeReporting: 'available',
        interruptProof: 'observed',
        compactionProof: 'observed',
        sameThreadContinuation: true,
      }),
      getContextEvidenceMode: () => 'enforce',
      getProviderActionExecutor: () => new ProviderContextActionExecutor({
        'native-compaction': async () => { actions.push('native-compaction'); return { proof: 'observed' }; },
      }),
    });

    coordinator.onContextUpdate('inst-policy', { used: 80, total: 100, percentage: 80 });
    await coordinator.drainPolicyDecisions('inst-policy');

    expect(actions).toEqual(['native-compaction']);
    expect(warnings).toContainEqual(expect.objectContaining({
      deprecated: true,
      legacyThreshold: 80,
    }));
  });
});
