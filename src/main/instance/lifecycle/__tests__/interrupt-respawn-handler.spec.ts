import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import { InterruptRespawnHandler } from '../interrupt-respawn-handler';
import type { Instance, OutputMessage } from '../../../../shared/types/instance.types';

const providerRuntime = vi.hoisted(() => ({
  createAdapter: vi.fn(),
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => providerRuntime,
}));

function createInstance(status: Instance['status'] = 'busy'): Instance {
  return {
    id: 'instance-1',
    displayName: 'Test Instance',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: {
      enabled: false,
      state: 'off',
    },
    status,
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: Date.now(),
    processId: 12345,
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    adapterGeneration: 1,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'codex',
    executionLocation: { type: 'local' },
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
  };
}

class InterruptProofAdapter extends EventEmitter {
  interrupt = vi.fn(() => ({
    status: 'accepted' as const,
    turnId: 'turn-1',
    completion: Promise.resolve({
      status: 'interrupted' as const,
      turnId: 'turn-1',
    }),
  }));
  terminate = vi.fn().mockResolvedValue(undefined);
  getName = vi.fn(() => 'claude-cli');
  isRunning = vi.fn(() => true);
  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}

class RespawnReplacementAdapter extends EventEmitter {
  spawn = vi.fn<() => Promise<number>>();
  terminate = vi.fn().mockResolvedValue(undefined);
  sendInput = vi.fn().mockResolvedValue(undefined);

  getName(): string {
    return 'claude-cli';
  }

  getSessionId(): string | null {
    return null;
  }

  isRunning(): boolean {
    return true;
  }
}

