import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { SessionDiffTracker } from './session-diff-tracker';
import { PINNED_PROMPT_LIMIT } from './prompt-retention';

// Mutable so LT-046's regression tests can flip `sessionHandoffStateEnabled`
// without disturbing every other test's fixed defaults (outputBufferSize /
// enableDiskStorage are read verbatim elsewhere in this file).
const settingsManagerState = vi.hoisted(() => ({
  outputBufferSize: 100,
  enableDiskStorage: false,
  sessionHandoffStateEnabled: false,
}));

const communicationLoggerMocks = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
const lifecycleHookMocks = vi.hoisted(() => ({
  triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => communicationLoggerMocks,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => settingsManagerState,
  }),
}));

const outputStorageMocks = vi.hoisted(() => ({
  storeMessages: vi.fn<(instanceId: string, messages: unknown[]) => Promise<void>>(
    () => Promise.resolve(),
  ),
  deleteInstance: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => outputStorageMocks,
}));

vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: lifecycleHookMocks.triggerLifecycleHooks,
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

const admissionMocks = vi.hoisted(() => ({
  recordUserSend: vi.fn<() => { admissionId: string } | null>(() => ({ admissionId: 'adm-default' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
}));
vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => admissionMocks,
}));

// LT-004 tests below drive a real CodexCliAdapter through app-server mode.
// Keep all real exports; only stub the process-tree killer and the browser
// approval store lookup so nothing in that codepath touches a real process
// or real approval state (mirrors codex-cli-adapter.app-server.spec.ts).
const listBrowserApprovalRequestsMock = vi.hoisted(() => vi.fn(() => []));
vi.mock('../cli/adapters/codex/app-server-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli/adapters/codex/app-server-client')>();
  return { ...actual, terminateProcessTree: vi.fn() };
});
vi.mock('../browser-gateway/browser-approval-store', () => ({
  getBrowserApprovalStore: () => ({
    listRequests: listBrowserApprovalRequestsMock,
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';
import { InstanceStateMachine } from './instance-state-machine';
import { TokenBudgetTracker } from '../context/token-budget-tracker';
import { AcpCliAdapter } from '../cli/adapters/acp-cli-adapter';
import { CodexCliAdapter } from '../cli/adapters/codex-cli-adapter';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getCostTracker } from '../core/system/cost-tracker';
import { getTokenCounter, TokenCounter } from '../rlm/token-counter';
import { getCacheAnalyticsService, CacheAnalyticsService } from '../context/cache-analytics-service';
import { getHandoffStateService, HandoffStateService } from '../session/handoff-state-service';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { ProviderAuthenticationError } from '../cli/adapters/provider-authentication-error';

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

  override removeAllListeners(): this {
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
    launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
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
    providerSessionId: 'session-1',
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

interface DiagnosticError extends Error {
  code?: string;
  cause?: unknown;
  metadata?: Record<string, unknown>;
}

function createDiagnosticError(
  message: string,
  nameAlias: string,
  codeAlias: string,
): DiagnosticError {
  const cause = Object.assign(new Error(`nested failure for ${codeAlias}`), {
    code: `CAUSE_${nameAlias}`,
    metadata: { sessionRef: codeAlias },
  });
  cause.name = `Cause_${nameAlias}`;
  const error = Object.assign(new Error(message), {
    code: `PROVIDER_${codeAlias}`,
    cause,
    metadata: { recoveryRef: nameAlias },
    requestId: `request-${codeAlias}`,
    quota: { exhausted: true, message: `quota for ${nameAlias}` },
  }) as DiagnosticError;
  error.name = `Provider_${nameAlias}`;
  return error;
}

describe('InstanceCommunicationManager', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let emitProviderRuntimeEvent: ReturnType<typeof vi.fn>;
  let captureProviderRuntimeEvent: ReturnType<typeof vi.fn>;
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
    captureProviderRuntimeEvent = vi.fn();

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
      captureProviderRuntimeEvent,
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

  it('attaches the original adapter payload when emitting a canonical runtime event', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const message = createMessage('assistant', 'captured answer', {
      metadata: { nativeMessageId: 'native-1' },
    });

    const output = vi.fn();
    manager.on('output', output);
    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', message);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(output).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: instance.id,
      message: expect.objectContaining({ type: 'assistant', content: 'captured answer' }),
      raw: {
        source: 'adapter-event:output',
        payload: expect.objectContaining({
          id: message.id,
          content: 'captured answer',
          metadata: { nativeMessageId: 'native-1' },
        }),
      },
    }));
  });

  it('captures a CLI user-message echo without republishing the duplicate transcript event', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const message = createMessage('user', 'private prompt echoed by the CLI');
    const output = vi.fn();
    manager.on('output', output);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', message);
    await flushOutputHandlers();

    expect(captureProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      expect.objectContaining({
        kind: 'output',
        content: 'private prompt echoed by the CLI',
        messageType: 'user',
      }),
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:output' }) }),
    );
    expect(emitProviderRuntimeEvent).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('preserves a JSON-safe raw context payload alongside the canonical event', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('context', {
      used: 80,
      total: 100,
      percentage: 80,
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      expect.objectContaining({ kind: 'context', used: 80 }),
      expect.objectContaining({
        raw: {
          source: 'adapter-event:context',
          payload: expect.objectContaining({
            used: 80,
          }),
        },
      }),
    );
  });

  /**
   * LT-018 regression. The 'context' handler clones the incoming usage to add
   * `occupancyReported`, so it is no longer the same object as `usage`. What
   * the renderer's context ring actually renders is what reaches `queueUpdate`
   * — so queuing the raw `usage` would make a *reporting* provider display
   * "Context window: no data" for most of an active turn, since 'context'
   * events are the highest-frequency per-instance update during a turn.
   */
  it('queues the flagged usage, not the raw event payload, so the ring shows real occupancy', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('context', {
      used: 80,
      total: 100,
      percentage: 80,
    });

    expect(instance.contextUsage).toMatchObject({ used: 80, occupancyReported: true });
    expect(queueUpdate).toHaveBeenCalledWith(
      instance.id,
      instance.status,
      expect.objectContaining({ used: 80, total: 100, occupancyReported: true }),
    );
  });

  /**
   * LT-018 at the source. The Codex app-server adapter emits a `context` event
   * with `used: 0, isEstimated: true` to mean "no per-call occupancy yet and no
   * prior occupancy" (`!hasAccurateOccupancy && used === 0`). Stamping
   * `occupancyReported` on that would republish the exact confident zero this
   * fix removes — straight from the provider, past every renderer gate.
   */
  it('does not mark occupancy reported for a no-reading context event', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('context', {
      used: 0,
      total: 200_000,
      percentage: 0,
      isEstimated: true,
    });

    expect(instance.contextUsage.occupancyReported).toBeUndefined();
  });

  it('still marks occupancy reported for an ESTIMATED reading with real tokens', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('context', {
      used: 90_000,
      total: 200_000,
      percentage: 45,
      isEstimated: true,
    });

    // An estimate off real token spend is still a measurement; it keeps its "~".
    expect(instance.contextUsage.occupancyReported).toBe(true);
    expect(instance.contextUsage.isEstimated).toBe(true);
  });

  /**
   * A provider-observed compaction (`codex/compaction-presentation.ts`) emits
   * the SAME `{used: 0, isEstimated: true}` shape as Codex's "no reading yet",
   * but means the opposite: occupancy was genuinely measured and genuinely
   * reset. Shape alone cannot tell them apart, so history does — a reset must
   * not un-report. Without this, a session at 62% would drop to "no data" on
   * every surface the moment Codex compacted itself.
   */
  it('keeps occupancy reported when a compaction resets a session that had reported', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('context', {
      used: 124_000, total: 200_000, percentage: 62,
    });
    expect(instance.contextUsage.occupancyReported).toBe(true);

    (adapter as unknown as EventEmitter).emit('context', {
      used: 0, total: 200_000, percentage: 0, isEstimated: true, source: 'thread-compacted',
    });

    expect(instance.contextUsage.used).toBe(0);
    expect(instance.contextUsage.occupancyReported).toBe(true);
  });

  it('forwards the occupancy flag on the provider runtime event too, not just the instance', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('context', {
      used: 0, total: 200_000, percentage: 0, isEstimated: true,
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      expect.objectContaining({ kind: 'context', occupancyReported: false }),
      expect.anything(),
    );
  });

  it('clears an expired provider-limit gate after a non-limit turn completes', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    const clearProviderLimitAfterSuccessfulTurn = vi.fn();
    adapters.set(instance.id, adapter);
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, nextAdapter) => adapters.set(id, nextAdapter),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      clearProviderLimitAfterSuccessfulTurn,
    });

    instance.currentModel = 'claude-sonnet-4-5';
    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'r1', content: 'completed normally', role: 'assistant', usage: { outputTokens: 1 },
    } satisfies CliResponse);

    expect(clearProviderLimitAfterSuccessfulTurn).toHaveBeenCalledWith({
      provider: 'claude', model: 'claude-sonnet-4-5', now: expect.any(Number),
    });
  });

  it('forwards tool and spawn adapter events through the raw-backed runtime stream', () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('spawned', 4321);
    (adapter as unknown as EventEmitter).emit('tool_use', {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
    });
    (adapter as unknown as EventEmitter).emit('tool_result', {
      id: 'tool-1',
      name: 'Read',
      arguments: { path: 'README.md' },
      result: 'contents',
    });

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      { kind: 'spawned', pid: 4321 },
      expect.objectContaining({ raw: { source: 'adapter-event:spawned', payload: 4321 } }),
    );
    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      { kind: 'tool_use', toolName: 'Read', toolUseId: 'tool-1', input: { path: 'README.md' } },
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:tool_use' }) }),
    );
    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      { kind: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', success: true, output: 'contents' },
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:tool_result' }) }),
    );
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

  it('omits a crash-recovery cursor from invalid-session notice metadata', async () => {
    const cursor = 'invalid-recovery-cursor-placeholder';
    instance.provider = 'claude';
    instance.sessionId = cursor;
    instance.providerSessionId = cursor;
    instance.metadata = { continuityRevival: true, reason: 'crash-recovery' };
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const outputs: OutputMessage[] = [];
    manager.on('output', (event: { message: OutputMessage }) => outputs.push(event.message));

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'output', createMessage('error', `session not found: ${cursor}`),
    );
    await flushOutputHandlers();

    const notice = outputs.find(
      (message) => (message.metadata?.['notice'] as { kind?: string } | undefined)?.kind
        === 'invalid-session',
    );
    expect(JSON.stringify(outputs)).not.toContain(cursor);
    expect(notice?.metadata?.['notice']).toMatchObject({ recoverySession: true });
  });

  it('redacts crash-recovery adapter errors from buffers, logs, runtime events, and StopFailure hooks', async () => {
    const replacementAlias = 'adapter-error-replacement-fixture-placeholder';
    const sourceAlias = 'adapter-error-source-fixture-placeholder';
    instance.provider = 'cursor';
    instance.sessionId = replacementAlias;
    instance.providerSessionId = replacementAlias;
    instance.historyThreadId = sourceAlias;
    instance.metadata = { continuityRevival: true, reason: 'crash-recovery' };
    const adapter = new FakeAdapter('cursor-acp') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const outputs: OutputMessage[] = [];
    manager.on('output', (event: { message: OutputMessage }) => outputs.push(event.message));
    for (const logger of Object.values(communicationLoggerMocks)) logger.mockClear();
    lifecycleHookMocks.triggerLifecycleHooks.mockClear();
    emitProviderRuntimeEvent.mockClear();

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'error',
      createDiagnosticError(
        `ACP session/prompt request timed out after 100ms (id=${replacementAlias}).`,
        sourceAlias,
        replacementAlias,
      ),
    );
    await flushOutputHandlers();
    (adapter as unknown as EventEmitter).emit(
      'error',
      createDiagnosticError(
        `terminal adapter failure for ${replacementAlias}`,
        sourceAlias,
        replacementAlias,
      ),
    );
    await flushOutputHandlers();

    const observable = JSON.stringify({
      outputBuffer: instance.outputBuffer,
      outputs,
      logs: Object.fromEntries(Object.entries(communicationLoggerMocks).map(
        ([level, logger]) => [level, logger.mock.calls],
      )),
      runtimeEvents: emitProviderRuntimeEvent.mock.calls,
      hooks: lifecycleHookMocks.triggerLifecycleHooks.mock.calls,
    });
    expect(observable).not.toContain(replacementAlias);
    expect(observable).not.toContain(sourceAlias);
    expect(observable).toContain('[recovery identity omitted]');
    expect(lifecycleHookMocks.triggerLifecycleHooks).toHaveBeenCalledWith(
      'StopFailure',
      expect.objectContaining({
        errorMessage: 'terminal adapter failure for [recovery identity omitted]',
      }),
    );
  });

  it('keeps ordinary adapter Error name, code, cause, and metadata raw', async () => {
    const rawAlias = 'ordinary-adapter-error-alias-placeholder';
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    const error = createDiagnosticError(
      `ordinary failure for ${rawAlias}`,
      rawAlias,
      rawAlias,
    );
    adapters.set(instance.id, adapter);
    for (const logger of Object.values(communicationLoggerMocks)) logger.mockClear();

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('error', error);
    await flushOutputHandlers();

    const loggedError = communicationLoggerMocks.error.mock.calls
      .flat()
      .find((value): value is DiagnosticError => value instanceof Error);
    expect(loggedError).toBe(error);
    expect(loggedError?.name).toBe(`Provider_${rawAlias}`);
    expect(loggedError?.code).toBe(`PROVIDER_${rawAlias}`);
    expect(loggedError?.cause).toBe(error.cause);
    expect(loggedError?.metadata).toBe(error.metadata);
  });

  it.each(['interrupted', 'automatic'] as const)(
    'redacts crash-recovery identity when %s exit recovery rejects',
    async (recoveryPath) => {
      const replacementAlias = 'exit-recovery-replacement-fixture-placeholder';
      const sourceAlias = 'exit-recovery-source-fixture-placeholder';
      instance.status = 'idle';
      instance.sessionId = replacementAlias;
      instance.providerSessionId = replacementAlias;
      instance.historyThreadId = sourceAlias;
      instance.metadata = { continuityRevival: true, reason: 'crash-recovery' };
      instance.outputBuffer = [createMessage('user', 'recover this turn')];
      const onInterruptedExit = vi.fn().mockRejectedValue(
        createDiagnosticError(
          `interrupt recovery failed for ${replacementAlias}`,
          sourceAlias,
          replacementAlias,
        ),
      );
      const onUnexpectedExit = vi.fn().mockRejectedValue(
        createDiagnosticError(
          `automatic recovery failed for ${replacementAlias}`,
          sourceAlias,
          replacementAlias,
        ),
      );
      manager = new InstanceCommunicationManager({
        getInstance: (id) => (id === instance.id ? instance : undefined),
        getAdapter: (id) => adapters.get(id),
        setAdapter: (id, replacement) => adapters.set(id, replacement),
        deleteAdapter: (id) => adapters.delete(id),
        queueUpdate,
        processOrchestrationOutput: vi.fn(),
        onInterruptedExit,
        onUnexpectedExit,
        ingestToRLM: vi.fn(),
        ingestToUnifiedMemory: vi.fn(),
      });
      const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
      adapters.set(instance.id, adapter);
      if (recoveryPath === 'interrupted') manager.markInterrupted(instance.id);
      for (const log of Object.values(communicationLoggerMocks)) log.mockClear();

      manager.setupAdapterEvents(instance.id, adapter);
      (adapter as unknown as EventEmitter).emit('exit', null, 'SIGKILL');
      await flushOutputHandlers();

      const observable = JSON.stringify({
        logs: Object.fromEntries(Object.entries(communicationLoggerMocks).map(
          ([level, log]) => [level, log.mock.calls],
        )),
        updates: queueUpdate.mock.calls,
      });
      expect(observable).not.toContain(replacementAlias);
      expect(observable).not.toContain(sourceAlias);
      expect(observable).toContain('[recovery identity omitted]');
      const loggedErrors = communicationLoggerMocks.error.mock.calls
        .flat()
        .filter((value): value is DiagnosticError => value instanceof Error);
      expect(loggedErrors.length).toBeGreaterThan(0);
      for (const loggedError of loggedErrors) {
        expect(loggedError.name).not.toContain(sourceAlias);
        expect(loggedError.code).not.toContain(replacementAlias);
        expect(JSON.stringify(loggedError.cause)).not.toContain(sourceAlias);
      }
    },
  );

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

  it('updates a Claude instance model when Claude reports a safety-route switch', async () => {
    instance.provider = 'claude';
    instance.currentModel = 'claude-fable-5-1';
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit(
      'output',
      createMessage(
        'system',
        'Fable 5.1\'s safeguards flagged this message. Switched to Opus 4.8. Send feedback with /feedback.',
      ),
    );
    await flushOutputHandlers();

    expect(instance.currentModel).toBe('claude-opus-4-8');
    expect(queueUpdate).toHaveBeenCalledWith(
      instance.id, 'idle', instance.contextUsage,
      undefined, undefined, undefined, undefined, undefined, undefined, 'claude-opus-4-8',
    );
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
      // LT-018: the diagnostics panel renders this event rather than the
      // instance's contextUsage, so it carries the same flag. A real
      // provider-usage reading is reported.
      occupancyReported: true,
    }, expect.objectContaining({
      raw: {
        source: 'adapter-event:context',
        payload: expect.objectContaining({ used: 80, total: 100, percentage: 80 }),
      },
    }));
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

    // LT-100: ACP-transport providers (Cursor/Grok/Copilot) whose server sends
    // no `usage` at all now fall back to a heuristic estimate rather than
    // recording zero cost. The estimate must stay visibly tagged all the way
    // through to the cost entry, never blended in as if it were measured.
    describe('LT-100 — estimated ACP usage stays visibly tagged', () => {
      it('carries isEstimated through to the cost entry', () => {
        instance.currentModel = 'cursor-composer';
        emitComplete('cursor-acp', { inputTokens: 40, outputTokens: 60, totalTokens: 100, isEstimated: true });

        const entries = getCostTracker().getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].isEstimated).toBe(true);
      });

      it('does not tag a measured entry as estimated', () => {
        instance.currentModel = 'claude-sonnet-4-6';
        emitComplete('claude-cli', { inputTokens: 40, outputTokens: 60, cost: 0.002 });

        const entries = getCostTracker().getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0].isEstimated).toBeFalsy();
      });

      it('does not feed an estimated turn into token-counter calibration (would compare the heuristic against itself)', () => {
        TokenCounter._resetForTesting();
        instance.currentModel = 'cursor-composer';
        const counter = getTokenCounter();
        counter.setCalibrateTokenCounts(true);
        const text = 'calibration sample text that must not be used';

        const adapter = new FakeAdapter('cursor-acp') as unknown as CliAdapter;
        adapters.set(instance.id, adapter);
        manager.setupAdapterEvents(instance.id, adapter);
        const response: CliResponse = {
          id: 'r-est',
          content: text,
          role: 'assistant',
          usage: { outputTokens: 999, isEstimated: true },
        };
        (adapter as unknown as EventEmitter).emit('complete', response);

        // No genuine sample was recorded, so the correction factor stays at
        // its untouched default (1) rather than being skewed by a
        // self-referential "estimate vs. itself" comparison.
        expect(counter.getCorrectionFactor(instance.currentModel)).toBe(1);
        counter.setCalibrateTokenCounts(false);
      });

      it('does not feed an estimated turn into prompt-cache analytics (no real cache signal exists for it)', () => {
        CacheAnalyticsService._resetForTesting();
        instance.currentModel = 'cursor-composer';
        const recordTurnSpy = vi.spyOn(getCacheAnalyticsService(), 'recordTurn');

        emitComplete('cursor-acp', { inputTokens: 40, outputTokens: 60, isEstimated: true });

        expect(recordTurnSpy).not.toHaveBeenCalled();
        recordTurnSpy.mockRestore();
      });
    });
  });

  // LT-046: `noteTurnCompleted` used to live inside `recordCompletionCost`,
  // which early-returns on any turn without billable `response.usage`. A real
  // resident-Claude-CLI session with 14 completed turns and correctly growing
  // `contextUsage`/`totalTokensUsed` still recorded zero cost-tracker entries,
  // so the handoff state was silently never populated despite the setting
  // being ON — confirmed live via `RestartPolicyHelpers`'s new rung-choice
  // debug log, not by asking a model. `noteTurnCompleted` must fire on every
  // completed turn regardless of whether usage/cost was billable.
  describe('LT-046: rolling handoff state is maintained even when the turn carried no billable usage', () => {
    function emitComplete(usage: CliResponse['usage']): void {
      const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
      adapters.set(instance.id, adapter);
      manager.setupAdapterEvents(instance.id, adapter);
      const response: CliResponse = { id: 'r1', content: 'done', role: 'assistant', usage };
      (adapter as unknown as EventEmitter).emit('complete', response);
    }

    beforeEach(() => {
      HandoffStateService._resetForTesting();
      // The cost tracker is a singleton shared across the whole spec file —
      // an earlier describe (e.g. "cost recording on turn completion") can
      // leave entries behind, which would make the zero-length assertion
      // below flaky depending on run order/file-scope. Match that describe's
      // own beforeEach.
      getCostTracker().clearEntries();
    });

    afterEach(() => {
      settingsManagerState.sessionHandoffStateEnabled = false;
      HandoffStateService._resetForTesting();
    });

    it('maintains handoff state from a turn with zero token usage when the setting is ON', () => {
      settingsManagerState.sessionHandoffStateEnabled = true;
      instance.outputBuffer.push(
        createMessage('user', 'remember X'),
        createMessage('assistant', 'X remembered'),
      );

      emitComplete({ duration: 1234 }); // no billable usage — the exact shape that starved LT-046

      expect(getCostTracker().getEntries()).toHaveLength(0); // cost tracking correctly still skips it
      expect(getHandoffStateService().buildHandoffDocument(instance, 'test')).not.toBeNull();
    });

    it('maintains handoff state from a turn with no usage object at all when the setting is ON', () => {
      settingsManagerState.sessionHandoffStateEnabled = true;
      instance.outputBuffer.push(
        createMessage('user', 'remember Y'),
        createMessage('assistant', 'Y remembered'),
      );

      emitComplete(undefined);

      expect(getHandoffStateService().buildHandoffDocument(instance, 'test')).not.toBeNull();
    });

    it('does not maintain handoff state when the setting is OFF (default)', () => {
      instance.outputBuffer.push(
        createMessage('user', 'remember Z'),
        createMessage('assistant', 'Z remembered'),
      );

      emitComplete({ inputTokens: 100, outputTokens: 50, cost: 0.002 });

      expect(getHandoffStateService().buildHandoffDocument(instance, 'test')).toBeNull();
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
      requestCountAtCompletion: instance.requestCount,
      tokensUsed: 42,
      costUsd: 0.25,
      durationMs: 500,
      requestId: 'req_complete_123',
      stopReason: 'end_turn',
      rateLimit: { remaining: 9, resetAt: 1_717_000_060_000 },
      quota: { exhausted: false, message: 'ok' },
    }, expect.objectContaining({
      raw: expect.objectContaining({ source: 'adapter-event:complete' }),
    }));
  });

  it('repairs a truncated Codex stream from the canonical completed response', async () => {
    instance.provider = 'codex';
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const partial = 'If no remote browser is available, I';
    const complete = `${partial} will stop and tell you rather than falling back to your computer.`;
    const completionOrder: string[] = [];
    manager.on('output', ({ message }: { message: OutputMessage }) => {
      if (message.id === 'codex-agent-message-1') {
        completionOrder.push(`output:${message.content}`);
      }
    });
    emitProviderRuntimeEvent.mockImplementation((_instanceId, event) => {
      if (event.kind === 'complete') {
        completionOrder.push('complete');
      }
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'codex-agent-message-1',
      timestamp: Date.now(),
      type: 'assistant',
      content: partial,
      metadata: {
        streaming: false,
        accumulatedContent: partial,
        turnId: 'turn-1',
      },
    } satisfies OutputMessage);
    await flushOutputHandlers();
    completionOrder.length = 0;

    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-1',
      role: 'assistant',
      content: complete,
    } satisfies CliResponse);
    await flushOutputHandlers();

    expect(instance.outputBuffer).toHaveLength(1);
    expect(instance.outputBuffer[0]).toMatchObject({
      id: 'codex-agent-message-1',
      type: 'assistant',
      content: complete,
      metadata: expect.objectContaining({
        streaming: false,
        accumulatedContent: complete,
      }),
    });
    expect(completionOrder).toEqual([`output:${complete}`, 'complete']);
  });

  it('does not replace divergent Codex output from the completed response', async () => {
    instance.provider = 'codex';
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'codex-agent-message-1',
      timestamp: Date.now(),
      type: 'assistant',
      content: 'Visible answer from another phase',
      metadata: {
        streaming: false,
        accumulatedContent: 'Visible answer from another phase',
      },
    } satisfies OutputMessage);
    await flushOutputHandlers();

    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-1',
      role: 'assistant',
      content: 'Different canonical answer',
    } satisfies CliResponse);
    await flushOutputHandlers();

    expect(instance.outputBuffer[0]?.content).toBe('Visible answer from another phase');
    expect(instance.outputBuffer[0]?.metadata?.['completionReconciled']).toBeUndefined();
  });

  it('does not replace a non-Codex streamed prefix from the completed response', async () => {
    instance.provider = 'claude';
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const partial = 'A partial answer';

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', {
      id: 'claude-message-1',
      timestamp: Date.now(),
      type: 'assistant',
      content: partial,
      metadata: {
        streaming: false,
        accumulatedContent: partial,
      },
    } satisfies OutputMessage);
    await flushOutputHandlers();

    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-1',
      role: 'assistant',
      content: `${partial} with more detail`,
    } satisfies CliResponse);
    await flushOutputHandlers();

    expect(instance.outputBuffer[0]?.content).toBe(partial);
    expect(instance.outputBuffer[0]?.metadata?.['completionReconciled']).toBeUndefined();
  });

  it('drops a Codex completion that becomes stale while context evidence drains', async () => {
    instance.provider = 'codex';
    const oldAdapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    const newAdapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    const partial = 'Partial answer from the old generation';
    let releaseDrain: (() => void) | undefined;
    const drainContextEvidence = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseDrain = resolve;
      }),
    );
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
      drainContextEvidence,
      emitProviderRuntimeEvent,
    });

    adapters.set(instance.id, oldAdapter);
    manager.setupAdapterEvents(instance.id, oldAdapter);
    (oldAdapter as unknown as EventEmitter).emit('output', {
      id: 'old-codex-message',
      timestamp: Date.now(),
      type: 'assistant',
      content: partial,
      metadata: {
        streaming: false,
        accumulatedContent: partial,
      },
    } satisfies OutputMessage);
    await flushOutputHandlers();

    (oldAdapter as unknown as EventEmitter).emit('complete', {
      id: 'old-response',
      role: 'assistant',
      content: `${partial} with text that must not be restored`,
    } satisfies CliResponse);
    expect(drainContextEvidence).toHaveBeenCalledWith(instance.id);

    manager.setupAdapterEvents(instance.id, newAdapter);
    adapters.set(instance.id, newAdapter);
    releaseDrain?.();
    await flushOutputHandlers();

    expect(instance.outputBuffer[0]?.content).toBe(partial);
    expect(instance.outputBuffer[0]?.metadata?.['completionReconciled']).toBeUndefined();
    expect(emitProviderRuntimeEvent).not.toHaveBeenCalledWith(
      instance.id,
      expect.objectContaining({ kind: 'complete' }),
      expect.anything(),
    );
  });

  it('captures the completion request count before context evidence drains', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    let releaseDrain: (() => void) | undefined;
    const drainContextEvidence = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => {
        releaseDrain = resolve;
      }),
    );
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
      drainContextEvidence,
      emitProviderRuntimeEvent,
    });
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('complete', {
      id: 'response-before-new-turn',
      role: 'assistant',
      content: "I'll now run the tests.",
    } satisfies CliResponse);
    expect(drainContextEvidence).toHaveBeenCalledWith(instance.id);
    instance.requestCount = 1;
    releaseDrain?.();
    await flushOutputHandlers();

    expect(emitProviderRuntimeEvent).toHaveBeenCalledWith(
      instance.id,
      expect.objectContaining({
        kind: 'complete',
        requestCountAtCompletion: 0,
      }),
      expect.anything(),
    );
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
      { kind: 'complete', degradedReason: 'delayed', requestCountAtCompletion: 0 },
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:complete' }) }),
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
      { kind: 'complete', requestCountAtCompletion: 0 },
      expect.objectContaining({ raw: expect.objectContaining({ source: 'adapter-event:complete' }) }),
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
    }, expect.objectContaining({
      raw: expect.objectContaining({ source: 'adapter-event:error' }),
    }));
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

    // A watchdog's own "this looks stuck" notice arrives through the adapter
    // output path with countAsProcessOutput set, but it is not the process
    // making progress. Counting it resets the stuck detector's clock and its
    // softWarningEmitted latch, so a repeating watchdog would indefinitely
    // postpone the escalation it exists to trigger.
    onOutput.mockClear();
    manager.addToOutputBuffer(
      instance,
      createMessage('system', 'This turn hasn\'t produced any output for 300s', {
        metadata: { watchdogWarning: true, source: 'acp-stall-warning' },
      }),
      { countAsProcessOutput: true },
    );
    expect(onOutput).not.toHaveBeenCalled();
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

  it('compacts and retries when sendInput throws a provider-specific context overflow', async () => {
    const adapter = new FakeAdapter('gemini-cli');
    adapter.sendInput
      .mockRejectedValueOnce(new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).'))
      .mockResolvedValueOnce(undefined);
    const compactContext = vi.fn().mockResolvedValue(undefined);
    adapters.set(instance.id, adapter as unknown as CliAdapter);

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
      compactContext,
      emitProviderRuntimeEvent,
    });

    await manager.sendInput(instance.id, 'summarize the workspace');

    expect(compactContext).toHaveBeenCalledWith(instance.id);
    expect(adapter.sendInput).toHaveBeenCalledTimes(2);
    expect(adapter.sendInput.mock.calls[1][0]).toContain('[SYSTEM: Context Overflow Recovery]');
    expect(instance.outputBuffer.some(message => message.metadata?.['contextOverflow'] === true)).toBe(true);
  });

  it('compacts immediately on a silent empty assistant response near the context ceiling', async () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    const compactContext = vi.fn().mockResolvedValue(undefined);
    adapters.set(instance.id, adapter);
    instance.status = 'busy';
    instance.contextUsage = {
      used: 198_200,
      total: 200_000,
      percentage: 99.1,
      inputTokens: 198_200,
      outputTokens: 0,
    };

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
      compactContext,
      emitProviderRuntimeEvent,
    });

    manager.setupAdapterEvents(instance.id, adapter);
    (adapter as unknown as EventEmitter).emit('output', createMessage('assistant', ''));
    await flushOutputHandlers();

    expect(compactContext).toHaveBeenCalledWith(instance.id);
    expect(instance.outputBuffer.some(message => message.metadata?.['contextOverflow'] === true)).toBe(true);
    expect(instance.outputBuffer.some(message => message.type === 'assistant' && message.content === '')).toBe(false);
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
      (instance as unknown as { providerSessionId: string | undefined }).providerSessionId = undefined;

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

