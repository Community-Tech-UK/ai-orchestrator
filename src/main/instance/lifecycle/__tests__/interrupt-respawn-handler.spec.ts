import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import { InterruptRespawnHandler } from '../interrupt-respawn-handler';
import type { Instance, OutputMessage } from '../../../../shared/types/instance.types';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
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
  removeAllListeners(): this {
    return super.removeAllListeners();
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
});
