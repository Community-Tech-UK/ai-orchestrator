import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../../shared/types/instance.types';
import { PlanModeManager } from '../plan-mode-manager';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Test Instance',
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
      used: 0,
      total: 200_000,
      percentage: 0,
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
    totalTokensUsed: 0,
    subscribedTo: [],
    communicationTokens: new Map(),
    currentModel: 'claude-sonnet-4-6',
    ...overrides,
  } as Instance;
}

describe('PlanModeManager', () => {
  it('enters plan mode and emits a state update', () => {
    const instance = makeInstance();
    const emitter = new EventEmitter();
    const emitSpy = vi.spyOn(emitter, 'emit');
    const manager = new PlanModeManager(
      { getInstance: () => instance },
      emitter,
    );

    const result = manager.enterPlanMode(instance.id);

    expect(result.planMode).toEqual({
      enabled: true,
      state: 'planning',
      planContent: undefined,
      approvedAt: undefined,
    });
    expect(emitSpy).toHaveBeenCalledWith('state-update', expect.objectContaining({
      instanceId: instance.id,
      planMode: result.planMode,
    }));
  });

  it('approves a plan and preserves existing content when none is provided', () => {
    const instance = makeInstance({
      planMode: {
        enabled: true,
        state: 'planning',
        planContent: 'Initial plan',
      },
    });
    const manager = new PlanModeManager(
      { getInstance: () => instance },
      new EventEmitter(),
    );

    const result = manager.approvePlan(instance.id);

    expect(result.planMode.enabled).toBe(true);
    expect(result.planMode.state).toBe('approved');
    expect(result.planMode.planContent).toBe('Initial plan');
    expect(result.planMode.approvedAt).toBeTypeOf('number');
  });

  it('requires approval before exiting unless forced', () => {
    const instance = makeInstance({
      planMode: {
        enabled: true,
        state: 'planning',
        planContent: 'Needs review',
      },
    });
    const manager = new PlanModeManager(
      { getInstance: () => instance },
      new EventEmitter(),
    );

    expect(() => manager.exitPlanMode(instance.id)).toThrow(
      'Plan must be approved before exiting plan mode',
    );

    const result = manager.exitPlanMode(instance.id, true);
    expect(result.planMode).toEqual({
      enabled: false,
      state: 'off',
      planContent: undefined,
      approvedAt: undefined,
    });
  });
});
