import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../../shared/types/instance.types';
import { DeferredPermissionHandler } from '../deferred-permission-handler';
import { InstanceStateMachine } from '../../instance-state-machine';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'instance-1',
    displayName: 'Deferred Instance',
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
    status: 'waiting_for_permission',
    contextUsage: {
      used: 15_000,
      total: 200_000,
      percentage: 7.5,
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
    currentModel: 'claude-sonnet-4-6',
    ...overrides,
  } as Instance;
}

describe('DeferredPermissionHandler', () => {
  it('writes the decision, respawns with --resume, and restores the instance to idle', async () => {
    const instance = makeInstance();
    const oldAdapter = {
      getName: vi.fn().mockReturnValue('claude-cli'),
      getRuntimeCapabilities: vi.fn().mockReturnValue({
        supportsResume: true,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: true,
      }),
      terminate: vi.fn().mockResolvedValue(undefined),
      getDeferredToolUse: vi.fn().mockReturnValue({
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        toolUseId: 'tool-1',
        sessionId: 'session-resume-1',
        deferredAt: 10,
      }),
    } as const;
    const newAdapter = {
      config: {},
      spawn: vi.fn().mockResolvedValue(4321),
    } as const;

    const deps = {
      getInstance: vi.fn().mockReturnValue(instance),
      getAdapter: vi.fn().mockReturnValue(oldAdapter),
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn().mockReturnValue(true),
      deleteDiffTracker: vi.fn(),
      setDiffTracker: vi.fn(),
      setupAdapterEvents: vi.fn(),
      queueUpdate: vi.fn(),
    };
    const ops = {
      transitionState: vi.fn((target: Instance, status: Instance['status']) => {
        target.status = status;
      }),
      resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude-cli'),
      getMcpConfig: vi.fn().mockReturnValue(['mcp.json']),
      getPermissionHookPath: vi.fn().mockReturnValue('/hook.js'),
      waitForResumeHealth: vi.fn().mockResolvedValue(true),
      createCliAdapter: vi.fn().mockReturnValue(newAdapter),
      acquireSessionMutex: vi.fn().mockResolvedValue(() => undefined),
    };
    const services = {
      writeDecision: vi.fn(),
      getDecisionDir: vi.fn().mockReturnValue('/tmp/decisions'),
      createDiffTracker: vi.fn().mockReturnValue({ kind: 'tracker' }),
    };
    const handler = new DeferredPermissionHandler(deps, ops, services);

    await handler.resumeAfterDeferredPermission(instance.id, true);

    expect(services.writeDecision).toHaveBeenCalledWith(
      'tool-1',
      'allow',
      'User approved via orchestrator UI',
      undefined,  // no updatedInput — plain allow
    );
    expect(oldAdapter.terminate).toHaveBeenCalledWith(true);
    expect(ops.createCliAdapter).toHaveBeenCalledWith(
      'claude-cli',
      expect.objectContaining({
        sessionId: 'session-resume-1',
        workingDirectory: instance.workingDirectory,
        model: instance.currentModel,
        resume: true,
      }),
      instance.executionLocation,
    );
    expect(newAdapter.config).toEqual({
      env: {
        ORCHESTRATOR_DECISION_DIR: '/tmp/decisions',
      },
    });
    expect(deps.setupAdapterEvents).toHaveBeenCalledWith(instance.id, newAdapter);
    expect(deps.setAdapter).toHaveBeenCalledWith(instance.id, newAdapter);
    expect(deps.setDiffTracker).toHaveBeenCalledWith(instance.id, { kind: 'tracker' });
    expect(instance.processId).toBe(4321);
    expect(instance.sessionId).toBe('session-resume-1');
    expect(instance.status).toBe('idle');
    expect(deps.queueUpdate).toHaveBeenCalledWith(instance.id, 'idle', instance.contextUsage);
  });

  it('fails fast when no deferred tool use is pending', async () => {
    const instance = makeInstance();
    const handler = new DeferredPermissionHandler(
      {
        getInstance: vi.fn().mockReturnValue(instance),
        getAdapter: vi.fn().mockReturnValue({
          getDeferredToolUse: vi.fn().mockReturnValue(null),
        }),
        setAdapter: vi.fn(),
        deleteAdapter: vi.fn(),
        setupAdapterEvents: vi.fn(),
        queueUpdate: vi.fn(),
      },
      {
        transitionState: vi.fn(),
        resolveCliTypeForInstance: vi.fn(),
        getMcpConfig: vi.fn(),
        getPermissionHookPath: vi.fn(),
        waitForResumeHealth: vi.fn(),
        createCliAdapter: vi.fn(),
        acquireSessionMutex: vi.fn().mockResolvedValue(() => undefined),
      },
      {
        writeDecision: vi.fn(),
        getDecisionDir: vi.fn(),
        createDiffTracker: vi.fn(),
      },
    );

    await expect(
      handler.resumeAfterDeferredPermission(instance.id, false),
    ).rejects.toThrow(`No deferred tool use pending for instance ${instance.id}`);
  });

  // LT-137: every other test in this file mocks `ops.transitionState` as a
  // bare `vi.fn()` that unconditionally applies the new status, so none of
  // them exercise the real `InstanceStateMachine` this handler is wired to
  // in production (instance-lifecycle.ts passes its own `transitionState`,
  // which delegates straight to the state machine). That let a real bug slip
  // through undetected: 'waiting_for_permission' never had 'respawning' in
  // its allowed-transitions list, so every live deferred-permission
  // approve/deny threw IllegalTransitionError and dropped the decision
  // in `resumeAfterDeferredPermission`'s "terminate old adapter" step,
  // independent of any interrupt race. This test wires the real state
  // machine (as instance-lifecycle.ts does) instead of a stub.
  it('LT-137: resumes from waiting_for_permission using the real state machine (regression)', async () => {
    const instance = makeInstance();
    const stateMachines = new Map<string, InstanceStateMachine>();
    const realTransitionState = (target: Instance, status: Instance['status']): void => {
      const previous = target.status;
      if (previous === status) return;
      let sm = stateMachines.get(target.id);
      if (!sm) {
        sm = new InstanceStateMachine(previous);
        stateMachines.set(target.id, sm);
      }
      sm.transition(status); // throws IllegalTransitionError if disallowed
      target.status = sm.current;
    };
    // Seed the machine's cached current state to 'waiting_for_permission',
    // mirroring the adapter's `emit('status', 'waiting_for_permission')`
    // having already applied via the same transitionState path.
    stateMachines.set(instance.id, new InstanceStateMachine('waiting_for_permission'));

    const oldAdapter = {
      getName: vi.fn().mockReturnValue('claude-cli'),
      getRuntimeCapabilities: vi.fn().mockReturnValue({
        supportsResume: true,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: true,
      }),
      terminate: vi.fn().mockResolvedValue(undefined),
      getDeferredToolUse: vi.fn().mockReturnValue({
        toolName: 'bash',
        toolInput: { command: 'pwd' },
        toolUseId: 'tool-1',
        sessionId: 'session-resume-1',
        deferredAt: 10,
      }),
    } as const;
    const newAdapter = {
      config: {},
      spawn: vi.fn().mockResolvedValue(4321),
    } as const;

    const handler = new DeferredPermissionHandler(
      {
        getInstance: vi.fn().mockReturnValue(instance),
        getAdapter: vi.fn().mockReturnValue(oldAdapter),
        setAdapter: vi.fn(),
        deleteAdapter: vi.fn().mockReturnValue(true),
        deleteDiffTracker: vi.fn(),
        setDiffTracker: vi.fn(),
        setupAdapterEvents: vi.fn(),
        queueUpdate: vi.fn(),
      },
      {
        transitionState: realTransitionState,
        resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude-cli'),
        getMcpConfig: vi.fn().mockReturnValue(['mcp.json']),
        getPermissionHookPath: vi.fn().mockReturnValue('/hook.js'),
        waitForResumeHealth: vi.fn().mockResolvedValue(true),
        createCliAdapter: vi.fn().mockReturnValue(newAdapter),
        acquireSessionMutex: vi.fn().mockResolvedValue(() => undefined),
      },
      {
        writeDecision: vi.fn(),
        getDecisionDir: vi.fn().mockReturnValue('/tmp/decisions'),
        createDiffTracker: vi.fn().mockReturnValue({ kind: 'tracker' }),
      },
    );

    await expect(
      handler.resumeAfterDeferredPermission(instance.id, true),
    ).resolves.toBeUndefined();

    expect(instance.status).toBe('idle');
  });
});
