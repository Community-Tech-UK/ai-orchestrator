import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../../../shared/types/instance.types';
import {
  _resetInstanceProviderLimitHandlerForTesting,
  getInstanceProviderLimitHandler,
} from '../../instance-provider-limit-handler';
import { InstanceTerminationCoordinator, type InstanceTerminationDeps } from '../instance-termination';

function makeAdapter(): CliAdapter {
  const adapter = new EventEmitter() as EventEmitter & Partial<CliAdapter>;
  adapter.terminate = vi.fn().mockResolvedValue(undefined);
  adapter.getName = vi.fn(() => 'codex-cli');
  return adapter as CliAdapter;
}

function makeMessage(
  id: string,
  type: OutputMessage['type'],
  content: string,
): OutputMessage {
  return {
    id,
    type,
    content,
    timestamp: Date.now(),
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Instance',
    createdAt: 1,
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: 'supervisor-1',
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: {
      enabled: false,
      state: 'off',
    },
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200_000,
      percentage: 0,
    },
    lastActivity: 1,
    processId: 123,
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    executionLocation: { type: 'local' },
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    totalTokensUsed: 0,
    subscribedTo: [],
    communicationTokens: new Map(),
    errorCount: 0,
    requestCount: 0,
    restartCount: 0,
    ...overrides,
  } as Instance;
}