/**
 * LT-034: the 80 % context warning injects "your context is at N% capacity,
 * delegate to children" INTO the conversation. For a provider that reports
 * cumulative spend rather than window occupancy, that threshold fires on total
 * tokens billed while the real context is nearly empty — so a false positive
 * actively degrades the run, not just the UI.
 */
describe('LT-034: context warning suppression for aggregate-only providers', () => {
  class OccupancyAdapter extends FakeAdapter {
    constructor(private readonly reporting: 'current' | 'aggregate-only') {
      super('claude-cli');
    }
    getContextCapabilities() {
      return { occupancyReporting: this.reporting };
    }
    getRuntimeCapabilities() {
      // Not self-managing compaction, so the warning is otherwise eligible.
      return { supportsNativeCompaction: false, selfManagedAutoCompaction: false };
    }
  }

  function runWithAdapter(reporting: 'current' | 'aggregate-only'): OutputMessage[] {
    const instance = createInstance('busy');
    const adapters = new Map<string, CliAdapter>();
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => { adapters.set(id, adapter); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: vi.fn(),
      captureProviderRuntimeEvent: vi.fn(),
    });

    const adapter = new OccupancyAdapter(reporting) as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const messages: OutputMessage[] = [];
    manager.on('output', (e: { message: OutputMessage }) => messages.push(e.message));
    manager.setupAdapterEvents(instance.id, adapter);

    // 170k of 200k: well past the 80 % threshold on either reading.
    (adapter as unknown as EventEmitter).emit('context', {
      used: 170_000, total: 200_000, percentage: 85, cumulativeTokens: 170_000,
    });
    return messages;
  }

  it('does NOT inject a context warning when the number is cumulative spend', () => {
    const warnings = runWithAdapter('aggregate-only')
      .filter((m) => m.metadata?.['contextWarning'] === true);
    expect(warnings).toHaveLength(0);
  });

  it('still injects the warning for a provider that reports real occupancy', () => {
    const warnings = runWithAdapter('current')
      .filter((m) => m.metadata?.['contextWarning'] === true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].content).toContain('85%');
  });
});

