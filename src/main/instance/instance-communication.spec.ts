import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { SessionDiffTracker } from './session-diff-tracker';

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      outputBufferSize: 100,
      enableDiskStorage: false,
    }),
  }),
}));

vi.mock('../memory', () => ({
  getOutputStorageManager: () => ({
    storeMessages: vi.fn(),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../plugins/hook-emitter', () => ({
  emitPluginHook: vi.fn(),
}));

vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

const mockWriteThroughIdentity = vi.fn().mockResolvedValue(undefined);
vi.mock('../session/session-continuity', () => ({
  getSessionContinuityManagerIfInitialized: () => ({
    writeThroughIdentity: mockWriteThroughIdentity,
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';
import { TokenBudgetTracker } from '../context/token-budget-tracker';
import { AcpCliAdapter } from '../cli/adapters/acp-cli-adapter';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getCostTracker } from '../core/system/cost-tracker';
import { getTokenCounter, TokenCounter } from '../rlm/token-counter';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';

const emitPluginHookMock = vi.mocked(emitPluginHook);

class FakeAdapter extends EventEmitter {
  sendInput = vi.fn().mockResolvedValue(undefined);
  terminate = vi.fn().mockResolvedValue(undefined);
  currentTurnId: string | null = null;

  constructor(private readonly adapterName: string) {
    super();
  }

  getName(): string {
    return this.adapterName;
  }

  getSessionId(): string | null {
    return null;
  }

  getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}

function createInstance(status: Instance['status'] = 'idle'): Instance {
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
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    currentModel: undefined,
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    restartEpoch: 0,
  };
}

let msgCounter = 0;
function createMessage(
  type: OutputMessage['type'],
  content: string,
  options: { metadata?: Record<string, unknown> } = {}
): OutputMessage {
  return {
    id: `msg-${++msgCounter}`,
    timestamp: Date.now(),
    type,
    content,
    metadata: options.metadata,
  };
}

describe('InstanceCommunicationManager', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let emitProviderRuntimeEvent: ReturnType<typeof vi.fn>;
  let manager: InstanceCommunicationManager;

  async function flushOutputHandlers(): Promise<void> {
    // Async output handlers may need multiple event-loop ticks to complete,
    // especially under parallel test load where hooks and other async ops yield.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
  }

  beforeEach(() => {
    instance = createInstance();
    adapters = new Map();
    queueUpdate = vi.fn();
    emitProviderRuntimeEvent = vi.fn();

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => {
        adapters.set(id, adapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent,
    });
  });

  it('ignores normal exit events from stateless exec adapters like codex', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('exit', 0, null);

    expect(instance.status).toBe('idle');
    expect(instance.processId).toBe(12345);
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('still marks persistent adapters as terminated on exit', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('exit', 0, null);

    expect(instance.status).toBe('terminated');
    expect(instance.processId).toBeNull();
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'terminated', undefined, undefined, undefined, undefined);
  });

  it('treats ACP-backed adapters as persistent sessions on exit', () => {
    const adapter = new AcpCliAdapter({
      adapterName: 'copilot-acp',
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    adapters.set(instance.id, adapter as unknown as CliAdapter);

    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
    adapter.emit('exit', 0, null);

    expect(instance.status).toBe('terminated');
    expect(instance.processId).toBeNull();
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'terminated', undefined, undefined, undefined, undefined);
  });

  it('§3.2: emits a typed invalid-session notice (not just raw error) when resume fails', async () => {
    instance.provider = 'claude';
    instance.providerSessionId = 'sess-xyz';
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    const outputs: OutputMessage[] = [];
    manager.on('output', (e: { instanceId: string; message: OutputMessage }) => outputs.push(e.message));

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', createMessage('error', 'session not found: sess-xyz'));
    await flushOutputHandlers();

    expect(instance.sessionResumeBlacklisted).toBe(true);
    const notice = outputs.find(
      (m) => (m.metadata?.['notice'] as { kind?: string } | undefined)?.kind === 'invalid-session',
    );
    expect(notice).toBeDefined();
    expect(notice!.type).toBe('system');
    expect((notice!.metadata!['notice'] as { sessionId?: string }).sessionId).toBe('sess-xyz');
  });

  it('§3.2: does not emit a second invalid-session notice once already blacklisted', async () => {
    instance.provider = 'claude';
    instance.sessionResumeBlacklisted = true;
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    const outputs: OutputMessage[] = [];
    manager.on('output', (e: { message: OutputMessage }) => outputs.push(e.message));

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', createMessage('error', 'session not found'));
    await flushOutputHandlers();

    const notices = outputs.filter(
      (m) => (m.metadata?.['notice'] as { kind?: string } | undefined)?.kind === 'invalid-session',
    );
    expect(notices).toHaveLength(0);
  });

  it('reconciles a Cursor instance whose model is the auto sentinel to the agent-reported model', () => {
    instance.provider = 'cursor';
    instance.currentModel = 'auto';
    const adapter = new FakeAdapter('cursor-acp') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('model', 'composer-2.5');

    expect(instance.currentModel).toBe('composer-2.5');
    expect(queueUpdate).toHaveBeenCalledWith(
      instance.id, 'idle', instance.contextUsage,
      undefined, undefined, undefined, undefined, undefined, undefined, 'composer-2.5',
    );
  });

  it('does NOT overwrite an explicit Cursor model pick on a model event', () => {
    instance.provider = 'cursor';
    instance.currentModel = 'claude-opus-4-8-thinking-high';
    const adapter = new FakeAdapter('cursor-acp') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('model', 'claude-opus-4-8');

    expect(instance.currentModel).toBe('claude-opus-4-8-thinking-high');
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('ignores model events for non-Cursor providers', () => {
    instance.provider = 'copilot';
    instance.currentModel = 'auto';
    const adapter = new FakeAdapter('copilot-acp') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('model', 'gpt-5.5');

    expect(instance.currentModel).toBe('auto');
    expect(queueUpdate).not.toHaveBeenCalled();
  });

  it('preserves provider context diagnostics when forwarding adapter context events', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('context', {
      used: 80,
      total: 100,
      percentage: 80,
      inputTokens: 60,
      outputTokens: 20,
      source: 'provider-usage',
      promptWeight: 0.75,
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(instance.id, {
      kind: 'context',
      used: 80,
      total: 100,
      percentage: 80,
      inputTokens: 60,
      outputTokens: 20,
      source: 'provider-usage',
      promptWeight: 0.75,
    }, undefined);
  });

  describe('cost recording on turn completion', () => {
    beforeEach(() => {
      getCostTracker().clearEntries();
    });

    function emitComplete(adapterName: string, usage: CliResponse['usage']): void {
      const adapter = new FakeAdapter(adapterName) as unknown as CliAdapter;
      adapters.set(instance.id, adapter);
      manager.setupAdapterEvents(instance.id, adapter);
      const response: CliResponse = { id: 'r1', content: 'done', role: 'assistant', usage };
      (adapter as unknown as EventEmitter).emit('complete', response);
    }

    it('records a cost entry from completed-turn usage, trusting a provider-supplied cost', () => {
      instance.currentModel = 'claude-sonnet-4-6';
      emitComplete('claude-cli', {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 100,
        totalTokens: 1500,
        cost: 0.0421,
      });

      const entries = getCostTracker().getEntries();
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.instanceId).toBe(instance.id);
      expect(entry.sessionId).toBe('session-1');
      expect(entry.model).toBe('claude-sonnet-4-6');
      expect(entry.inputTokens).toBe(1000);
      expect(entry.outputTokens).toBe(500);
      expect(entry.cacheReadTokens).toBe(200);
      expect(entry.cacheWriteTokens).toBe(100);
      // Provider-supplied total_cost_usd is trusted verbatim.
      expect(entry.cost).toBeCloseTo(0.0421, 6);
    });

    it('records reasoning tokens from completed-turn usage as a separate cost dimension', () => {
      instance.currentModel = 'claude-sonnet-4-6';
      emitComplete('claude-cli', {
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 25,
      });

      const entries = getCostTracker().getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].reasoningTokens).toBe(25);
      expect(getCostTracker().getSummary().totalReasoningTokens).toBe(25);
    });

    it('feeds clean output-token pairs into calibration only when calibration is enabled', () => {
      TokenCounter._resetForTesting();
      instance.currentModel = 'claude-sonnet-4-6';
      const counter = getTokenCounter();
      counter.setCalibrateTokenCounts(true);
      const text = 'calibration sample text';
      const raw = counter.countTokensRaw(text, instance.currentModel);

      const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
      adapters.set(instance.id, adapter);
      manager.setupAdapterEvents(instance.id, adapter);
      const response: CliResponse = {
        id: 'r-cal',
        content: text,
        role: 'assistant',
        usage: { outputTokens: raw * 2 },
      };
      (adapter as unknown as EventEmitter).emit('complete', response);

      expect(counter.getCorrectionFactor(instance.currentModel)).toBeGreaterThan(1);
      counter.setCalibrateTokenCounts(false);
    });

    it('computes cost from tokens when the provider does not supply one', () => {
      instance.currentModel = 'claude-sonnet-4-6';
      emitComplete('claude-cli', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      });

      const entries = getCostTracker().getEntries();
      expect(entries).toHaveLength(1);
      // No provider cost → derived from the per-model rate table (non-zero).
      expect(entries[0].cost).toBeGreaterThan(0);
    });

    it('falls back to the provider name as the model label when no model is set', () => {
      instance.currentModel = undefined;
      emitComplete('claude-cli', { inputTokens: 10, outputTokens: 5, cost: 0.001 });

      const entries = getCostTracker().getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].model).toBe('claude');
    });

    it('does not record when the turn carried no token usage', () => {
      emitComplete('claude-cli', { duration: 1234 });
      expect(getCostTracker().getEntries()).toHaveLength(0);
    });

    it('does not record when usage is absent entirely', () => {
      emitComplete('claude-cli', undefined);
      expect(getCostTracker().getEntries()).toHaveLength(0);
    });

    it('fires the cost-recorded event so downstream consumers (circuit breaker) see spend', () => {
      instance.currentModel = 'claude-sonnet-4-6';
      const recorded = vi.fn();
      getCostTracker().on('cost-recorded', recorded);
      emitComplete('claude-cli', { inputTokens: 100, outputTokens: 50, cost: 0.002 });
      getCostTracker().off('cost-recorded', recorded);
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(recorded.mock.calls[0][0]).toMatchObject({ instanceId: instance.id, cost: 0.002 });
    });
  });

  it('refreshes adapter runtime config before sending normal user input', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const refreshAdapterRuntimeConfig = vi.fn().mockResolvedValue(undefined);
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      refreshAdapterRuntimeConfig,
      emitProviderRuntimeEvent,
    });

    await manager.sendInput(instance.id, 'click the button');

    expect(refreshAdapterRuntimeConfig).toHaveBeenCalledWith(instance.id);
    expect((adapter as unknown as FakeAdapter).sendInput).toHaveBeenCalledWith(
      'click the button',
      undefined,
    );
  });

  it('forwards adapter complete events as provider runtime events', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-1',
      role: 'assistant',
      content: 'done',
      usage: {
        totalTokens: 42,
        cost: 0.25,
        duration: 500,
      },
      metadata: {
        requestId: 'req_complete_123',
        stopReason: 'end_turn',
        rateLimit: { remaining: 9, resetAt: 1_717_000_060_000 },
        quota: { exhausted: false, message: 'ok' },
      },
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(instance.id, {
      kind: 'complete',
      tokensUsed: 42,
      costUsd: 0.25,
      durationMs: 500,
      requestId: 'req_complete_123',
      stopReason: 'end_turn',
      rateLimit: { remaining: 9, resetAt: 1_717_000_060_000 },
      quota: { exhausted: false, message: 'ok' },
    }, undefined);
  });

  it('propagates the A3 degradedReason tag onto the complete runtime event', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-degraded',
      role: 'assistant',
      content: '',
      degradedReason: 'delayed',
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      { kind: 'complete', degradedReason: 'delayed' },
      undefined,
    );
  });

  it('omits degradedReason on healthy completions', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-healthy',
      role: 'assistant',
      content: 'all good',
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      { kind: 'complete' },
      undefined,
    );
  });

  it('preserves provider diagnostics from adapter error objects', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const error = Object.assign(new Error('Rate limited'), {
      requestId: 'req_error_123',
      stopReason: 'rate_limit',
      rateLimit: { remaining: 0, resetAt: 1_717_000_060_000 },
      quota: { exhausted: true, message: 'quota exhausted' },
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('error', error);

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(instance.id, {
      kind: 'error',
      message: 'Rate limited',
      recoverable: false,
      requestId: 'req_error_123',
      stopReason: 'rate_limit',
      rateLimit: { remaining: 0, resetAt: 1_717_000_060_000 },
      quota: { exhausted: true, message: 'quota exhausted' },
    }, undefined);
  });

  it.each([
    [
      'legacy timeout text',
      'ACP session/prompt request timed out after 600000ms (id=3). The agent may be stuck on an orphaned tool call or permission request.',
    ],
    [
      'session/update timeout text',
      'ACP session/prompt request timed out after 600000ms without a session/update (id=3). The agent may be stuck on an orphaned tool call or permission request.',
    ],
  ])('keeps ACP session/prompt %s retryable instead of poisoning the instance', async (_caseName, timeoutError) => {
    const adapter = new AcpCliAdapter({
      adapterName: 'copilot-acp',
      command: process.execPath,
      workingDirectory: '/tmp',
    });
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
    adapter.emit(
      'output',
      createMessage('error', timeoutError, {
        metadata: {
          source: 'acp-send-input',
          transport: 'acp',
          recoverable: true,
          retryKind: 'acp-prompt-timeout',
        },
      }),
    );
    adapter.emit('status', 'idle');
    adapter.emit('error', new Error(timeoutError));
    await flushOutputHandlers();

    expect(instance.status).toBe('idle');
    expect(adapters.get(instance.id)).toBe(adapter);
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'idle', instance.contextUsage);
    expect(
      instance.outputBuffer.filter(
        (message) => message.type === 'error' && message.content === timeoutError,
      ),
    ).toHaveLength(1);
  });

  it('captures baselines from tool_result messages', async () => {
    const captureBaseline = vi.fn();
    const tracker = {
      captureBaseline,
      computeDiff: vi.fn(),
    } as unknown as SessionDiffTracker;
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      getDiffTracker: () => tracker,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'tool-result-1',
      timestamp: Date.now(),
      type: 'tool_result',
      content: '',
      metadata: {
        name: 'Write',
        input: {
          file_path: '/tmp/project/src/main.ts',
          content: 'updated',
        },
      },
    });
    await flushOutputHandlers();

    expect(captureBaseline).toHaveBeenCalledWith('/tmp/project/src/main.ts');
  });

  it('emits file.edited on a mutating tool_use, independent of a diff tracker', async () => {
    emitPluginHookMock.mockClear();
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    // The default beforeEach manager has no getDiffTracker — proves file.edited
    // is decoupled from diff tracking.
    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'tool-use-1',
      timestamp: Date.now(),
      type: 'tool_use',
      content: '',
      metadata: {
        name: 'Edit',
        input: { file_path: '/tmp/project/src/main.ts', old_string: 'a', new_string: 'b' },
      },
    });
    await flushOutputHandlers();

    const fileEditedCalls = emitPluginHookMock.mock.calls.filter((c) => c[0] === 'file.edited');
    expect(fileEditedCalls).toHaveLength(1);
    expect(fileEditedCalls[0][1]).toMatchObject({
      instanceId: instance.id,
      filePath: '/tmp/project/src/main.ts',
      toolName: 'Edit',
      provider: 'claude',
    });
  });

  it('does not emit file.edited for read-only tools or tool_result messages', async () => {
    emitPluginHookMock.mockClear();
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    // Read-only tool → no mutation paths → no file.edited.
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'tool-use-read',
      timestamp: Date.now(),
      type: 'tool_use',
      content: '',
      metadata: { name: 'Read', input: { file_path: '/tmp/project/src/main.ts' } },
    });
    // tool_result carrying a write path → baseline still captured elsewhere, but
    // file.edited is gated to tool_use so it must NOT fire here.
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'tool-result-write',
      timestamp: Date.now(),
      type: 'tool_result',
      content: '',
      metadata: { name: 'Write', input: { file_path: '/tmp/project/src/main.ts', content: 'x' } },
    });
    await flushOutputHandlers();

    const fileEditedCalls = emitPluginHookMock.mock.calls.filter((c) => c[0] === 'file.edited');
    expect(fileEditedCalls).toHaveLength(0);
  });

  it('stores diffStats on busy to idle transitions', () => {
    const diffStats = {
      totalAdded: 8,
      totalDeleted: 3,
      files: {
        'src/main.ts': {
          path: 'src/main.ts',
          status: 'modified' as const,
          added: 8,
          deleted: 3,
        },
      },
    };
    const tracker = {
      captureBaseline: vi.fn(),
      computeDiff: vi.fn(() => diffStats),
    } as unknown as SessionDiffTracker;
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    instance.status = 'busy';

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      getDiffTracker: () => tracker,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'idle');

    expect(instance.diffStats).toEqual(diffStats);
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'idle', instance.contextUsage, diffStats);
  });

  it('notifies the parent when a child finishes a turn without exiting', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    const onChildExit = vi.fn();
    adapters.set(instance.id, adapter);
    instance.parentId = 'parent-1';
    instance.status = 'busy';

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      onChildExit,
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'idle');

    expect(onChildExit).toHaveBeenCalledWith(instance.id, instance, 0);
  });

  it('does not notify child completion for the initial adapter idle status', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    const onChildExit = vi.fn();
    adapters.set(instance.id, adapter);
    instance.parentId = 'parent-1';
    instance.status = 'initializing';

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      onChildExit,
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'idle');

    expect(onChildExit).not.toHaveBeenCalled();
  });

  it('does not count local system messages as process output', () => {
    const onOutput = vi.fn();

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onOutput,
    });

    manager.addToOutputBuffer(instance, createMessage('system', 'Internal warning'));
    expect(onOutput).not.toHaveBeenCalled();

    manager.addToOutputBuffer(instance, createMessage('assistant', 'Real adapter output'), {
      countAsProcessOutput: true,
    });
    // Content is forwarded as the evidence argument for the stuck-detector
    // evidence-hash fence (P4.5).
    expect(onOutput).toHaveBeenCalledWith(instance.id, 'Real adapter output');
  });

  it('drops stale output listeners from an older adapter generation', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit(
      'output',
      createMessage('assistant', 'only once'),
    );
    await flushOutputHandlers();

    const matches = instance.outputBuffer.filter((message) => message.content === 'only once');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.metadata?.['adapterGeneration']).toBe(2);
  });

  it('tags output with adapter generation and active turn id when available', async () => {
    const adapter = new FakeAdapter('codex-cli');
    adapter.currentTurnId = 'turn-123';
    adapters.set(instance.id, adapter as unknown as CliAdapter);

    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
    adapter.emit('output', createMessage('tool_use', 'running'));
    await flushOutputHandlers();

    expect(instance.activeTurnId).toBe('turn-123');
    expect(instance.outputBuffer[0]?.metadata).toMatchObject({
      adapterGeneration: 1,
      turnId: 'turn-123',
    });
  });

  it('resets tool state to idle when adapter becomes ready for input', () => {
    const onToolStateChange = vi.fn();
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    instance.status = 'busy';

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onToolStateChange,
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'waiting_for_input');

    expect(onToolStateChange).toHaveBeenCalledWith(instance.id, 'idle');
  });

  it('clears active turn metadata when adapter returns to an idle-like status', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    instance.status = 'busy';
    instance.activeTurnId = 'turn-123';
    instance.interruptPhase = 'completed';

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'idle');

    expect(instance.activeTurnId).toBeUndefined();
    expect(instance.interruptPhase).toBeUndefined();
    expect(instance.lastTurnOutcome).toBe('completed');
  });

  it('normalizes idle to busy status updates through ready', () => {
    const adapter = new FakeAdapter('copilot-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    instance.status = 'idle';
    const transitionState = vi.fn((target: Instance, status: Instance['status']) => {
      if (target.status === 'idle' && status === 'busy') {
        throw new Error('Illegal transition: idle → busy');
      }
      target.status = status;
    });

    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, currentAdapter) => {
        adapters.set(id, currentAdapter);
      },
      deleteAdapter: (id) => adapters.delete(id),
      transitionState,
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('status', 'busy');

    expect(transitionState).toHaveBeenNthCalledWith(1, instance, 'ready');
    expect(transitionState).toHaveBeenNthCalledWith(2, instance, 'busy');
    expect(instance.status).toBe('busy');
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'busy', instance.contextUsage);
  });

  it('drops unsupported attachments and retries the message without them', async () => {
    const adapter = new FakeAdapter('copilot-cli');
    adapter.sendInput
      .mockRejectedValueOnce(new Error('Copilot adapter does not currently support attachments in orchestrator mode.'))
      .mockResolvedValueOnce(undefined);
    adapters.set(instance.id, adapter as unknown as CliAdapter);

    const attachments = [
      { name: 'screenshot.png', type: 'image/png', size: 3, data: 'abc' },
    ];

    await expect(
      manager.sendInput(instance.id, 'Inspect this screenshot', attachments),
    ).resolves.toBeUndefined();

    expect(adapter.sendInput).toHaveBeenNthCalledWith(1, 'Inspect this screenshot', attachments);
    expect(adapter.sendInput).toHaveBeenNthCalledWith(2, 'Inspect this screenshot', undefined);
    expect(
      instance.outputBuffer.some(
        (message) =>
          message.type === 'system'
          && /copilot-cli does not support image attachments in orchestrator mode/i.test(message.content),
      ),
    ).toBe(true);
  });

  it('suppresses duplicate UI errors while keeping transient stateless exec failures retryable', async () => {
    const adapter = new FakeAdapter('copilot-cli') as unknown as CliAdapter;
    const forwarded: OutputMessage[] = [];
    adapters.set(instance.id, adapter);

    manager.on('output', ({ message }) => {
      forwarded.push(message as OutputMessage);
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'output',
      createMessage('error', 'Copilot CLI timeout after 300000ms'),
    );
    await flushOutputHandlers();

    (adapter as unknown as EventEmitter).emit(
      'error',
      new Error('Copilot CLI timeout after 300000ms'),
    );
    await flushOutputHandlers();

    expect(
      instance.outputBuffer.filter(
        (message) => message.type === 'error' && message.content === 'Copilot CLI timeout after 300000ms',
      ),
    ).toHaveLength(1);
    expect(
      forwarded.filter(
        (message) => message.type === 'error' && message.content === 'Copilot CLI timeout after 300000ms',
      ),
    ).toHaveLength(1);
    expect(instance.status).toBe('idle');
    expect(queueUpdate).toHaveBeenCalledWith(instance.id, 'idle', instance.contextUsage);
  });

  it('blacklists resume session ids when missing conversations arrive as output errors', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'output',
      createMessage('error', 'No conversation found with session ID: session-1'),
    );
    await flushOutputHandlers();

    expect(instance.sessionResumeBlacklisted).toBe(true);
  });

  it('preserves same-content errors when they are separated beyond the duplicate window', async () => {
    const adapter = new FakeAdapter('copilot-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'output',
      {
        ...createMessage('error', 'Copilot CLI timeout after 300000ms'),
        timestamp: Date.now() - 1_001,
      },
    );
    await flushOutputHandlers();

    (adapter as unknown as EventEmitter).emit(
      'error',
      new Error('Copilot CLI timeout after 300000ms'),
    );
    await flushOutputHandlers();

    expect(
      instance.outputBuffer.filter(
        (message) => message.type === 'error' && message.content === 'Copilot CLI timeout after 300000ms',
      ),
    ).toHaveLength(2);
  });

  describe('writeThroughIdentity on session ID change (B4/C1)', () => {
    it('calls writeThroughIdentity immediately when adapter reports a new session ID', async () => {
      mockWriteThroughIdentity.mockClear();

      // Adapter that returns a new session ID different from the instance's current one.
      const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
      (adapter as unknown as FakeAdapter & { getSessionId(): string }).getSessionId = () => 'provider-assigned-id';
      adapters.set(instance.id, adapter);
      instance.providerSessionId = undefined;

      manager.setupAdapterEvents(instance.id, adapter);
      // Emit any output — the session ID sync runs on every output message.
      (adapter as unknown as EventEmitter).emit('output', createMessage('assistant', 'hello'));
      await flushOutputHandlers();

      expect(mockWriteThroughIdentity).toHaveBeenCalledWith(
        instance.id,
        { sessionId: 'provider-assigned-id' },
      );
    });

    it('does not call writeThroughIdentity when the session ID is unchanged', async () => {
      mockWriteThroughIdentity.mockClear();

      const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
      (adapter as unknown as FakeAdapter & { getSessionId(): string }).getSessionId = () => 'session-1';
      adapters.set(instance.id, adapter);
      instance.providerSessionId = 'session-1'; // Same as what adapter returns

      manager.setupAdapterEvents(instance.id, adapter);
      (adapter as unknown as EventEmitter).emit('output', createMessage('assistant', 'hello'));
      await flushOutputHandlers();

      expect(mockWriteThroughIdentity).not.toHaveBeenCalled();
    });
  });
});

