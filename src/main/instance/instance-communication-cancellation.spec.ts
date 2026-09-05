import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';

const lifecycleHookMocks = vi.hoisted(() => ({
  triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }),
  }),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({ storeMessages: vi.fn() }),
}));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: lifecycleHookMocks.triggerLifecycleHooks,
  }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';

class FakeAdapter extends EventEmitter {
  readonly sendInput = vi.fn(async () => undefined);
  getName(): string { return 'claude-cli'; }
  getSessionId(): string | null { return 'provider-session-1'; }
}

describe('InstanceCommunicationManager input cancellation', () => {
  it('keeps queued continuity and last-sent state when cancelled during PreSampling', async () => {
    const instance = createInstance();
    const adapter = new FakeAdapter();
    const createSnapshot = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance,
      getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(() => true),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      createSnapshot,
    });
    await manager.sendInput(instance.id, 'original user turn');
    const internal = manager as unknown as {
      lastSentMessages: Map<string, { message: string }>;
    };
    expect(internal.lastSentMessages.get(instance.id)?.message).toBe('original user turn');

    manager.queueContinuityPreamble(instance.id, 'queued late context');
    let releaseHook!: () => void;
    lifecycleHookMocks.triggerLifecycleHooks.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseHook = () => resolve({ blocked: false });
      }),
    );
    const controller = new AbortController();
    const send = manager.sendInput(
      instance.id,
      'automated nudge',
      undefined,
      undefined,
      { autoContinuation: true, signal: controller.signal },
    );
    await vi.waitFor(() => expect(lifecycleHookMocks.triggerLifecycleHooks).toHaveBeenCalledTimes(2));
    controller.abort();
    releaseHook();

    await expect(send).rejects.toMatchObject({ name: 'AbortError' });
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(internal.lastSentMessages.get(instance.id)?.message).toBe('original user turn');

    await manager.sendInput(instance.id, 'new human turn');
    expect(adapter.sendInput).toHaveBeenLastCalledWith(
      'queued late context\n\nnew human turn',
      undefined,
    );
  });

  it('does not dispatch after cancellation during runtime-config preflight', async () => {
    const instance = createInstance();
    const adapter = new FakeAdapter();
    let releaseRefresh!: () => void;
    const refreshAdapterRuntimeConfig = vi.fn(() => new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    }));
    const manager = new InstanceCommunicationManager({
      getInstance: () => instance,
      getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(() => true),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      refreshAdapterRuntimeConfig,
    });
    const controller = new AbortController();
    const beforeProviderDispatch = vi.fn();

    const send = manager.sendInput(
      instance.id,
      'Continue now.',
      undefined,
      undefined,
      { autoContinuation: true, signal: controller.signal, beforeProviderDispatch },
    );
    await vi.waitFor(() => expect(refreshAdapterRuntimeConfig).toHaveBeenCalledOnce());
    controller.abort();
    releaseRefresh();

    await expect(send).rejects.toMatchObject({ name: 'AbortError' });
    expect(beforeProviderDispatch).not.toHaveBeenCalled();
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });
});

function createInstance(): Instance {
  return {
    id: 'instance-1', displayName: 'Cancellation', createdAt: 1,
    historyThreadId: 'history-1',
    parentId: null, childrenIds: [], supervisorNodeId: '', depth: 0,
    terminationPolicy: 'terminate-children', launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build', agentMode: 'build', planMode: { enabled: false, state: 'off' },
    status: 'idle', contextUsage: { used: 0, total: 1_000, percentage: 0 },
    lastActivity: 1, processId: 1, sessionId: 'session-1',
    providerSessionId: 'provider-session-1', restartEpoch: 0,
    workingDirectory: '/tmp', yoloMode: false, provider: 'claude',
    outputBuffer: [], outputBufferMaxSize: 100,
    communicationTokens: new Map(), subscribedTo: [], totalTokensUsed: 0,
    requestCount: 0, errorCount: 0, restartCount: 0,
  };
}