describe('LT-004: Codex app-server exit classification', () => {
  // Reproduces the live-test defect at the instance-communication integration
  // level: a resident Codex app-server process dying was logged as "Ignoring
  // per-turn process exit for stateless exec adapter" and skipped recovery
  // entirely, because the exit-time classification read state that the
  // adapter had already reset to its non-resident value. These tests drive a
  // real CodexCliAdapter into app-server mode, crash its app-server
  // connection, and assert the exit handler now takes the unexpected-exit
  // (or interrupted-exit) recovery branch instead of the early
  // stateless-exec-adapter return.
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let onUnexpectedExit: ReturnType<typeof vi.fn>;
  let onInterruptedExit: ReturnType<typeof vi.fn>;
  let manager: InstanceCommunicationManager;

  function buildInstance(status: Instance['status']): Instance {
    const built = createInstance(status);
    // canAutoRespawn requires conversation worth preserving.
    built.outputBuffer = [createMessage('user', 'do the thing')];
    return built;
  }

  beforeEach(() => {
    adapters = new Map();
    queueUpdate = vi.fn();
    onUnexpectedExit = vi.fn().mockResolvedValue(undefined);
    onInterruptedExit = vi.fn().mockResolvedValue(undefined);
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => adapters.set(id, adapter),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit,
      onUnexpectedExit,
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });
  });

  interface FakeAppServerClient {
    request: ReturnType<typeof vi.fn>;
    exitPromise: Promise<void>;
    getExitError(): Error | null;
    subscribeNotifications: ReturnType<typeof vi.fn>;
  }

  /** Drives a real CodexCliAdapter into app-server mode and returns a
   * `crash()` helper that fails its app-server connection, mirroring what
   * happens when the resident process's verified PID is killed. */
  async function spawnResidentCodexAdapter(): Promise<{
    adapter: CodexCliAdapter;
    crash(error: Error | null): Promise<void>;
  }> {
    const adapter = new CodexCliAdapter();
    let resolveExit!: () => void;
    let exitError: Error | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const client: FakeAppServerClient = {
      request: vi.fn(async () => ({ threadId: 'thread-lt004-ic' })),
      exitPromise,
      getExitError: () => exitError,
      subscribeNotifications: vi.fn(() => () => {}),
    };
    vi.spyOn(
      adapter as unknown as { connectAppServer(cwd: string): Promise<unknown> },
      'connectAppServer',
    ).mockResolvedValue(client);

    await (adapter as unknown as { initAppServerMode(): Promise<void> }).initAppServerMode();
    (adapter as unknown as { isSpawned: boolean }).isSpawned = true;
    (adapter as unknown as { useAppServer: boolean }).useAppServer = true;
    expect(adapter.isAppServerMode()).toBe(true);

    return {
      adapter,
      async crash(error) {
        exitError = error;
        resolveExit();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  it('routes an app-server exit while busy through unexpected-exit recovery instead of the stateless-exec ignore path', async () => {
    instance = buildInstance('busy');
    const { adapter, crash } = await spawnResidentCodexAdapter();
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);

    await crash(new Error('codex app-server crashed'));

    expect(onUnexpectedExit).toHaveBeenCalledWith(instance.id);
    expect(onInterruptedExit).not.toHaveBeenCalled();
    expect(instance.status).toBe('respawning');
  });

  it('routes an app-server exit while idle through unexpected-exit recovery instead of the stateless-exec ignore path', async () => {
    instance = buildInstance('idle');
    const { adapter, crash } = await spawnResidentCodexAdapter();
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);

    await crash(new Error('codex app-server crashed'));

    expect(onUnexpectedExit).toHaveBeenCalledWith(instance.id);
    expect(onInterruptedExit).not.toHaveBeenCalled();
    expect(instance.status).toBe('respawning');
  });

  it('routes an app-server exit through the interrupted-instance recovery path, not the generic unexpected-exit path, when an interrupt is in flight', async () => {
    instance = buildInstance('busy');
    const { adapter, crash } = await spawnResidentCodexAdapter();
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
    manager.markInterrupted(instance.id);

    await crash(new Error('codex app-server crashed'));

    expect(onInterruptedExit).toHaveBeenCalledWith(instance.id);
    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });
});

