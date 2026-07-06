import { afterEach, describe, expect, it, vi } from 'vitest';

import { StaleRuntimeReconciler, type ReconcilerInstanceView } from './stale-runtime-reconciler';

const MISSING_PID = Number.MAX_SAFE_INTEGER;

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
      markRuntimeLost,
    });

    reconciler.reconcile();

    expect(markRuntimeLost).toHaveBeenCalledWith('claude-1');
  });
});