describe('tool result deduplication', () => {
  let comm: InstanceCommunicationManager;

  beforeEach(() => {
    comm = new InstanceCommunicationManager({
      getInstance: (id) => (id === 'instance-1' ? createInstance() : undefined),
      getAdapter: () => undefined,
      setAdapter: vi.fn(),
      deleteAdapter: vi.fn(),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });
  });

  it('skips duplicate tool_result with same tool_use_id', () => {
    const instance = createInstance();
    const toolUseId = 'tool-use-123';

    const first = createMessage('tool_result', 'result content', {
      metadata: { tool_use_id: toolUseId, is_error: false },
    });
    const duplicate = createMessage('tool_result', 'result content', {
      metadata: { tool_use_id: toolUseId, is_error: false },
    });

    comm.addToOutputBuffer(instance, first);
    comm.addToOutputBuffer(instance, duplicate);

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
  });

  it('allows tool_result without tool_use_id', () => {
    const instance = createInstance();

    const msg = createMessage('tool_result', 'system result', {
      metadata: {},
    });

    comm.addToOutputBuffer(instance, msg);
    comm.addToOutputBuffer(instance, { ...msg, id: 'different-id' });

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
  });

  it('allows different tool_use_ids', () => {
    const instance = createInstance();

    const msg1 = createMessage('tool_result', 'result 1', {
      metadata: { tool_use_id: 'id-1', is_error: false },
    });
    const msg2 = createMessage('tool_result', 'result 2', {
      metadata: { tool_use_id: 'id-2', is_error: false },
    });

    comm.addToOutputBuffer(instance, msg1);
    comm.addToOutputBuffer(instance, msg2);

    const toolResults = instance.outputBuffer.filter(m => m.type === 'tool_result');
    expect(toolResults).toHaveLength(2);
  });
});