describe('InstanceTerminationCoordinator', () => {
  let instances: Map<string, Instance>;
  let adapters: Map<string, CliAdapter>;
  let deps: InstanceTerminationDeps;

  beforeEach(() => {
    instances = new Map<string, Instance>();
    adapters = new Map<string, CliAdapter>();
    deps = {
      getAdapter: (id) => adapters.get(id),
      getInstance: (id) => instances.get(id),
      deleteAdapter: vi.fn((id) => adapters.delete(id)),
      deleteInstance: vi.fn((id) => instances.delete(id)),
      stopStuckTracking: vi.fn(),
      deleteDiffTracker: vi.fn(),
      deleteStateMachine: vi.fn(),
      forceReleaseSessionMutex: vi.fn(),
      removeActivityDetector: vi.fn(),
      clearRecoveryHistory: vi.fn(),
      transitionState: vi.fn((instance, status) => {
        instance.status = status;
      }),
      setWaitReason: vi.fn(),
      terminateChild: vi.fn().mockResolvedValue(undefined),
      unregisterSupervisor: vi.fn(),
      unregisterOrchestration: vi.fn(),
      clearFirstMessageTracking: vi.fn(),
      endRlmSession: vi.fn(),
      deleteOutputStorage: vi.fn().mockResolvedValue(undefined),
      archiveInstance: vi.fn().mockResolvedValue(undefined),
      importTranscript: vi.fn(),
      emitRemoved: vi.fn(),
    };
  });

  it('cleans up failed terminal instances without forcing a second state transition', async () => {
    const instance = makeInstance({ status: 'failed' });
    const adapter = makeAdapter();
    instances.set(instance.id, instance);
    adapters.set(instance.id, adapter);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id);

    expect(adapter.terminate).toHaveBeenCalledWith(true);
    expect(deps.transitionState).not.toHaveBeenCalled();
    expect(deps.deleteAdapter).toHaveBeenCalledWith(instance.id);
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
    expect(deps.forceReleaseSessionMutex).toHaveBeenCalledWith(instance.id);
    expect(deps.emitRemoved).toHaveBeenCalledWith(instance.id);
  });

  it('surfaces a terminating waitReason during a graceful terminate, then clears it', async () => {
    const instance = makeInstance();
    const adapter = makeAdapter();
    instances.set(instance.id, instance);
    adapters.set(instance.id, adapter);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    const calls = (deps.setWaitReason as ReturnType<typeof vi.fn>).mock.calls;
    // First call sets the terminating reason; a later call clears it (null).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const [firstId, firstReason] = calls[0];
    expect(firstId).toBe(instance.id);
    expect(firstReason).toMatchObject({ kind: 'terminating', force: false });
    expect(typeof firstReason.startedAt).toBe('number');
    expect(typeof firstReason.deadlineAt).toBe('number');
    expect(calls[calls.length - 1]).toEqual([instance.id, null]);

    // The waitReason must be set BEFORE the adapter is asked to terminate.
    const setOrder = (deps.setWaitReason as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    const terminateOrder = (adapter.terminate as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(terminateOrder);
  });

  it('marks a force terminate (graceful=false) with force:true and no deadline', async () => {
    const instance = makeInstance();
    const adapter = makeAdapter();
    instances.set(instance.id, instance);
    adapters.set(instance.id, adapter);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    const [, firstReason] = (deps.setWaitReason as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstReason).toMatchObject({ kind: 'terminating', force: true });
    expect(firstReason.deadlineAt).toBeUndefined();
  });

  it('clears the terminating waitReason even if adapter.terminate rejects', async () => {
    const instance = makeInstance();
    const adapter = makeAdapter();
    (adapter.terminate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    instances.set(instance.id, instance);
    adapters.set(instance.id, adapter);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, true);

    const calls = (deps.setWaitReason as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1]).toEqual([instance.id, null]);
  });

  it('delegates child termination for terminate-children policy', async () => {
    const parent = makeInstance({
      id: 'parent-1',
      childrenIds: ['child-1', 'child-2'],
      terminationPolicy: 'terminate-children',
    });
    instances.set(parent.id, parent);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(parent.id, false);

    expect(deps.terminateChild).toHaveBeenCalledWith('child-1', false);
    expect(deps.terminateChild).toHaveBeenCalledWith('child-2', false);
    expect(parent.childrenIds).toEqual([]);
  });

  it('orphans children when configured', async () => {
    const parent = makeInstance({
      id: 'parent-1',
      childrenIds: ['child-1'],
      terminationPolicy: 'orphan-children',
    });
    const child = makeInstance({
      id: 'child-1',
      parentId: 'parent-1',
      depth: 1,
    });
    instances.set(parent.id, parent);
    instances.set(child.id, child);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(parent.id);

    expect(deps.terminateChild).not.toHaveBeenCalled();
    expect(child.parentId).toBeNull();
  });

  it('mines root transcripts with enough conversational content', () => {
    const instance = makeInstance({
      outputBuffer: [
        makeMessage('1', 'user', 'A'.repeat(60)),
        makeMessage('2', 'assistant', 'B'.repeat(60)),
        makeMessage('3', 'system', 'ignored'),
        makeMessage('4', 'assistant', 'C'.repeat(20)),
      ],
    });
    const coordinator = new InstanceTerminationCoordinator(deps);

    coordinator.mineTranscript(instance.id, instance, 'terminate');

    expect(deps.importTranscript).toHaveBeenCalledWith(
      expect.stringContaining('A'.repeat(60)),
      {
        wing: '/tmp/project',
        sourceFile: `session://${instance.id}/terminate`,
      },
    );
  });

  it('mines transcripts during forced termination by default', async () => {
    const instance = makeInstance({
      outputBuffer: [
        makeMessage('1', 'user', 'A'.repeat(60)),
        makeMessage('2', 'assistant', 'B'.repeat(60)),
        makeMessage('3', 'assistant', 'C'.repeat(60)),
        makeMessage('4', 'user', 'D'.repeat(60)),
      ],
    });
    instances.set(instance.id, instance);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false);

    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
    expect(deps.importTranscript).toHaveBeenCalled();
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
  });

  it('can skip transcript mining during bulk shutdown while still archiving history', async () => {
    const instance = makeInstance({
      outputBuffer: [
        makeMessage('1', 'user', 'A'.repeat(60)),
        makeMessage('2', 'assistant', 'B'.repeat(60)),
        makeMessage('3', 'assistant', 'C'.repeat(60)),
        makeMessage('4', 'user', 'D'.repeat(60)),
      ],
    });
    instances.set(instance.id, instance);
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id, false, { skipTranscriptMining: true });

    expect(deps.archiveInstance).toHaveBeenCalledWith(instance, 'completed');
    expect(deps.importTranscript).not.toHaveBeenCalled();
    expect(deps.deleteInstance).toHaveBeenCalledWith(instance.id);
  });

  describe('provider-limit park release', () => {
    afterEach(() => {
      _resetInstanceProviderLimitHandlerForTesting();
    });

    function parkInstance(instanceId: string): { cancels: () => number } {
      let cancels = 0;
      const handler = getInstanceProviderLimitHandler();
      handler.configure({
        isEnabled: () => true,
        setWaitReason: vi.fn(),
        resendInput: vi.fn(),
        getQuotaSnapshot: () => null,
        getWorkspaceCwd: () => '/tmp/project',
        scheduleResume: () => () => { cancels++; },
      });
      expect(handler.maybePark({
        instanceId,
        provider: 'claude',
        resetAtHint: Date.now() + 60_000,
        reason: 'limit',
        resumePrompt: 'resend me',
      })).toBe('parked');
      return { cancels: () => cancels };
    }

    it('releases a quota park (and its scheduled resume) on single-instance terminate', async () => {
      const instance = makeInstance();
      instances.set(instance.id, instance);
      const park = parkInstance(instance.id);
      const coordinator = new InstanceTerminationCoordinator(deps);

      await coordinator.terminateInstance(instance.id, false);

      expect(getInstanceProviderLimitHandler().isParked(instance.id)).toBe(false);
      expect(park.cancels()).toBe(1);
    });

    it('keeps the durable resume standing on bulk-shutdown terminate', async () => {
      const instance = makeInstance();
      instances.set(instance.id, instance);
      const park = parkInstance(instance.id);
      const coordinator = new InstanceTerminationCoordinator(deps);

      await coordinator.terminateInstance(instance.id, false, {
        skipTranscriptMining: true,
        preserveDurableProviderResume: true,
      });

      expect(getInstanceProviderLimitHandler().isParked(instance.id)).toBe(false);
      expect(park.cancels()).toBe(0);
    });
  });

  it('drains evidence before transcript archiving, mining, and instance deletion', async () => {
    const order: string[] = [];
    const instance = makeInstance({
      outputBuffer: [
        makeMessage('1', 'user', 'A'.repeat(60)),
        makeMessage('2', 'assistant', 'B'.repeat(60)),
        makeMessage('3', 'assistant', 'C'.repeat(60)),
        makeMessage('4', 'user', 'D'.repeat(60)),
      ],
    });
    instances.set(instance.id, instance);
    deps.drainContextEvidence = vi.fn(async () => { order.push('drain'); });
    deps.archiveInstance = vi.fn(async () => { order.push('archive'); });
    deps.importTranscript = vi.fn(() => { order.push('mine'); });
    deps.deleteInstance = vi.fn(() => { order.push('delete'); });
    const coordinator = new InstanceTerminationCoordinator(deps);

    await coordinator.terminateInstance(instance.id);

    expect(order).toEqual(['drain', 'archive', 'mine', 'delete']);
  });
});
