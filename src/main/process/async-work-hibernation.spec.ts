import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { MemoryStats } from '../memory/memory-monitor';
import { IdleMonitor, type IdleMonitorDeps } from '../instance/lifecycle/idle-monitor';
import { HibernationManager } from './hibernation-manager';
import { ResourceGovernor } from './resource-governor';
import {
  _resetForTesting as resetAsyncWorkRegistry,
  getInstanceAsyncWorkRegistry,
} from '../instance/instance-async-work-registry';

function inhibit(instanceId: string): void {
  getInstanceAsyncWorkRegistry().observe(instanceId, {
    phase: 'started',
    workId: 'bg-1',
    kind: 'background-shell',
  });
}

describe('automatic hibernation async-work inhibitor', () => {
  beforeEach(() => {
    resetAsyncWorkRegistry();
  });

  it('excludes inhibited instances from HibernationManager candidates', () => {
    const manager = new HibernationManager({ idleThresholdMs: 100 });
    inhibit('protected');

    expect(manager.getHibernationCandidates([
      { id: 'protected', status: 'idle', lastActivity: 0 },
      { id: 'ordinary', status: 'idle', lastActivity: 0 },
    ], 1_000)).toEqual([
      { id: 'ordinary', status: 'idle', lastActivity: 0 },
    ]);
  });

  it('does not reclaim an inhibited instance at critical memory pressure', () => {
    const memoryMonitor = new EventEmitter() as EventEmitter & {
      requestGC: () => boolean;
      getPressureLevel: () => 'critical';
    };
    memoryMonitor.requestGC = vi.fn(() => true);
    memoryMonitor.getPressureLevel = () => 'critical';
    const hibernateInstance = vi.fn(async () => undefined);
    const instanceManager = {
      on: vi.fn(),
      getInstanceCount: vi.fn(() => 1),
      getIdleInstances: vi.fn(() => [{
        id: 'protected',
        lastActivity: 0,
        hasConversation: true,
      }]),
      terminateInstance: vi.fn(async () => undefined),
      hibernateInstance,
      emitSystemMessage: vi.fn(),
    };
    const governor = new ResourceGovernor({
      getMemoryMonitor: () => memoryMonitor,
      getInstanceManager: () => instanceManager,
      getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    }, { idleThresholdMs: 0 });
    inhibit('protected');
    governor.start();

    memoryMonitor.emit('critical', { heapUsedMB: 1_000 } as MemoryStats);

    expect(hibernateInstance).not.toHaveBeenCalled();
    expect(instanceManager.emitSystemMessage).not.toHaveBeenCalled();
    governor.stop();
  });

  it('skips inhibited child sessions in both IdleMonitor reclaim paths', () => {
    const protectedInstance = {
      id: 'protected',
      displayName: 'Protected',
      parentId: 'parent',
      status: 'idle',
      lastActivity: 0,
      outputBuffer: [{ type: 'user' }],
    } as Instance;
    const hibernateInstance = vi.fn(async () => undefined);
    const terminateInstance = vi.fn(async () => undefined);
    const deps = {
      getSettings: () => ({ autoTerminateIdleMinutes: 1 }),
      getRecoveryEngine: () => null,
      getActivityDetectors: () => new Map(),
      getInstance: () => protectedInstance,
      forEachInstance: (cb: (instance: Instance, id: string) => void) => cb(protectedInstance, protectedInstance.id),
      getAdapter: () => undefined,
      queueUpdate: vi.fn(),
      deleteAdapter: vi.fn(),
      transitionState: vi.fn(),
      terminateInstance,
      hibernateInstance,
      dispatchRecovery: vi.fn(async () => undefined),
      isLifecycleLocked: () => false,
    } satisfies IdleMonitorDeps;
    const monitor = new IdleMonitor(deps);
    inhibit('protected');

    monitor.check();
    monitor.terminateIdleHalf();

    expect(hibernateInstance).not.toHaveBeenCalled();
    expect(terminateInstance).not.toHaveBeenCalled();
  });
});