describe('conversation-aware rewind points', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let snapshotSpy: ReturnType<typeof vi.fn>;
  let comm: InstanceCommunicationManager;

  beforeEach(() => {
    instance = createInstance();
    adapters = new Map();
    snapshotSpy = vi.fn();

    comm = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => { adapters.set(id, adapter); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      createSnapshot: snapshotSpy,
    });
  });

  it('hard checkpoint on sendInput', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    await comm.sendInput(instance.id, 'fix the bug');

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    const [calledId, calledName, calledDesc, calledTrigger] = snapshotSpy.mock.calls[0];
    expect(calledId).toBe(instance.id);
    expect(calledName).toMatch(/^Before:/);
    expect(calledDesc).toBeUndefined();
    expect(calledTrigger).toBe('checkpoint');
  });

  it('adds an ultrathink turn hint for Claude while plan mode is planning', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    instance.planMode = {
      enabled: true,
      state: 'planning',
    };

    await comm.sendInput(instance.id, 'draft the implementation plan');

    expect(adapter.sendInput).toHaveBeenCalledWith(
      'ultrathink\n\ndraft the implementation plan',
      undefined,
    );
  });

  it('soft checkpoint after 6+ autonomous tool results', () => {
    // Add 7 tool_result messages without any user input
    for (let i = 0; i < 7; i++) {
      comm.addToOutputBuffer(instance, createMessage('tool_result', `result ${i}`, {
        metadata: { tool_use_id: `id-${i}`, name: 'Read' },
      }));
    }

    // Checkpoint fires at count 6 (count > 5), counter resets, count 7 won't re-trigger
    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    const [, , , calledTrigger] = snapshotSpy.mock.calls[0];
    expect(calledTrigger).toBe('auto');
  });

  it('counter resets on user input', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    // Add 4 tool results (below threshold of 5)
    for (let i = 0; i < 4; i++) {
      comm.addToOutputBuffer(instance, createMessage('tool_result', `result ${i}`, {
        metadata: { tool_use_id: `pre-${i}`, name: 'Read' },
      }));
    }

    // User input resets the counter
    await comm.sendInput(instance.id, 'continue please');
    snapshotSpy.mockClear(); // Clear the hard checkpoint call

    // Add 4 more tool results — counter starts fresh, never exceeds 5
    for (let i = 0; i < 4; i++) {
      comm.addToOutputBuffer(instance, createMessage('tool_result', `result ${i}`, {
        metadata: { tool_use_id: `post-${i}`, name: 'Write' },
      }));
    }

    // No soft checkpoint should have been created
    expect(snapshotSpy).not.toHaveBeenCalled();
  });
});

