import { describe, expect, it, vi } from 'vitest';
import { IdleMonitor } from '../idle-monitor';
import type { ActivityStateDetector } from '../../../providers/activity-state-detector';
import type { RecoveryRecipeEngine } from '../../../session/recovery-recipe-engine';
import type { Instance } from '../../../../shared/types/instance.types';

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('IdleMonitor', () => {
  it('refreshes detector PID from the live instance before detecting activity', async () => {
    let detectorPid = 111;
    const detector = {
      setPid: vi.fn((pid: number) => {
        detectorPid = pid;
      }),
      detect: vi.fn(async () => ({
        state: detectorPid === 222 ? 'idle' as const : 'exited' as const,
        confidence: 'low' as const,
        staleAfterMs: 0,
        source: 'test',
      })),
    } as unknown as ActivityStateDetector;
    const recoveryEngine = {
      handleFailure: vi.fn(async () => ({ status: 'recovered' as const })),
    } as unknown as RecoveryRecipeEngine;

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => recoveryEngine,
      getActivityDetectors: () => new Map([['instance-1', detector]]),
      getInstance: () => ({
        id: 'instance-1',
        status: 'busy',
        processId: 222,
        executionLocation: { type: 'local' },
      } as unknown as Instance),
      forEachInstance: vi.fn(),
      getAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery: vi.fn(async () => undefined),
    });

    monitor.check();
    await flushAsyncWork();

    expect(detector.setPid).toHaveBeenCalledWith(222);
    expect(detector.detect).toHaveBeenCalledOnce();
    expect(recoveryEngine.handleFailure).not.toHaveBeenCalled();
  });

  it('still dispatches unexpected-exit recovery when the refreshed detector reports exited', async () => {
    const detector = {
      setPid: vi.fn(),
      detect: vi.fn(async () => ({
        state: 'exited' as const,
        confidence: 'low' as const,
        staleAfterMs: 0,
        source: 'test',
      })),
    } as unknown as ActivityStateDetector;
    const recoveryEngine = {
      handleFailure: vi.fn(async () => ({ status: 'recovered' as const })),
    } as unknown as RecoveryRecipeEngine;
    const dispatchRecovery = vi.fn(async () => undefined);

    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
      getRecoveryEngine: () => recoveryEngine,
      getActivityDetectors: () => new Map([['instance-1', detector]]),
      getInstance: () => ({
        id: 'instance-1',
        status: 'busy',
        processId: null,
        executionLocation: { type: 'local' },
      } as unknown as Instance),
      forEachInstance: vi.fn(),
      getAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance: vi.fn(async () => undefined),
      dispatchRecovery,
    });

    monitor.check();
    await flushAsyncWork();
    await flushAsyncWork();

    expect(detector.setPid).not.toHaveBeenCalled();
    expect(recoveryEngine.handleFailure).toHaveBeenCalledWith(expect.objectContaining({
      category: 'process_exited_unexpected',
      instanceId: 'instance-1',
    }));
    expect(dispatchRecovery).toHaveBeenCalledWith('instance-1', expect.objectContaining({
      category: 'process_exited_unexpected',
    }));
  });
});
