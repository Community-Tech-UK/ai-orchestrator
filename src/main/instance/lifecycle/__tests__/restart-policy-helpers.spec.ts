import { describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../../shared/types/instance.types';
import { RestartPolicyHelpers } from '../restart-policy-helpers';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Restartable',
    createdAt: 1,
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: 'supervisor-1',
    depth: 0,
    terminationPolicy: { type: 'manual' } as Instance['terminationPolicy'],
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: {
      enabled: false,
      state: 'off',
    },
    status: 'idle',
    contextUsage: {
      used: 50_000,
      total: 200_000,
      percentage: 25,
    },
    lastActivity: 1,
    processId: null,
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    executionLocation: { type: 'local' },
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    totalTokensUsed: 500,
    subscribedTo: [],
    communicationTokens: new Map(),
    currentModel: 'claude-sonnet-4-6',
    ...overrides,
  } as Instance;
}

describe('RestartPolicyHelpers', () => {
  it('falls back to a generic continuity notice when active history is empty', () => {
    const helpers = new RestartPolicyHelpers(
      {
        loadMessages: vi.fn(),
        archiveInstance: vi.fn(),
        resetBudgetTracker: vi.fn(),
        clearFirstMessageTracking: vi.fn(),
      },
      {
        getActiveMessages: vi.fn().mockReturnValue([]),
      },
    );

    const message = helpers.buildReplayContinuityMessage(makeInstance(), 'resume failed');

    expect(message).toContain('[SYSTEM CONTINUITY NOTICE]');
    expect(message).toContain('resume failed');
  });

  it('resets backend session state and refreshes diff tracking', () => {
    const deps = {
      loadMessages: vi.fn(),
      archiveInstance: vi.fn(),
      resetBudgetTracker: vi.fn(),
      clearFirstMessageTracking: vi.fn(),
      deleteDiffTracker: vi.fn(),
      setDiffTracker: vi.fn(),
    };
    const helpers = new RestartPolicyHelpers(deps, {
      getActiveMessages: vi.fn().mockReturnValue([]),
    });
    const instance = makeInstance({
      diffStats: {
        totalAdded: 1,
        totalDeleted: 2,
        files: {},
      },
    });

    helpers.resetBackendSessionState(instance, 'claude-cli', {
      resetTotalTokensUsed: true,
      resetFirstMessageTracking: true,
    });

    expect(instance.contextUsage.used).toBe(0);
    expect(instance.contextUsage.percentage).toBe(0);
    expect(instance.diffStats).toBeUndefined();
    expect(instance.totalTokensUsed).toBe(0);
    expect(deps.clearFirstMessageTracking).toHaveBeenCalledWith(instance.id);
    expect(deps.resetBudgetTracker).toHaveBeenCalledWith(instance.id);
    expect(deps.deleteDiffTracker).toHaveBeenCalledWith(instance.id);
    expect(deps.setDiffTracker).toHaveBeenCalledWith(instance.id, instance.workingDirectory);
  });

  it('archives only root snapshots with content', async () => {
    const archiveInstance = vi.fn();
    const helpers = new RestartPolicyHelpers(
      {
        loadMessages: vi.fn(),
        archiveInstance,
        resetBudgetTracker: vi.fn(),
        clearFirstMessageTracking: vi.fn(),
      },
      {
        getActiveMessages: vi.fn().mockReturnValue([]),
      },
    );
    const messages: OutputMessage[] = [
      {
        id: 'msg-1',
        type: 'assistant',
        content: 'done',
        timestamp: 10,
      },
    ];

    await helpers.archiveRestartSnapshot(makeInstance({ outputBuffer: messages }), messages);
    expect(archiveInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^instance-1-restart-archive-/),
        outputBuffer: messages,
      }),
      'completed',
    );

    archiveInstance.mockClear();
    await helpers.archiveRestartSnapshot(makeInstance({ parentId: 'parent-1' }), messages);
    expect(archiveInstance).not.toHaveBeenCalled();
  });
});