describe('budget gate', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let comm: InstanceCommunicationManager;
  let adapter: FakeAdapter;

  function build(overrides: { used: number; total: number }): void {
    instance = createInstance();
    instance.contextUsage = { used: overrides.used, total: overrides.total, percentage: 0 };
    adapters = new Map();
    queueUpdate = vi.fn();
    adapter = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapter as unknown as CliAdapter);

    // Real TokenBudgetTracker with matching default budget
    const tracker = new TokenBudgetTracker({ totalBudget: overrides.total });

    comm = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      getBudgetTracker: () => tracker,
      getContextUsage: () => instance.contextUsage,
    });
  }

  it('silently sends user-typed input when context is 90%+ full (no visible message)', async () => {
    build({ used: 180_000, total: 200_000 });

    await comm.sendInput(instance.id, 'user says this after getting stuck');

    // No user-visible budget-gate system message
    const budgetMessages = instance.outputBuffer.filter(
      m => m.type === 'system' && /budget|90%|Sending anyway|budget limit/i.test(m.content)
    );
    expect(budgetMessages.length).toBe(0);

    // Adapter was still called (message delivered)
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
  });

  it('hard-blocks auto-continuations silently when context is 90%+ full', async () => {
    build({ used: 180_000, total: 200_000 });

    await comm.sendInput(instance.id, '[auto] continue', undefined, undefined, { autoContinuation: true });

    // No user-visible budget-gate system message — hard-block is silent now
    const budgetMessages = instance.outputBuffer.filter(
      m => m.type === 'system' && /budget limit reached/i.test(m.content)
    );
    expect(budgetMessages.length).toBe(0);

    // Adapter was NOT called
    expect(adapter.sendInput).not.toHaveBeenCalled();

    // UI was unstuck via queueUpdate('idle', ...)
    const idleCall = queueUpdate.mock.calls.find(call => call[1] === 'idle');
    expect(idleCall).toBeDefined();
  });

  it('passes through normally when context is well under 90%', async () => {
    build({ used: 50_000, total: 200_000 });

    await comm.sendInput(instance.id, 'hello');

    const systemMessages = instance.outputBuffer.filter(m => m.type === 'system');
    expect(systemMessages).toHaveLength(0);
    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
  });
});

