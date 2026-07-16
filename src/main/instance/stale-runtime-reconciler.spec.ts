import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  shouldProbeAdapterProcess,
  StaleRuntimeReconciler,
  type ReconcilerInstanceView,
} from './stale-runtime-reconciler';

const MISSING_PID = Number.MAX_SAFE_INTEGER;

describe('shouldProbeAdapterProcess', () => {
  const adapter = (residentSession: boolean, pid: number | null) => ({
    getAdapterCapabilities: () => ({ residentSession }),
    getPid: () => pid,
  });

  it('only probes a resident adapter whose current local PID matches persisted state', () => {
    expect(shouldProbeAdapterProcess(adapter(true, 42), 42)).toBe(true);
    expect(shouldProbeAdapterProcess(adapter(false, 42), 42)).toBe(false);
    expect(shouldProbeAdapterProcess(adapter(true, null), 42)).toBe(false);
    expect(shouldProbeAdapterProcess(adapter(true, 84), 42)).toBe(false);
  });

  it('retains legacy probing for adapter shapes without runtime capability methods', () => {
    expect(shouldProbeAdapterProcess({}, 42)).toBe(true);
  });
});

describe('StaleRuntimeReconciler', () => {
  afterEach(() => {
    StaleRuntimeReconciler._resetForTesting();
  });

  it('does not mark Antigravity stateless synthetic PIDs as lost runtimes', () => {
    const markRuntimeLost = vi.fn();
    const reconciler = StaleRuntimeReconciler.getInstance({
      getInstances: () => [
        {
          id: 'antigravity-1',
          status: 'busy',
          processId: MISSING_PID,
          provider: 'antigravity',
        } as ReconcilerInstanceView,
      ],
      shouldProbeProcess: () => true,
      markRuntimeLost,
    });

    reconciler.reconcile();

    expect(markRuntimeLost).not.toHaveBeenCalled();
  });

  it('still marks persistent provider PIDs as lost when the process is gone', () => {
    const markRuntimeLost = vi.fn();
    const reconciler = StaleRuntimeReconciler.getInstance({
      getInstances: () => [
        {
          id: 'claude-1',
          status: 'busy',
          processId: MISSING_PID,
          provider: 'claude',
        } as ReconcilerInstanceView,
      ],
      shouldProbeProcess: () => true,
      markRuntimeLost,
    });

    reconciler.reconcile();

    expect(markRuntimeLost).toHaveBeenCalledWith('claude-1');
  });

  it('does not OS-probe a non-resident adapter whose instance carries a synthetic PID', () => {
    const markRuntimeLost = vi.fn();
    const shouldProbeProcess = vi.fn().mockReturnValue(false);
    const reconciler = StaleRuntimeReconciler.getInstance({
      getInstances: () => [
        {
          id: 'codex-exec-1',
          status: 'busy',
          processId: MISSING_PID,
          provider: 'codex',
        } as ReconcilerInstanceView,
      ],
      shouldProbeProcess,
      markRuntimeLost,
    });

    reconciler.reconcile();

    expect(shouldProbeProcess).toHaveBeenCalledWith('codex-exec-1');
    expect(markRuntimeLost).not.toHaveBeenCalled();
  });
});