describe('LT-023: a suppressed respawn defers and retries instead of dying silently', () => {
  // Reproduces the live-test defect: two CLI crashes inside the 5s
  // recent-respawn suppression window used to leave the instance in a
  // terminal `error` state with no waitReason and nothing scheduled,
  // because the suppression sat in front of the circuit breaker and the
  // normal auto-respawn call was simply never made. These tests drive the
  // exit handler directly and assert the exit is deferred and retried
  // instead of being abandoned.
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let onUnexpectedExit: ReturnType<typeof vi.fn>;
  let manager: InstanceCommunicationManager;

  function buildEligibleInstance(): Instance {
    const built = createInstance('idle');
    // canAutoRespawn / wouldAutoRespawnIfNotRecent require conversation
    // worth preserving.
    built.outputBuffer = [createMessage('user', 'do the thing')];
    // A prior respawn "just" completed — inside the 5s suppression window.
    built.lastRespawnAt = Date.now();
    return built;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    adapters = new Map();
    queueUpdate = vi.fn();
    onUnexpectedExit = vi.fn().mockResolvedValue(undefined);
    instance = buildEligibleInstance();
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => adapters.set(id, adapter),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      onUnexpectedExit,
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defers a suppressed exit into a scheduled retry instead of leaving the instance terminal in error', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('exit', null, 'SIGKILL');

    // Not left terminal: respawning with a backoff waitReason, not `error`
    // with nothing scheduled.
    expect(instance.status).toBe('respawning');
    expect(onUnexpectedExit).not.toHaveBeenCalled();
    expect(queueUpdate).toHaveBeenCalledWith(
      instance.id,
      'respawning',
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      expect.objectContaining({ kind: 'backoff', retryAt: expect.any(Number) }),
    );

    // Once the suppression window elapses, the deferred retry actually fires
    // — routing through the normal auto-respawn path (and, inside it, the
    // circuit breaker's own backoff ladder).
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onUnexpectedExit).toHaveBeenCalledWith(instance.id);
  });

  it('does not fire the deferred retry if the instance moved on while waiting', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('exit', null, 'SIGKILL');
    expect(instance.status).toBe('respawning');

    // Something else (e.g. a deliberate termination) settles the instance
    // before the deferred retry's timer fires.
    instance.status = 'terminated';

    await vi.advanceTimersByTimeAsync(5_000);

    expect(onUnexpectedExit).not.toHaveBeenCalled();
  });

  it('redacts crash-recovery identity when the deferred retry rejects', async () => {
    const replacementAlias = 'deferred-respawn-replacement-fixture-placeholder';
    const sourceAlias = 'deferred-respawn-source-fixture-placeholder';
    instance.sessionId = replacementAlias;
    instance.providerSessionId = replacementAlias;
    instance.historyThreadId = sourceAlias;
    instance.metadata = { continuityRevival: true, reason: 'crash-recovery' };
    onUnexpectedExit.mockRejectedValueOnce(createDiagnosticError(
      `deferred retry failed for ${replacementAlias}`,
      sourceAlias,
      replacementAlias,
    ));
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);
    for (const log of Object.values(communicationLoggerMocks)) log.mockClear();

    (adapter as unknown as EventEmitter).emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(5_000);

    const observable = JSON.stringify({
      logs: Object.fromEntries(Object.entries(communicationLoggerMocks).map(
        ([level, log]) => [level, log.mock.calls],
      )),
      updates: queueUpdate.mock.calls,
    });
    expect(observable).not.toContain(replacementAlias);
    expect(observable).not.toContain(sourceAlias);
    expect(observable).toContain('[recovery identity omitted]');
    const loggedErrors = communicationLoggerMocks.error.mock.calls
      .flat()
      .filter((value): value is DiagnosticError => value instanceof Error);
    expect(loggedErrors.length).toBeGreaterThan(0);
    for (const loggedError of loggedErrors) {
      expect(loggedError.name).not.toContain(sourceAlias);
      expect(loggedError.code).not.toContain(replacementAlias);
      expect(JSON.stringify(loggedError.cause)).not.toContain(sourceAlias);
    }
  });

  it('still terminates immediately when the restart cap is already exhausted, even inside the suppression window', () => {
    instance.restartCount = 5;
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    manager.setupAdapterEvents(instance.id, adapter);

    (adapter as unknown as EventEmitter).emit('exit', null, 'SIGKILL');

    expect(instance.status).toBe('error');
    expect(onUnexpectedExit).not.toHaveBeenCalled();
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

describe('SessionAdmissionService observability on the user send path (Phase A)', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let comm: InstanceCommunicationManager;

  beforeEach(() => {
    admissionMocks.recordUserSend.mockReset();
    admissionMocks.recordUserSend.mockReturnValue({ admissionId: 'adm-default' });
    admissionMocks.markDelivered.mockClear();
    admissionMocks.markFailed.mockClear();

    instance = createInstance();
    adapters = new Map();

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
    });
  });

  it('records the send before dispatch and marks it delivered on success', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    await comm.sendInput(instance.id, 'fix the bug');

    expect(admissionMocks.recordUserSend).toHaveBeenCalledWith(
      instance.id, 'fix the bug', undefined, undefined,
    );
    expect(admissionMocks.markDelivered).toHaveBeenCalledWith('adm-default');
    expect(admissionMocks.markFailed).not.toHaveBeenCalled();
  });

  it('marks the admission failed (without swallowing the original error) when the adapter send rejects', async () => {
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    (adapter.sendInput as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('adapter exploded'));
    adapters.set(instance.id, adapter);

    await expect(comm.sendInput(instance.id, 'fix the bug')).rejects.toThrow('adapter exploded');

    expect(admissionMocks.markFailed).toHaveBeenCalledWith('adm-default', 'adapter exploded');
    expect(admissionMocks.markDelivered).not.toHaveBeenCalled();
  });

  it('does not break the send when recordUserSend returns null (store unavailable)', async () => {
    admissionMocks.recordUserSend.mockReturnValue(null);
    const adapter = new FakeAdapter('claude-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);

    await comm.sendInput(instance.id, 'fix the bug');

    expect(adapter.sendInput).toHaveBeenCalledWith('fix the bug', undefined);
    expect(admissionMocks.markDelivered).not.toHaveBeenCalled();
    expect(admissionMocks.markFailed).not.toHaveBeenCalled();
  });
});

