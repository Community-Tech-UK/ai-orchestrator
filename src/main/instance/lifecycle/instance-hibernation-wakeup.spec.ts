import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceTerminationDeps } from './instance-termination';
const mocks = vi.hoisted(() => ({ startTracking: vi.fn(async () => undefined), stopTracking: vi.fn(async () => undefined) }));
vi.mock('./spawn-config-builder', () => ({ SpawnConfigBuilder: class {} }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/tmp/aio-synthetic-hibernation' } }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: () => mocks }));
vi.mock('../../process/hibernation-manager', () => ({ getHibernationManager: () => ({ markHibernated: vi.fn() }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { InstanceLifecycleManager } from '../instance-lifecycle';
import { InstanceTerminationCoordinator } from './instance-termination';
import { getSelfWakeupTracker, SelfWakeupTracker } from '../self-wakeup-tracker';

describe('hibernation pending wakeup warning', () => {
  afterEach(() => { SelfWakeupTracker._resetForTesting(); vi.clearAllMocks(); });
  it('publishes once and saves the warning before detaching the process', async () => {
    const instance = { id: 'stub-session', status: 'idle', outputBuffer: [], childrenIds: [], contextUsage: { used: 0, total: 1000, percentage: 0 } } as unknown as Instance;
    const now = Date.now();
    getSelfWakeupTracker().observe(instance.id, { kind: 'requested', toolUseId: 'stub-tool', requestedAt: now, delaySeconds: 90, dueAt: now + 90_000, reason: '' });
    // Drive the real hibernation method against an in-memory lifecycle host.
    const manager = Object.setPrototypeOf(new EventEmitter(), InstanceLifecycleManager.prototype) as InstanceLifecycleManager;
    const adapter = { removeAllListeners: vi.fn(), terminate: vi.fn(async () => undefined) };
    const deps = { getInstance: () => instance, getAdapter: () => adapter, queueUpdate: vi.fn(), deleteAdapter: vi.fn() } as unknown as LifecycleDependencies;
    const coordinatorDeps: InstanceTerminationDeps = {
      getInstance: () => instance, getAdapter: () => undefined, deleteAdapter: () => false, deleteInstance: () => false,
      forceReleaseSessionMutex: vi.fn(), removeActivityDetector: vi.fn(), clearRecoveryHistory: vi.fn(),
      transitionState: vi.fn(), terminateChild: vi.fn(async () => undefined), unregisterSupervisor: vi.fn(),
      unregisterOrchestration: vi.fn(), clearFirstMessageTracking: vi.fn(), endRlmSession: vi.fn(),
      deleteOutputStorage: vi.fn(async () => undefined), archiveInstance: vi.fn(async () => undefined),
      importTranscript: vi.fn(), emitRemoved: vi.fn(),
      emitSystemOutput: (instanceId, message) => { manager.emit('output', { instanceId, message }); },
    };
    const coordinator = new InstanceTerminationCoordinator(coordinatorDeps);
    Object.assign(manager, { deps, terminator: coordinator, transitionState: (_instance: Instance, status: Instance['status']) => { instance.status = status; } });
    const output = vi.fn(); manager.on('output', output);
    let saved: string[] = [];
    mocks.startTracking.mockImplementationOnce(async () => { saved = instance.outputBuffer.map(message => message.content); });

    await manager.hibernateInstance(instance.id);
    expect(instance.status).toBe('hibernated');
    expect(saved).toEqual(['This session ended while Claude had a wake-up pending; it will not happen.']);
    expect(output).toHaveBeenCalledOnce();
    expect(mocks.startTracking.mock.invocationCallOrder[0]).toBeLessThan(adapter.removeAllListeners.mock.invocationCallOrder[0]);
    coordinator.warnLostWakeup(instance.id, instance);
    expect(output).toHaveBeenCalledOnce();
    expect(instance.outputBuffer).toHaveLength(1);
  });
});
