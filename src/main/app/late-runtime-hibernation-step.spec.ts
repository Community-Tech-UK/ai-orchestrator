import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronHarness = vi.hoisted(() => {
  // require(+.ts) avoids ESM TDZ: vi.hoisted runs before import bindings initialize
  const { createElectronHarness } =
    require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
  return createElectronHarness({ powerMonitor: 'stub' });
});
vi.mock('electron', () => electronHarness.module);

const settings = vi.hoisted(() => ({ autoTerminateIdleMinutes: 30 }));
const loops = vi.hoisted(() => ({ active: [] as Array<{ chatId: string; endedAt: number | null }> }));
vi.mock('../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => ({ getActiveLoops: () => loops.active }),
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => settings[key as keyof typeof settings],
    getAll: () => settings,
  }),
}));

import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { HibernationManager, getHibernationManager } from '../process/hibernation-manager';
import { JitterScheduler } from '../tasks/jitter-scheduler';
import { createLateRuntimeInitializationSteps } from './late-runtime-initialization-steps';

const MINUTE = 60_000;

function fakeInstance(overrides: Partial<Instance> & { id: string }): Instance {
  return {
    status: 'idle',
    parentId: null,
    lastActivity: Date.now() - 45 * MINUTE,
    executionLocation: { type: 'local' },
    displayName: overrides.id,
    ...overrides,
  } as Instance;
}

describe('late runtime Hibernation manager step', () => {
  beforeEach(() => {
    settings.autoTerminateIdleMinutes = 30;
    loops.active = [];
    JitterScheduler._resetForTesting();
    HibernationManager._resetForTesting();
  });

  afterEach(() => {
    HibernationManager._resetForTesting();
    JitterScheduler._resetForTesting();
  });

  it('hibernates idle root sessions on the check-idle tick and leaves the rest alone', async () => {
    const hibernateInstance = vi.fn(async () => undefined);
    const terminateInstance = vi.fn(async () => undefined);
    const instanceManager = {
      getAllInstances: () => [
        fakeInstance({ id: 'stale-root' }),
        fakeInstance({ id: 'fresh-root', lastActivity: Date.now() - 5 * MINUTE }),
        fakeInstance({ id: 'busy-root', status: 'busy' }),
        fakeInstance({ id: 'child', parentId: 'stale-root' }),
        fakeInstance({ id: 'remote-root', executionLocation: { type: 'remote', nodeId: 'node-1' } }),
        fakeInstance({ id: 'parked-loop-chat' }),
        fakeInstance({ id: 'finished-loop-chat' }),
      ],
      hibernateInstance,
      terminateInstance,
    } as unknown as InstanceManager;

    const steps = createLateRuntimeInitializationSteps({
      instanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const step = steps.find((candidate) => candidate.name === 'Hibernation manager');
    expect(step).toBeDefined();
    await step!.fn();

    loops.active = [
      { chatId: 'parked-loop-chat', endedAt: null },
      { chatId: 'finished-loop-chat', endedAt: Date.now() - 60 * MINUTE },
    ];
    getHibernationManager().emit('check-idle');

    expect(hibernateInstance).toHaveBeenCalledTimes(2);
    expect(hibernateInstance).toHaveBeenCalledWith('stale-root');
    expect(hibernateInstance).toHaveBeenCalledWith('finished-loop-chat');
    expect(hibernateInstance).not.toHaveBeenCalledWith('parked-loop-chat');
    expect(terminateInstance).not.toHaveBeenCalled();
  });

  it('does nothing when the setting is 0', async () => {
    settings.autoTerminateIdleMinutes = 0;
    const hibernateInstance = vi.fn(async () => undefined);
    const instanceManager = {
      getAllInstances: () => [fakeInstance({ id: 'stale-root', lastActivity: Date.now() - 6 * 60 * MINUTE })],
      hibernateInstance,
      terminateInstance: vi.fn(async () => undefined),
    } as unknown as InstanceManager;

    const steps = createLateRuntimeInitializationSteps({
      instanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    await steps.find((candidate) => candidate.name === 'Hibernation manager')!.fn();

    getHibernationManager().emit('check-idle');

    expect(hibernateInstance).not.toHaveBeenCalled();
  });
});
