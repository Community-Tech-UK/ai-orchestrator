import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../../shared/types/instance.types';
import { ClaudeLivePermissionBroker } from '../../../cli/adapters/claude-live-permission';
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
  it.each([[true, 'Use local files.'], [false, 'Use local files.'], [false, undefined], [false, '   ']] as const)('writes the decision and resumes (approved=%s, note=%s)', async (approved, denyNote) => {
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

    await handler.resumeAfterDeferredPermission(instance.id, approved, undefined, { denyNote });

    expect(services.writeDecision).toHaveBeenCalledWith(
      'tool-1',
      approved ? 'allow' : 'deny',
      approved ? 'User approved via orchestrator UI' : denyNote?.trim()
        ? 'Harness: the user declined this call. Use local files.' : 'User denied via orchestrator UI',
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

  it('names the instance to every MCP getter so a Plan Queue role still applies after a permission resume', async () => {
    const instance = makeInstance({ metadata: { planQueueRole: 'verifier' } });
    const newAdapter = { config: {}, spawn: vi.fn().mockResolvedValue(4321) } as const;
    const ops = {
      transitionState: vi.fn((target: Instance, status: Instance['status']) => { target.status = status; }),
      resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude-cli'),
      getMcpConfig: vi.fn().mockReturnValue([]),
      getBrowserGatewayMcpOptions: vi.fn().mockReturnValue(null),
      getChromeDevtoolsMcpOptions: vi.fn().mockReturnValue(null),
      getPermissionHookPath: vi.fn().mockReturnValue('/hook.js'),
      waitForResumeHealth: vi.fn().mockResolvedValue(true),
      createCliAdapter: vi.fn().mockReturnValue(newAdapter),
      acquireSessionMutex: vi.fn().mockResolvedValue(() => undefined),
    };
    const handler = new DeferredPermissionHandler(
      {
        getInstance: vi.fn().mockReturnValue(instance),
        getAdapter: vi.fn().mockReturnValue({
          getName: vi.fn().mockReturnValue('claude-cli'),
          getRuntimeCapabilities: vi.fn().mockReturnValue({ supportsResume: true, supportsDeferPermission: true }),
          terminate: vi.fn().mockResolvedValue(undefined),
          getDeferredToolUse: vi.fn().mockReturnValue({ toolName: 'bash', toolInput: {}, toolUseId: 'tool-1', sessionId: 'session-resume-1', deferredAt: 10 }),
        }),
        setAdapter: vi.fn(), deleteAdapter: vi.fn().mockReturnValue(true), deleteDiffTracker: vi.fn(), setDiffTracker: vi.fn(),
        setupAdapterEvents: vi.fn(), queueUpdate: vi.fn(),
      },
      ops,
      { writeDecision: vi.fn(), getDecisionDir: vi.fn().mockReturnValue('/tmp/decisions'), createDiffTracker: vi.fn().mockReturnValue({}) },
    );

    await handler.resumeAfterDeferredPermission(instance.id, true);

    expect(ops.getMcpConfig).toHaveBeenCalledWith(instance.executionLocation, instance.id, 'claude-cli');
    expect(ops.getBrowserGatewayMcpOptions).toHaveBeenCalledWith(instance.executionLocation, instance.id, 'claude-cli');
    expect(ops.getChromeDevtoolsMcpOptions).toHaveBeenCalledWith(instance.executionLocation, instance.id);
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

  // LT-137 interrupt-in-flight race: InterruptRespawnHandler.interrupt() mutates
  // instance.status synchronously and does not take the session mutex, so it can
  // run to completion while resumeAfterDeferredPermission is awaiting
  // acquireSessionMutex(). The state-machine fix above only stops a crash on
  // waiting_for_permission -> respawning; interrupting -> respawning is a legal
  // transition, so nothing else guards against a stale respawn racing the
  // in-flight interrupt.
  it.each([true, false])('LT-137: skips respawn but writes the decision during an interrupt (approved=%s)', async approved => {
    const instance = makeInstance({ status: 'waiting_for_permission' });

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
      // Simulate a concurrent InterruptRespawnHandler.interrupt() flipping the
      // instance to 'interrupting' while resumeAfterDeferredPermission is
      // still awaiting the mutex.
      acquireSessionMutex: vi.fn().mockImplementation(async () => {
        instance.status = 'interrupting';
        return () => undefined;
      }),
    };
    const services = {
      writeDecision: vi.fn(),
      getDecisionDir: vi.fn().mockReturnValue('/tmp/decisions'),
      createDiffTracker: vi.fn().mockReturnValue({ kind: 'tracker' }),
    };
    const handler = new DeferredPermissionHandler(deps, ops, services);

    await expect(
      handler.resumeAfterDeferredPermission(instance.id, approved),
    ).resolves.toBeUndefined();

    // The decision is still recorded so it isn't silently lost...
    expect(services.writeDecision).toHaveBeenCalledWith(
      'tool-1',
      approved ? 'allow' : 'deny',
      approved ? 'User approved via orchestrator UI (interrupt in flight)' : 'User denied via orchestrator UI (interrupt in flight)',
      undefined,
    );
    // ...but the respawn itself is skipped: no terminate/spawn of a second adapter.
    expect(oldAdapter.terminate).not.toHaveBeenCalled();
    expect(ops.createCliAdapter).not.toHaveBeenCalled();
    expect(newAdapter.spawn).not.toHaveBeenCalled();
    expect(instance.status).toBe('interrupting');
  });
});


describe('live permission fast path', () => {
  function setup() {
    const instance = makeInstance();
    const answers: unknown[] = [];
    const pending = new Set(['card-one', 'card-two']);
    const broker = { hasPending: () => pending.size > 0, whenAnswered: vi.fn(async () => undefined), answer: (id: string | undefined, answer: unknown) => {
      const key = id ?? (pending.size === 1 ? [...pending][0] : undefined);
      if (!key || !pending.delete(key)) return false;
      answers.push({ id: key, answer }); return true;
    } };
    const adapter = { livePermissions: broker, getDeferredToolUse: () => null, terminate: vi.fn() };
    const deps = { getInstance: () => instance, getAdapter: vi.fn().mockReturnValue(adapter), setAdapter: vi.fn(), deleteAdapter: vi.fn(), setupAdapterEvents: vi.fn(), queueUpdate: vi.fn() };
    const ops = { transitionState: vi.fn(), resolveCliTypeForInstance: vi.fn(), getMcpConfig: vi.fn(), getPermissionHookPath: vi.fn(), waitForResumeHealth: vi.fn(), createCliAdapter: vi.fn(), acquireSessionMutex: vi.fn().mockResolvedValue(() => undefined) };
    const services = { writeDecision: vi.fn(), getDecisionDir: vi.fn(), createDiffTracker: vi.fn() };
    return { instance, pending, answers, adapter, ops, services, handler: new DeferredPermissionHandler(deps, ops, services) };
  }
  it('answers the exact card with edited input and deny note before any mutex, mutation or respawn', async () => {
    const s = setup();
    await s.handler.resumeAfterDeferredPermission(s.instance.id, false, undefined, { requestId: 'card-two', denyNote: 'Use local data.' });
    expect(s.answers).toEqual([{ id: 'card-two', answer: { approved: false, updatedInput: undefined, note: 'Use local data.' } }]);
    await s.handler.resumeAfterDeferredPermission(s.instance.id, true, { url: 'https://example.com' }, { requestId: 'card-one', yoloMode: true });
    expect(s.answers[1]).toEqual({ id: 'card-one', answer: { approved: true, updatedInput: { url: 'https://example.com' }, note: undefined } });
    expect(s.instance.yoloMode).toBe(false);
    expect(s.ops.acquireSessionMutex).not.toHaveBeenCalled(); expect(s.adapter.terminate).not.toHaveBeenCalled(); expect(s.ops.createCliAdapter).not.toHaveBeenCalled();
  });
  it('awaits the live write and propagates failure without recording or falling into held recovery', async () => {
    const s = setup();
    s.adapter.livePermissions.whenAnswered.mockRejectedValueOnce(new Error('control write failed'));
    await expect(s.handler.resumeAfterDeferredPermission(s.instance.id, true, undefined, { requestId: 'card-one' })).rejects.toThrow('control write failed');
    expect(s.ops.acquireSessionMutex).not.toHaveBeenCalled(); expect(s.adapter.terminate).not.toHaveBeenCalled(); expect(s.services.writeDecision).not.toHaveBeenCalled();
  });
  it('selects the sole ask for legacy id-less callers but never guesses between multiple asks', async () => {
    const s = setup();
    await expect(s.handler.resumeAfterDeferredPermission(s.instance.id, true)).rejects.toThrow('No deferred tool use');
    expect(s.answers).toEqual([]);
    s.pending.delete('card-two');
    await s.handler.resumeAfterDeferredPermission(s.instance.id, true);
    expect(s.answers).toHaveLength(1);
  });
  it('refuses a stale explicit id instead of authorizing a different pending live call', async () => {
    const s = setup(); s.pending.delete('card-two');
    await expect(s.handler.resumeAfterDeferredPermission(s.instance.id, true, undefined, { requestId: 'stale' })).rejects.toThrow();
    expect(s.answers).toEqual([]); expect(s.adapter.terminate).not.toHaveBeenCalled();
  });
  it('never lets a cancelled live card approve an unrelated held tool when no ask is pending', async () => {
    const instance = makeInstance();
    let cancelledCardId = '';
    const broker = new ClaudeLivePermissionBroker({
      emit: (event: string, payload: unknown) => {
        if (event === 'input_required') cancelledCardId = (payload as { id: string }).id;
        return true;
      },
      sendRawControl: async () => undefined,
    });
    broker.handle('control_request', {
      request_id: 'control-webfetch',
      request: { subtype: 'can_use_tool', tool_name: 'WebFetch', input: { url: 'https://example.com' } },
    });
    expect(broker.hasPending()).toBe(true);
    broker.dropAll('cancelled');
    expect(cancelledCardId).not.toBe('');
    const writeDecision = vi.fn();
    const oldAdapter = {
      livePermissions: broker,
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
        toolName: 'Bash',
        toolInput: { command: 'pwd' },
        toolUseId: 'held-new-call',
        sessionId: 'session-resume-1',
        deferredAt: 10,
      }),
    } as const;
    const handler = new DeferredPermissionHandler(
      {
        getInstance: vi.fn().mockReturnValue(instance),
        getAdapter: vi.fn().mockReturnValue(oldAdapter),
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
      { writeDecision, getDecisionDir: vi.fn(), createDiffTracker: vi.fn() },
    );

    await expect(
      handler.resumeAfterDeferredPermission(instance.id, true, undefined, { requestId: cancelledCardId }),
    ).rejects.toThrow('Live permission request is no longer pending');
    expect(writeDecision).not.toHaveBeenCalled();
    expect(oldAdapter.terminate).not.toHaveBeenCalled();
  });
});
