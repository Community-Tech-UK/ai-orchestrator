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

vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';
import { TokenBudgetTracker } from '../context/token-budget-tracker';

class FakeAdapter extends EventEmitter {
  sendInput = vi.fn().mockResolvedValue(undefined);

  constructor(private readonly adapterName: string) {
    super();
  }

  getName(): string {
    return this.adapterName;
  }

  getSessionId(): string | null {
    return null;
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
    expect(onOutput).toHaveBeenCalledWith(instance.id);
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
