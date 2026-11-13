import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { ActivityStateDetector } from '../../providers/activity-state-detector';
import type { RecoveryRecipeEngine } from '../../session/recovery-recipe-engine';
import { IdleMonitor } from './idle-monitor';

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
function harness(status: Instance['status'] = 'idle') {
  let finishDetection!: () => void;
  let finishRecovery!: () => void;
  const detection = new Promise<{ state: 'exited' }>(resolve => { finishDetection = () => resolve({ state: 'exited' }); });
  const recovery = new Promise<{ status: 'recovered' }>(resolve => { finishRecovery = () => resolve({ status: 'recovered' }); });
  const instance = { id: 'sleeping-session', status, processId: null, requestCount: 1, adapterGeneration: 1,
    executionLocation: { type: 'local' } } as Instance;
  const detector = { setPid: vi.fn(), detect: vi.fn(() => detection) } as unknown as ActivityStateDetector;
  const engine = { handleFailure: vi.fn(() => recovery) };
  const dispatchRecovery = vi.fn(async () => undefined);
  const monitor = new IdleMonitor({ getSettings: () => ({ autoTerminateIdleMinutes: 0 }),
    getRecoveryEngine: () => engine as unknown as RecoveryRecipeEngine,
    getActivityDetectors: () => new Map([[instance.id, detector]]), getInstance: () => instance,
    forEachInstance: vi.fn(), getAdapter: vi.fn(), queueUpdate: vi.fn(), deleteAdapter: vi.fn(), transitionState: vi.fn(),
    terminateInstance: vi.fn(async () => undefined), hibernateInstance: vi.fn(async () => undefined), dispatchRecovery });
  return { instance, detector, engine, dispatchRecovery, monitor, finishDetection, finishRecovery };
}

describe('IdleMonitor intentional hibernation', () => {
  it.each(['hibernating', 'hibernated'] as const)('does not classify a deliberately stopped %s process as a crash', async status => {
    const h = harness(status);
    h.monitor.check(); h.finishDetection(); h.finishRecovery(); await flush();
    expect(h.engine.handleFailure).not.toHaveBeenCalled();
    expect(h.dispatchRecovery).not.toHaveBeenCalled();
  });

  it.each(['hibernating', 'hibernated'] as const)('discards detection completed after the instance becomes %s', async status => {
    const h = harness(); h.monitor.check();
    h.instance.status = status; h.finishDetection(); h.finishRecovery(); await flush();
    expect(h.engine.handleFailure).not.toHaveBeenCalled();
    expect(h.dispatchRecovery).not.toHaveBeenCalled();
  });

  it.each(['hibernating', 'hibernated'] as const)('does not dispatch a recovery prepared before the instance becomes %s', async status => {
    const h = harness(); h.monitor.check(); h.finishDetection(); await flush();
    expect(h.engine.handleFailure).toHaveBeenCalledOnce();
    h.instance.status = status; h.finishRecovery(); await flush();
    expect(h.dispatchRecovery).not.toHaveBeenCalled();
  });

  it('discards a dead-process result belonging to the runtime before a completed wake', async () => {
    const h = harness(); h.monitor.check();
    h.instance.adapterGeneration = 2; h.finishDetection(); h.finishRecovery(); await flush();
    expect(h.engine.handleFailure).not.toHaveBeenCalled();
    expect(h.dispatchRecovery).not.toHaveBeenCalled();
  });

  it('still recovers a genuinely unexpected exit in the current runtime', async () => {
    const h = harness(); h.monitor.check(); h.finishDetection(); await flush(); h.finishRecovery(); await flush();
    expect(h.dispatchRecovery).toHaveBeenCalledWith(h.instance.id, expect.objectContaining({ category: 'process_exited_unexpected' }));
  });
});