describe('budget gate', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let comm: InstanceCommunicationManager;
  let adapter: FakeAdapter;
  let createSnapshot: ReturnType<typeof vi.fn>;

  function build(overrides: { used: number; total: number }): void {
    instance = createInstance();
    instance.contextUsage = { used: overrides.used, total: overrides.total, percentage: 0 };
    adapters = new Map();
    queueUpdate = vi.fn();
    createSnapshot = vi.fn();
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
      createSnapshot,
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

  it('keeps queued continuity and prior send state when the auto-continuation budget gate blocks', async () => {
    build({ used: 50_000, total: 200_000 });
    await comm.sendInput(instance.id, 'original user turn');
    const internal = comm as unknown as {
      lastSentMessages: Map<string, { message: string }>;
    };

    comm.queueContinuityPreamble(instance.id, 'queued late context');
    instance.contextUsage = { used: 180_000, total: 200_000, percentage: 90 };
    await comm.sendInput(
      instance.id,
      'automated nudge',
      undefined,
      undefined,
      { autoContinuation: true },
    );

    expect(adapter.sendInput).toHaveBeenCalledTimes(1);
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(internal.lastSentMessages.get(instance.id)?.message).toBe('original user turn');

    instance.contextUsage = { used: 50_000, total: 200_000, percentage: 25 };
    await comm.sendInput(instance.id, 'new human turn');
    expect(adapter.sendInput).toHaveBeenLastCalledWith(
      'queued late context\n\nnew human turn',
      undefined,
    );
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

// ── Provider-limit park on thrown sendInput errors (2026-07-11 park-fix) ─────

describe('provider-limit park on thrown sendInput errors', () => {
  const LIVE_INCIDENT_MESSAGE =
    "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or "
    + 'try again at 5:01 PM. - [codex_error_info: usageLimitExceeded]';

  let instance: Instance;
  let adapters: Map<string, CliAdapter>;
  let queueUpdate: ReturnType<typeof vi.fn>;
  let onToolStateChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    instance = createInstance();
    adapters = new Map();
    queueUpdate = vi.fn();
    onToolStateChange = vi.fn();
  });

  function createManager(
    onProviderLimitTurn: ReturnType<typeof vi.fn>,
    transitionState?: ReturnType<typeof vi.fn>,
  ): InstanceCommunicationManager {
    return new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => { adapters.set(id, adapter); },
      deleteAdapter: (id) => adapters.delete(id),
      transitionState,
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onToolStateChange,
      onProviderLimitTurn,
    });
  }

  it('parks (no rethrow, instance ends idle) when sendInput rejects with a usage-limit error', async () => {
    const adapter = new FakeAdapter('codex-cli');
    adapter.sendInput.mockRejectedValue(new Error(LIVE_INCIDENT_MESSAGE));
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    const transitionState = vi.fn((inst: Instance, status) => { inst.status = status; });
    const onProviderLimitTurn = vi.fn().mockReturnValue('parked');
    const manager = createManager(onProviderLimitTurn, transitionState);

    await expect(manager.sendInput(instance.id, 'keep going')).resolves.toBeUndefined();

    expect(onProviderLimitTurn).toHaveBeenCalledTimes(1);
    const call = onProviderLimitTurn.mock.calls[0][0];
    expect(call.instanceId).toBe(instance.id);
    expect(call.resetAtHint).not.toBeNull();
    expect(call.resumePrompt).toBe('keep going');

    expect(transitionState).toHaveBeenCalledWith(instance, 'idle');
    expect(instance.status).toBe('idle');
    expect(onToolStateChange).toHaveBeenCalledWith(instance.id, 'idle');
    expect(
      instance.outputBuffer.some(
        (m) => m.type === 'system' && m.metadata?.['providerLimitParked'] === true,
      ),
    ).toBe(true);
  });

  it('does not dispatch a turn when the provider-limit preflight parks a known active gate', async () => {
    const adapter = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.currentModel = 'claude-sonnet-4-5';
    const checkKnownProviderLimitBeforeSend = vi.fn().mockReturnValue('parked');
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, nextAdapter) => adapters.set(id, nextAdapter),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      checkKnownProviderLimitBeforeSend,
    });

    await expect(manager.sendInput(instance.id, 'continue the task')).resolves.toBeUndefined();

    expect(checkKnownProviderLimitBeforeSend).toHaveBeenCalledWith({
      instanceId: instance.id,
      provider: 'claude',
      model: 'claude-sonnet-4-5',
      prompt: 'continue the task',
    });
    expect(adapter.sendInput).not.toHaveBeenCalled();
  });

  it('preserves queued continuity context when the provider-limit preflight parks a turn', async () => {
    const adapter = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    const checkKnownProviderLimitBeforeSend = vi.fn()
      .mockReturnValueOnce('parked')
      .mockReturnValueOnce('skipped');
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, nextAdapter) => adapters.set(id, nextAdapter),
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      checkKnownProviderLimitBeforeSend,
    });
    manager.queueContinuityPreamble(instance.id, 'Prior context that must survive the park.');

    await manager.sendInput(instance.id, 'continue the task');
    await manager.sendInput(instance.id, 'continue the task');

    expect(adapter.sendInput).toHaveBeenCalledWith(
      'Prior context that must survive the park.\n\ncontinue the task',
      undefined,
    );
  });

  it('acknowledges an already-parked send quietly: no duplicate park message, no status change', async () => {
    const adapter = new FakeAdapter('codex-cli');
    adapter.sendInput.mockRejectedValue(new Error(LIVE_INCIDENT_MESSAGE));
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'idle';

    const transitionState = vi.fn((inst: Instance, status) => { inst.status = status; });
    const onProviderLimitTurn = vi.fn().mockReturnValue('already-parked');
    const manager = createManager(onProviderLimitTurn, transitionState);

    await expect(manager.sendInput(instance.id, 'are you there?')).resolves.toBeUndefined();

    expect(transitionState).not.toHaveBeenCalled();
    expect(instance.status).toBe('idle');
    const parkMessages = instance.outputBuffer.filter(
      (m) => m.type === 'system' && m.metadata?.['providerLimitParked'] === true,
    );
    expect(parkMessages).toHaveLength(1);
    expect(parkMessages[0].metadata?.['alreadyParked']).toBe(true);
  });

  it('rethrows exactly as before when the park handler skips (feature off / no hint)', async () => {
    const adapter = new FakeAdapter('codex-cli');
    adapter.sendInput.mockRejectedValue(new Error(LIVE_INCIDENT_MESSAGE));
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    const transitionState = vi.fn((inst: Instance, status) => { inst.status = status; });
    const onProviderLimitTurn = vi.fn().mockReturnValue('skipped');
    const manager = createManager(onProviderLimitTurn, transitionState);

    await expect(manager.sendInput(instance.id, 'keep going')).rejects.toThrow(LIVE_INCIDENT_MESSAGE);

    expect(transitionState).not.toHaveBeenCalled();
    expect(instance.status).toBe('busy');
    expect(
      instance.outputBuffer.some(
        (m) => m.type === 'system' && m.metadata?.['providerLimitParked'] === true,
      ),
    ).toBe(false);
  });

  it('rethrows a non-limit thrown error (auth) untouched and never calls onProviderLimitTurn', async () => {
    const adapter = new FakeAdapter('codex-cli');
    adapter.sendInput.mockRejectedValue(new Error('unauthorized: authentication required'));
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    const transitionState = vi.fn((inst: Instance, status) => { inst.status = status; });
    const onProviderLimitTurn = vi.fn().mockReturnValue('parked');
    const manager = createManager(onProviderLimitTurn, transitionState);

    await expect(manager.sendInput(instance.id, 'keep going')).rejects.toThrow(/unauthorized/i);

    expect(onProviderLimitTurn).not.toHaveBeenCalled();
    expect(transitionState).not.toHaveBeenCalled();
    expect(instance.status).toBe('busy');
  });

  it('reports an auth-shaped thrown error for repair while still rethrowing it', async () => {
    // In-session auth repair is additive: the caller must still see the error
    // (the transcript keeps it, the instance still errors) — the report only
    // lets the repair handler attach the banner and watch for a sign-in.
    const adapter = new FakeAdapter('claude-cli');
    adapter.sendInput.mockRejectedValue(
      new Error('Failed to authenticate: OAuth session expired and could not be refreshed'),
    );
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    const onProviderLimitTurn = vi.fn().mockReturnValue('skipped');
    const onAuthFailureTurn = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onProviderLimitTurn,
      onAuthFailureTurn,
    });

    await expect(manager.sendInput(instance.id, 'keep going')).rejects.toThrow(/OAuth session expired/);

    expect(onAuthFailureTurn).toHaveBeenCalledTimes(1);
    expect(onAuthFailureTurn.mock.calls[0][0]).toMatchObject({
      instanceId: instance.id,
      resumeTurn: { message: 'keep going' },
      authoritative: false,
    });
  });

  it('reports a structured adapter auth failure authoritatively with the complete lost turn', async () => {
    const adapter = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    const onAuthFailureTurn = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onAuthFailureTurn,
    });
    const attachments = [{
      name: 'notes.txt',
      type: 'text/plain',
      size: 5,
      data: 'hello',
    }];
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);
    manager.queueContinuityPreamble(instance.id, 'one-shot continuity');
    await manager.sendInput(instance.id, 'keep going', attachments, 'resolved context');

    adapter.emit('error', new ProviderAuthenticationError(
      'Failed to authenticate: OAuth session expired and could not be refreshed',
      'authentication_failed',
    ));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onAuthFailureTurn).toHaveBeenCalledTimes(1);
    expect(onAuthFailureTurn.mock.calls[0][0]).toEqual({
      instanceId: instance.id,
      reason: expect.stringContaining('provider protocol reported auth failure'),
      resumeTurn: {
        message: 'keep going',
        attachments,
        contextBlock: 'one-shot continuity\n\nresolved context',
      },
      authoritative: true,
    });
  });

  it('notifies auth repair only after the adapter emits a real completion', async () => {
    const adapter = new FakeAdapter('claude-cli');
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    const onAuthRepairReplayComplete = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onAuthRepairReplayComplete,
    });
    manager.setupAdapterEvents(instance.id, adapter as unknown as CliAdapter);

    adapter.emit('complete', {
      id: 'replay-response',
      role: 'assistant',
      content: 'Recovered response',
    } satisfies CliResponse);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(onAuthRepairReplayComplete).toHaveBeenCalledWith(instance.id);
  });

  it('does not report an ordinary thrown failure as an auth failure', async () => {
    const adapter = new FakeAdapter('claude-cli');
    adapter.sendInput.mockRejectedValue(new Error('Process exited unexpectedly with code 143'));
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    instance.status = 'busy';

    const onAuthFailureTurn = vi.fn();
    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      onAuthFailureTurn,
    });

    await expect(manager.sendInput(instance.id, 'keep going')).rejects.toThrow(/exited unexpectedly/);

    expect(onAuthFailureTurn).not.toHaveBeenCalled();
  });

  it('leaves the thrown-overflow compaction path untouched when both are wired', async () => {
    const adapter = new FakeAdapter('gemini-cli');
    adapter.sendInput
      .mockRejectedValueOnce(new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).'))
      .mockResolvedValueOnce(undefined);
    adapters.set(instance.id, adapter as unknown as CliAdapter);
    const compactContext = vi.fn().mockResolvedValue(undefined);
    const onProviderLimitTurn = vi.fn().mockReturnValue('parked');

    const manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, a) => { adapters.set(id, a); },
      deleteAdapter: (id) => adapters.delete(id),
      queueUpdate,
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      compactContext,
      onProviderLimitTurn,
    });

    await manager.sendInput(instance.id, 'summarize the workspace');

    expect(compactContext).toHaveBeenCalledWith(instance.id);
    expect(onProviderLimitTurn).not.toHaveBeenCalled();
    expect(adapter.sendInput).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Adapter status events during a hibernate-wake