// ── A5/A6 generation fence ────────────────────────────────────────────────────

describe('sendInput generation fence (A5/A6)', () => {
  it('sends to adapter B (not A) when adapter is swapped during respawn wait', async () => {
    const instance = createInstance('interrupting');
    const adapters = new Map<string, CliAdapter>();
    const adapterA = new FakeAdapter('claude-cli');
    const adapterB = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapterA as unknown as CliAdapter);
    instance.adapterGeneration = 1;

    // Deferred respawnPromise: resolves when we call `resolve()`
    let resolveRespawn!: () => void;
    instance.respawnPromise = new Promise<void>((r) => { resolveRespawn = r; });

    const comm = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => adapters.set(id, a),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });

    // Start sendInput — it will wait on respawnPromise (instance is 'interrupting')
    const sendPromise = comm.sendInput(instance.id, 'hello after respawn');

    // Simulate respawn: swap in adapter B, bump generation, flip to idle, resolve promise
    await Promise.resolve(); // yield so sendInput enters the respawn wait
    adapters.set(instance.id, adapterB as unknown as CliAdapter);
    instance.adapterGeneration = 2;
    instance.status = 'idle';
    instance.respawnPromise = undefined;
    resolveRespawn();

    await sendPromise;

    expect(adapterA.sendInput).not.toHaveBeenCalled();
    expect(adapterB.sendInput).toHaveBeenCalledWith('hello after respawn', undefined);
  });
});