describe('InterruptRespawnHandler', () => {
  let instance: Instance;
  let adapter: InterruptProofAdapter;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let clearInterrupted: ReturnType<typeof vi.fn>;
  let addToOutputBuffer: ReturnType<typeof vi.fn>;
  let emitOutput: ReturnType<typeof vi.fn>;
  let handler: InterruptRespawnHandler;

  beforeEach(() => {
    providerRuntime.createAdapter.mockReset();
    instance = createInstance();
    adapter = new InterruptProofAdapter();
    queueUpdate = vi.fn();
    clearInterrupted = vi.fn();
    addToOutputBuffer = vi.fn((target: Instance, message: OutputMessage) => {
      target.outputBuffer.push(message);
    });
    emitOutput = vi.fn();

    handler = new InterruptRespawnHandler({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(),
      queueUpdate,
      markInterrupted: vi.fn(),
      clearInterrupted,
      addToOutputBuffer,
      setupAdapterEvents: vi.fn(),
      transitionState: (target, status) => {
        target.status = status;
      },
      getAdapterRuntimeCapabilities: () => ({
        supportsResume: true,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
      }),
      resolveCliTypeForInstance: vi.fn(),
      getMcpConfig: () => [],
      getPermissionHookPath: () => undefined,
      waitForResumeHealth: vi.fn(),
      waitForAdapterWritable: vi.fn(),
      buildReplayContinuityMessage: () => '',
      buildFallbackHistory: vi.fn(),
      emitOutput,
    });
  });

  it('uses interrupt completion proof to return to idle without respawning', async () => {
    expect(handler.interrupt(instance.id)).toBe(true);
    expect(instance.status).toBe('interrupting');
    expect(instance.respawnPromise).toBeDefined();
    expect(instance.interruptRequestId).toBeDefined();
    expect(instance.interruptPhase).toBe('accepted');

    await Promise.resolve();
    await Promise.resolve();

    expect(instance.status).toBe('idle');
    expect(instance.interruptPhase).toBe('completed');
    expect(instance.lastTurnOutcome).toBe('interrupted');
    expect(instance.respawnPromise).toBeUndefined();
    expect(clearInterrupted).toHaveBeenCalledWith(instance.id);
    expect(addToOutputBuffer).toHaveBeenCalledWith(
      instance,
      expect.objectContaining({
        type: 'system',
        content: 'Interrupted — waiting for input',
        metadata: expect.objectContaining({
          interruptStatus: 'interrupted',
          turnId: 'turn-1',
        }),
      }),
    );
    expect(emitOutput).toHaveBeenCalledWith(instance.id, expect.objectContaining({
      type: 'system',
      content: 'Interrupted — waiting for input',
    }));
    expect(queueUpdate.mock.calls.map((call) => call[1])).toEqual(['interrupting', 'cancelling', 'idle']);
  });

  it('keeps an accepted interrupt recoverable when completion later reports rejected', async () => {
    adapter.interrupt.mockReturnValueOnce({
      status: 'accepted' as const,
      turnId: 'turn-1',
      completion: Promise.resolve({
        status: 'rejected' as const,
        turnId: 'turn-1',
        reason: 'Codex turn failed',
      }),
    });

    expect(handler.interrupt(instance.id)).toBe(true);

    await Promise.resolve();
    await Promise.resolve();

    expect(instance.status).toBe('idle');
    expect(instance.interruptPhase).toBe('completed');
    expect(instance.lastTurnOutcome).toBe('interrupted');
    expect(instance.respawnPromise).toBeUndefined();
    expect(clearInterrupted).toHaveBeenCalledWith(instance.id);
    expect(addToOutputBuffer).toHaveBeenCalledWith(
      instance,
      expect.objectContaining({
        type: 'system',
        content: 'Interrupted — waiting for input',
        metadata: expect.objectContaining({
          interruptStatus: 'rejected',
          interruptReason: 'Codex turn failed',
          turnId: 'turn-1',
        }),
      }),
    );
    expect(queueUpdate.mock.calls.map((call) => call[1])).toEqual(['interrupting', 'cancelling', 'idle']);
  });

  it('interrupt completion deadline does NOT settle the instance — force-abort net handles cleanup (A3)', async () => {
    vi.useFakeTimers();
    try {
      // completion promise that never resolves — simulates a wedged provider
      adapter.interrupt.mockReturnValueOnce({
        status: 'accepted' as const,
        turnId: 'turn-1',
        completion: new Promise<never>(() => undefined),
      });

      handler.interrupt(instance.id);
      expect(instance.status).toBe('interrupting');
      expect(instance.respawnPromise).toBeDefined();

      // Advance past INTERRUPT_COMPLETION_DEADLINE_MS (15s) but before INTERRUPT_FORCE_ABORT_MS (30s).
      // handleInterruptCompletion returns early — it does NOT settle to idle.
      // The force-abort net remains armed.
      await vi.advanceTimersByTimeAsync(16_000);

      expect(instance.status).not.toBe('idle');
      expect(instance.respawnPromise).toBeDefined(); // force-abort net not yet fired
      expect(adapter.terminate).not.toHaveBeenCalledWith(true); // adapter still alive (not yet killed)

      // Advance to 31s — force-abort net fires, terminates adapter, settles to 'cancelled'.
      await vi.advanceTimersByTimeAsync(15_000);

      expect(adapter.terminate).toHaveBeenCalledWith(true);
      expect(instance.status).toBe('cancelled');
      expect(instance.interruptPhase).toBe('escalated');
      expect(instance.lastTurnOutcome).toBe('cancelled');
      expect(instance.respawnPromise).toBeUndefined(); // resolved by force-abort
    } finally {
      vi.useRealTimers();
    }
  });

  it('escalates a second interrupt into a recoverable cancelled state', async () => {
    instance.status = 'interrupting';
    instance.interruptRequestId = 'interrupt-1';
    instance.interruptRequestedAt = 123;
    instance.activeTurnId = 'turn-1';
    instance.respawnPromise = new Promise<void>(() => undefined);

    expect(handler.interrupt(instance.id)).toBe(true);

    expect(adapter.terminate).toHaveBeenCalledWith(true);
    expect(instance.status).toBe('cancelled');
    expect(instance.lastTurnOutcome).toBe('cancelled');
    expect(instance.interruptPhase).toBe('escalated');
    expect(instance.respawnPromise).toBeUndefined();
    expect(queueUpdate.mock.calls.map((call) => call[1])).toEqual(['interrupt-escalating', 'cancelled']);
  });

  it('cleans up a replacement adapter when auto-respawn races with termination', async () => {
    instance = createInstance('respawning');
    instance.parentId = null;
    instance.outputBuffer = [{
      id: 'user-1',
      timestamp: Date.now(),
      type: 'user',
      content: 'continue',
    }];

    const previousAdapter = adapter as unknown as CliAdapter;
    const replacement = new RespawnReplacementAdapter();
    let resolveSpawn!: (pid: number) => void;
    replacement.spawn.mockImplementation(() => new Promise<number>((resolve) => {
      resolveSpawn = resolve;
    }));
    providerRuntime.createAdapter.mockReturnValue(replacement);

    let currentAdapter: CliAdapter | undefined = previousAdapter;
    const setAdapter = vi.fn((_id: string, next: CliAdapter) => {
      currentAdapter = next;
    });
    const deleteAdapter = vi.fn(() => {
      currentAdapter = undefined;
    });
    const setupAdapterEvents = vi.fn();

    handler = new InterruptRespawnHandler({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: () => currentAdapter,
      setAdapter,
      deleteAdapter,
      queueUpdate,
      markInterrupted: vi.fn(),
      clearInterrupted,
      addToOutputBuffer,
      setupAdapterEvents,
      transitionState: (target, status) => {
        target.status = status;
      },
      getAdapterRuntimeCapabilities: () => ({
        supportsResume: false,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
      }),
      resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude'),
      getMcpConfig: () => [],
      getPermissionHookPath: () => undefined,
      waitForResumeHealth: vi.fn().mockResolvedValue(true),
      waitForAdapterWritable: vi.fn().mockResolvedValue(undefined),
      buildReplayContinuityMessage: () => 'replay continuity',
      buildFallbackHistory: vi.fn(),
      emitOutput,
    });

    const respawn = handler.respawnAfterUnexpectedExit(instance.id);
    for (let attempt = 0; attempt < 5 && replacement.spawn.mock.calls.length === 0; attempt++) {
      await Promise.resolve();
    }
    expect(replacement.spawn).toHaveBeenCalledTimes(1);

    instance.status = 'terminated';
    resolveSpawn(777);
    await respawn;

    expect(replacement.terminate).toHaveBeenCalledWith(false);
    expect(deleteAdapter).toHaveBeenCalled();
    expect(currentAdapter).toBeUndefined();
    expect(instance.status).toBe('terminated');
    expect(instance.processId).toBeNull();
    expect(addToOutputBuffer).not.toHaveBeenCalledWith(
      instance,
      expect.objectContaining({ metadata: { autoRespawn: true } }),
    );
    expect(queueUpdate.mock.calls.map((call) => call[1])).not.toContain('idle');
  });

  it('passes bare mode to the replacement adapter during auto-respawn', async () => {
    instance = createInstance('respawning');
    instance.provider = 'claude';
    instance.bareMode = true;
    instance.parentId = null;
    instance.outputBuffer = [];

    const previousAdapter = adapter as unknown as CliAdapter;
    const replacement = new RespawnReplacementAdapter();
    replacement.spawn.mockResolvedValue(777);
    providerRuntime.createAdapter.mockReturnValue(replacement);

    let currentAdapter: CliAdapter | undefined = previousAdapter;
    const setAdapter = vi.fn((_id: string, next: CliAdapter) => {
      currentAdapter = next;
    });
    const deleteAdapter = vi.fn(() => {
      currentAdapter = undefined;
    });

    handler = new InterruptRespawnHandler({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: () => currentAdapter,
      setAdapter,
      deleteAdapter,
      queueUpdate,
      markInterrupted: vi.fn(),
      clearInterrupted,
      addToOutputBuffer,
      setupAdapterEvents: vi.fn(),
      transitionState: (target, status) => {
        target.status = status;
      },
      getAdapterRuntimeCapabilities: () => ({
        supportsResume: false,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
      }),
      resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude'),
      getMcpConfig: () => [],
      getPermissionHookPath: () => undefined,
      waitForResumeHealth: vi.fn().mockResolvedValue(true),
      waitForAdapterWritable: vi.fn().mockResolvedValue(undefined),
      buildReplayContinuityMessage: () => 'replay continuity',
      buildFallbackHistory: vi.fn(),
      emitOutput,
    });

    await handler.respawnAfterUnexpectedExit(instance.id);

    expect(providerRuntime.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'claude',
        options: expect.objectContaining({ bare: true }),
      }),
    );
  });

  it('enables resident Claude when respawning an instance with stale rollout state', async () => {
    instance = createInstance('respawning');
    instance.id = 'stale-resident-claude-instance';
    instance.provider = 'claude';
    instance.residentClaude = false;
    instance.parentId = null;
    instance.outputBuffer = [];

    const previousAdapter = adapter as unknown as CliAdapter;
    const replacement = new RespawnReplacementAdapter();
    replacement.spawn.mockResolvedValue(777);
    providerRuntime.createAdapter.mockReturnValue(replacement);

    let currentAdapter: CliAdapter | undefined = previousAdapter;
    const setAdapter = vi.fn((_id: string, next: CliAdapter) => {
      currentAdapter = next;
    });
    const deleteAdapter = vi.fn(() => {
      currentAdapter = undefined;
    });

    handler = new InterruptRespawnHandler({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: () => currentAdapter,
      setAdapter,
      deleteAdapter,
      queueUpdate,
      markInterrupted: vi.fn(),
      clearInterrupted,
      addToOutputBuffer,
      setupAdapterEvents: vi.fn(),
      transitionState: (target, status) => {
        target.status = status;
      },
      getAdapterRuntimeCapabilities: () => ({
        supportsResume: false,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: false,
        supportsDeferPermission: false,
      }),
      resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude'),
      getMcpConfig: () => [],
      getPermissionHookPath: () => undefined,
      waitForResumeHealth: vi.fn().mockResolvedValue(true),
      waitForAdapterWritable: vi.fn().mockResolvedValue(undefined),
      buildReplayContinuityMessage: () => 'replay continuity',
      buildFallbackHistory: vi.fn(),
      emitOutput,
    });

    await handler.respawnAfterUnexpectedExit(instance.id);

    expect(instance.residentClaude).toBe(true);
    expect(providerRuntime.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'claude',
        options: expect.objectContaining({ residentClaude: true }),
      }),
    );
  });
});