// ---------------------------------------------------------------------------

describe('InstanceCommunicationManager – adapter status during wake', () => {
  let instance: Instance;
  let adapters: Map<string, CliAdapter>;

  function createWakeManager(): InstanceCommunicationManager {
    const stateMachines = new Map<string, InstanceStateMachine>();
    return new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: (id) => adapters.get(id),
      setAdapter: (id, adapter) => { adapters.set(id, adapter); },
      deleteAdapter: (id) => adapters.delete(id),
      transitionState: (inst, status) => {
        let sm = stateMachines.get(inst.id);
        if (!sm) {
          sm = new InstanceStateMachine(inst.status);
          stateMachines.set(inst.id, sm);
        }
        sm.transition(status);
        inst.status = sm.current;
      },
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
    });
  }

  beforeEach(() => {
    instance = createInstance('waking');
    adapters = new Map();
  });

  it('accepts the idle status stateless exec adapters emit from spawn()', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const manager = createWakeManager();
    manager.setupAdapterEvents(instance.id, adapter);

    expect(() => adapter.emit('status', 'idle')).not.toThrow();
    expect(instance.status).toBe('idle');
  });

  it('ignores a status the state machine rejects instead of throwing into the adapter', () => {
    const adapter = new FakeAdapter('codex-cli') as unknown as CliAdapter;
    adapters.set(instance.id, adapter);
    const manager = createWakeManager();
    manager.setupAdapterEvents(instance.id, adapter);

    expect(() => adapter.emit('status', 'waiting_for_input')).not.toThrow();
    expect(instance.status).toBe('waking');
  });
});

