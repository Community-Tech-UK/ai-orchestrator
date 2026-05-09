import { beforeEach, describe, expect, it, vi } from 'vitest';
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
