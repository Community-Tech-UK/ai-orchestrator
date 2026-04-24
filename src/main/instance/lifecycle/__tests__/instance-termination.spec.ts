import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../../../shared/types/instance.types';
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
});