describe('prompt retention across output buffer overflow', () => {
  let instance: Instance;
  let manager: InstanceCommunicationManager;
  const bufferSize = 100;

  beforeEach(() => {
    outputStorageMocks.storeMessages.mockClear();
    settingsManagerState.outputBufferSize = bufferSize;
    instance = createInstance();
    manager = new InstanceCommunicationManager({
      getInstance: (id) => (id === instance.id ? instance : undefined),
      getAdapter: () => undefined,
      setAdapter: () => undefined,
      deleteAdapter: () => false,
      queueUpdate: vi.fn(),
      processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: vi.fn(),
      captureProviderRuntimeEvent: vi.fn(),
    });
  });

  afterEach(() => {
    settingsManagerState.enableDiskStorage = false;
  });

  /** Push an opening prompt, then enough tool traffic to overflow the buffer. */
  function overflowWithOpeningPrompt(opening: string, extra = bufferSize * 2): OutputMessage {
    const prompt = createMessage('user', opening);
    manager.addToOutputBuffer(instance, prompt);
    for (let i = 0; i < extra; i++) {
      manager.addToOutputBuffer(instance, createMessage('tool_result', `noise ${i}`));
    }
    return prompt;
  }

  it('retains the opening prompt after it is evicted from the buffer', () => {
    const prompt = overflowWithOpeningPrompt('Migrate the billing service.');

    expect(instance.outputBuffer.some((m) => m.id === prompt.id)).toBe(false);
    expect(instance.retainedPrompts?.map((m) => m.content)).toEqual(['Migrate the billing service.']);
  });

  it('retains the opening prompt even when disk storage is disabled', () => {
    settingsManagerState.enableDiskStorage = false;

    const prompt = overflowWithOpeningPrompt('Disk storage is off.');

    expect(outputStorageMocks.storeMessages).not.toHaveBeenCalled();
    expect(instance.retainedPrompts?.some((m) => m.id === prompt.id)).toBe(true);
  });

  it('leaves outputBuffer positions untouched so fork and rewind stay addressable', () => {
    overflowWithOpeningPrompt('First thing asked.');

    // Exactly the newest bufferSize messages, nothing spliced in front.
    expect(instance.outputBuffer).toHaveLength(bufferSize);
    expect(instance.outputBuffer.every((m) => m.type === 'tool_result')).toBe(true);
  });

  it('keeps the retained set bounded under sustained prompt traffic', () => {
    manager.addToOutputBuffer(instance, createMessage('user', 'opening'));
    for (let i = 0; i < bufferSize * 5; i++) {
      manager.addToOutputBuffer(instance, createMessage('user', `prompt ${i}`));
    }

    expect(instance.retainedPrompts!.length).toBeLessThanOrEqual(PINNED_PROMPT_LIMIT);
    expect(instance.retainedPrompts![0].content).toBe('opening');
  });

  it('does not touch retainedPrompts when the buffer never overflows', () => {
    manager.addToOutputBuffer(instance, createMessage('user', 'short session'));

    expect(instance.retainedPrompts).toBeUndefined();
  });

  it('still persists overflow to disk when disk storage is on', () => {
    settingsManagerState.enableDiskStorage = true;

    const prompt = overflowWithOpeningPrompt('Anything.');

    const persisted = outputStorageMocks.storeMessages.mock.calls
      .flatMap(([, messages]) => messages as OutputMessage[]);
    expect(persisted.some((m) => m.id === prompt.id)).toBe(true);
    expect(persisted.some((m) => m.type === 'tool_result')).toBe(true);
  });
});
