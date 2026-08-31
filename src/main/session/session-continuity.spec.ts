import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ContinuityConfig,
  SessionState,
  SessionSnapshot,
  SessionContinuityManager,
} from './session-continuity';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';

const mockState = vi.hoisted(() => ({
  userDataDir: '',
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false),
    encryptString: vi.fn((value: string) => Buffer.from(value, 'utf8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mockState.userDataDir),
  },
  safeStorage: mockState.safeStorage,
}));

// session-continuity.ts reaches safeStorage through this small relative-path
// seam (see safe-storage-accessor.ts). Mocking it here means the production
// code always uses `mockState.safeStorage` — vitest reliably intercepts
// relative imports between project files, whereas `require('electron')` can
// leak through to Node's native module resolution.
vi.mock('./safe-storage-accessor', () => ({
  getSafeStorage: () => mockState.safeStorage,
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => mockState.logger,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn(() => true),
  }),
}));

import { LEGACY_REDACTED_TOOL_OUTPUT } from './redacted-tool-output';
import { SessionContinuityManager as ImportedSessionContinuityManager } from './session-continuity';
import { getSessionMutex, _resetSessionMutexForTesting } from './session-mutex';
import { _resetSessionPersistenceQueueForTesting } from './session-persistence-queue';
import {
  RECOVERY_FALLBACK_WINDOW_MS,
  SessionRecoveryCandidateService,
  type ContinuityRecoveryMetadata,
} from './session-recovery-candidate-service';
import { reviveContinuitySession } from '../instance/lifecycle/continuity-revival';
import { mapAdapterRuntimeEvent } from '../providers/adapter-runtime-event-bridge';
import {
  outputMessageToContinuityEntry,
  providerRuntimeEnvelopeToContinuityEntry,
} from './continuity-message-projection';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { buildObservedCompactionEvents } from '../cli/adapters/codex/compaction-presentation';
import { writeContinuityPayloadAsyncAtomic } from './continuity-recovery-metadata';
import type { SessionContinuityPersistenceOperations } from './session-continuity-persistence-operations';

/** Cast-target for accessing private/protected members in tests. */
interface TestableSessionContinuityManager {
  readyPromise: Promise<void>;
  waitForRecoveryDiscoveryReady(): Promise<void>;
  startTracking(instance: Instance): Promise<void>;
  readPayload<T>(filePath: string): Promise<T | null>;
  deserializePayload<T>(raw: string, filePath?: string): T | null;
  getResumableSessions(): Promise<SessionState[]>;
  resumeSession(instanceId: string): Promise<SessionState | null>;
  importSession(data: { state: SessionState; snapshots?: unknown[] }, newInstanceId?: string): Promise<string>;
  addConversationEntry(instanceId: string, entry: SessionState['conversationHistory'][number]): Promise<void>;
  patchConversationEntry(
    instanceId: string,
    entryId: string,
    patch: Partial<Omit<SessionState['conversationHistory'][number], 'id'>>,
  ): Promise<void>;
  createSnapshot(instanceId: string, name?: string, description?: string, trigger?: string): Promise<SessionSnapshot | null>;
  exportSession(instanceId: string): Promise<{ state: SessionState; snapshots: SessionSnapshot[] } | null>;
  listSnapshots(instanceId?: string): SessionSnapshot[];
  updateState(instanceId: string, updates: Partial<SessionState>): Promise<void>;
  markNativeResumeFailed(instanceId: string, errorCode?: number): Promise<void>;
  writeThroughIdentity(instanceId: string, identity: { sessionId?: string; resumeCursor?: unknown; nativeResumeFailedAt?: number | null }): Promise<void>;
  writeThroughIdentityLocked(instanceId: string, identity: { sessionId?: string; resumeCursor?: unknown; nativeResumeFailedAt?: number | null }): Promise<void>;
  setInstanceManager(instanceManager: {
    getAdapter(instanceId: string): unknown;
    getInstance?(instanceId: string): { status: string } | undefined;
  }): void;
  captureResumeCursor(instanceId: string, state: SessionState): void;
  buildRecoverableSessionList(): Array<{
    instanceId: string;
    historyThreadId?: string;
    lastActivityAt: number;
    isLive: boolean;
    messageCount: number;
    hasAssistantOutput: boolean;
  }>;
  getSessionState(instanceId: string): SessionState | null;
  isInitDegraded(): boolean;
  listContinuityRecoveryMetadata(
    modifiedSince: number,
    preferredInstanceIds?: readonly string[],
  ): Promise<ContinuityRecoveryMetadata[]>;
  loadRecoveryState(sourceInstanceId: string): Promise<SessionState | null>;
  exportSession(instanceId: string): Promise<{ state: SessionState; snapshots: SessionSnapshot[] } | null>;
  queueStateSaveAsync(instanceId: string): Promise<void>;
  shutdown(): void;
}

interface TestableSessionContinuityPrototype {
  initAsync(): Promise<void>;
}

function makeState(instanceId: string): SessionState {
  return {
    instanceId,
    displayName: `Session ${instanceId}`,
    agentId: 'agent-1',
    modelId: 'claude-3-5-sonnet',
    workingDirectory: '/workspace',
    conversationHistory: [
      {
        id: 'entry-1',
        role: 'user',
        content: 'hello',
        timestamp: Date.now(),
      },
    ],
    contextUsage: {
      used: 123,
      total: 200000,
    },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  };
}

function createEnvelope(data: unknown): string {
  return JSON.stringify({
    encrypted: false,
    data: JSON.stringify(data),
  });
}

function getLogCall(calls: unknown[][], message: string): unknown[] | undefined {
  return calls.find(([entry]) => entry === message);
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function readEnvelope<T>(filePath: string): Promise<T> {
  const raw = JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as { data: string };
  return JSON.parse(raw.data) as T;
}

describe('SessionContinuityManager logging', () => {
  const tempDirs: string[] = [];
  const managers: SessionContinuityManager[] = [];

  function createManager(
    config: Partial<ContinuityConfig> = {},
    persistenceOperations: Partial<SessionContinuityPersistenceOperations> = {},
  ): TestableSessionContinuityManager {
    const manager = new ImportedSessionContinuityManager({
      autoSaveEnabled: false,
      ...config,
    }, persistenceOperations) as unknown as TestableSessionContinuityManager;
    managers.push(manager as unknown as SessionContinuityManager);
    return manager;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    mockState.safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'));
    mockState.userDataDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'session-continuity-')
    );
    tempDirs.push(mockState.userDataDir);
  });

  it('persists one atomic runtime snapshot without mutating the provider cursor', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const state = { ...makeState('atomic-runtime'), provider: 'codex' as const };
    const providerCursor = Object.freeze({
      provider: 'codex' as const,
      threadId: 'thread-7',
      workspacePath: '/workspace',
      capturedAt: 100,
      scanSource: 'native' as const,
    });
    const getResumeCursor = vi.fn(() => {
      throw new Error('legacy cursor getter must not be read after the snapshot');
    });
    manager.setInstanceManager({
      getAdapter: () => ({
        getRuntimeSnapshot: () => ({
          revision: 7,
          capturedAt: 101,
          providerSessionId: 'thread-7',
          nativeThreadId: 'thread-7',
          resumeCursor: providerCursor,
        }),
        getResumeCursor,
      }),
    });

    manager.captureResumeCursor('atomic-runtime', state);

    expect(state.sessionId).toBe('thread-7');
    expect(state.resumeCursor).toMatchObject({
      threadId: 'thread-7',
      configFingerprint: expect.any(String),
    });
    expect(providerCursor).not.toHaveProperty('configFingerprint');
    expect(getResumeCursor).not.toHaveBeenCalled();
  });

  it('rolls back tracking atomically when a real tracking observer throws', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const instance = {
      id: 'observer-failure', displayName: 'Observer failure', agentId: 'build',
      currentModel: 'opus', provider: 'claude', workingDirectory: '/workspace',
      outputBuffer: [], retainedPrompts: [],
      contextUsage: { used: 0, total: 1_000, percentage: 0 }, lastActivity: 100,
    } as unknown as Instance;
    const internals = manager as unknown as {
      on(event: 'tracking:started', listener: () => void): void;
      dirty: Set<string>;
      stateRecoveryMetadata: Map<string, unknown>;
    };
    internals.on('tracking:started', () => {
      throw new Error('fixture tracking observer failure');
    });

    await expect(manager.startTracking(instance))
      .rejects.toThrow('fixture tracking observer failure');

    expect(manager.getSessionState(instance.id)).toBeNull();
    expect(internals.dirty.has(instance.id)).toBe(false);
    expect(internals.stateRecoveryMetadata.has(instance.id)).toBe(false);
    await expect(fs.promises.access(path.join(
      mockState.userDataDir, 'session-continuity', 'states', `${instance.id}.json`,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.promises.access(path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', `${instance.id}.json`,
    ))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('round-trips typed visible output through disk state into crash recovery', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const sourceInstance = {
      id: 'typed-roundtrip',
      displayName: 'Typed roundtrip',
      agentId: 'build',
      currentModel: 'opus',
      provider: 'claude',
      workingDirectory: '/workspace',
      historyThreadId: undefined,
      sessionId: undefined,
      isRenamed: false,
      outputBuffer: [
        {
          id: 'tool-call-1', timestamp: 100, type: 'tool_use', content: '',
          metadata: {
            id: 'call-placeholder', name: 'Read', input: { path: '/fixture' },
            tokens: 17, isCompacted: true,
          },
          thinking: [{
            id: 'thinking-1', content: 'Inspect the fixture.', format: 'structured', tokenCount: 4,
          }],
          thinkingExtracted: true,
        },
        {
          id: 'tool-result-1', timestamp: 101, type: 'tool_result', content: 'fixture result',
          metadata: { tool_use_id: 'call-placeholder', is_error: true },
        },
      ],
      retainedPrompts: [],
      contextUsage: { used: 17, total: 1_000, percentage: 1.7 },
      lastActivity: 101,
    } as unknown as Instance;
    await manager.startTracking(sourceInstance);
    await manager.writeThroughIdentity(sourceInstance.id, {});
    const recoveredState = await readEnvelope<SessionState>(path.join(
      mockState.userDataDir,
      'session-continuity',
      'states',
      `${sourceInstance.id}.json`,
    ));
    expect(recoveredState.conversationHistory).toEqual([
      {
        id: 'tool-call-1', role: 'assistant', content: '', timestamp: 100, tokens: 17,
        toolUse: {
          kind: 'call', toolName: 'Read', input: { path: '/fixture' },
          callId: 'call-placeholder',
        },
        thinking: 'Inspect the fixture.',
        thinkingBlocks: [{
          id: 'thinking-1', content: 'Inspect the fixture.', format: 'structured', tokenCount: 4,
        }],
        isCompacted: true,
        compaction: { boundary: true },
      },
      {
        id: 'tool-result-1', role: 'tool', content: 'fixture result', timestamp: 101,
        toolUse: {
          kind: 'result', toolName: 'Read', input: null, output: 'fixture result',
          resultForCallId: 'call-placeholder', isError: true,
        },
      },
    ]);

    let recoveryConfig: InstanceCreateConfig | undefined;
    await reviveContinuitySession({
      resumeSession: vi.fn(),
      createInstance: vi.fn(),
      createRecoveryInstance: async (config) => {
        recoveryConfig = config;
        return {
          instance: { id: 'typed-replacement', status: 'idle', ...config } as unknown as Instance,
          publish: vi.fn(async () => undefined),
          rollback: vi.fn(async () => undefined),
        };
      },
      queueContinuityPreamble: vi.fn(),
      now: () => 1_000,
    }, {
      sourceInstanceId: sourceInstance.id,
      reason: 'crash-recovery',
      resolvedCandidate: {
        candidate: {
          recoveryKey: `instance:${sourceInstance.id}`,
          sourceInstanceId: sourceInstance.id,
          provider: 'claude',
          workingDirectory: '/workspace',
          lastActivityAt: 101,
          recoveredMessageCount: 2,
          reason: 'unarchived',
          nativeResumeAvailable: false,
        },
        continuityState: recoveredState,
        historyConversation: null,
      },
    });

    expect(recoveryConfig?.initialOutputBuffer).toEqual([
      expect.objectContaining({
        id: 'tool-call-1', type: 'tool_use', metadata: {
          toolName: 'Read', input: { path: '/fixture' }, id: 'call-placeholder', tokens: 17,
          isCompacted: true, isCompactionBoundary: true,
        },
        thinking: [expect.objectContaining({ content: 'Inspect the fixture.' })],
      }),
      expect.objectContaining({
        id: 'tool-result-1', type: 'tool_result',
        metadata: {
          toolName: 'Read', input: null, output: 'fixture result',
          tool_use_id: 'call-placeholder', is_error: true,
        },
      }),
    ]);
  });

  it('round-trips actual bridged tool, thinking, token, and compaction events through disk recovery', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const instance = {
      id: 'bridged-roundtrip', displayName: 'Bridged roundtrip', agentId: 'build',
      currentModel: 'opus', provider: 'claude', workingDirectory: '/workspace',
      outputBuffer: [], retainedPrompts: [],
      contextUsage: { used: 0, total: 1_000, percentage: 0 }, lastActivity: 100,
    } as unknown as Instance;
    await manager.startTracking(instance);
    const toolUse = mapAdapterRuntimeEvent('tool_use', [{
      id: 'call-placeholder', name: 'Read', input: { path: '/fixture' },
    }]);
    const toolResult = mapAdapterRuntimeEvent('tool_result', [{
      tool_use_id: 'call-placeholder', name: 'Read', content: 'fixture result', is_error: false,
    }]);
    const thinking = mapAdapterRuntimeEvent('output', [{
      id: 'thinking-output-placeholder', timestamp: 90, type: 'assistant', content: 'answer fixture',
      thinking: [{
        id: 'thinking-placeholder', content: 'reasoning fixture',
        format: 'structured', tokenCount: 4,
      }],
      thinkingExtracted: true,
    }]);
    const observedCompaction = buildObservedCompactionEvents({
      contextWindow: 1_000, cumulativeTokens: 30, costEstimate: 0,
    });
    observedCompaction.output.id = 'compaction-placeholder';
    observedCompaction.output.timestamp = 95;
    const compaction = mapAdapterRuntimeEvent('output', [observedCompaction.output]);
    expect(toolUse && toolResult && thinking && compaction).toBeTruthy();
    const thinkingMessage = toOutputMessageFromProviderEnvelope({
      eventId: '00000000-0000-4000-8000-000000000003', seq: 3, timestamp: 90,
      provider: 'claude', instanceId: instance.id, event: thinking!.event,
    });
    const compactionMessage = toOutputMessageFromProviderEnvelope({
      eventId: '00000000-0000-4000-8000-000000000004', seq: 4, timestamp: 95,
      provider: 'codex', instanceId: instance.id, event: compaction!.event,
    });
    expect(thinkingMessage && compactionMessage).toBeTruthy();
    const callEntry = providerRuntimeEnvelopeToContinuityEntry({
      eventId: '00000000-0000-4000-8000-000000000001', seq: 1, timestamp: 100,
      provider: 'claude', instanceId: instance.id, event: toolUse!.event,
    });
    const resultEntry = providerRuntimeEnvelopeToContinuityEntry({
      eventId: '00000000-0000-4000-8000-000000000002', seq: 2, timestamp: 101,
      provider: 'claude', instanceId: instance.id, event: toolResult!.event,
    });
    expect(callEntry && resultEntry).toBeTruthy();
    await manager.addConversationEntry(
      instance.id,
      outputMessageToContinuityEntry(thinkingMessage!),
    );
    await manager.addConversationEntry(
      instance.id,
      outputMessageToContinuityEntry(compactionMessage!),
    );
    await manager.addConversationEntry(instance.id, callEntry!);
    await manager.addConversationEntry(instance.id, resultEntry!);
    await manager.patchConversationEntry(instance.id, callEntry!.id, {
      tokens: 28,
      tokenUsage: {
        input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 2, total: 28,
      },
    });
    await manager.writeThroughIdentity(instance.id, {});

    const recoveredState = await readEnvelope<SessionState>(path.join(
      mockState.userDataDir, 'session-continuity', 'states', `${instance.id}.json`,
    ));
    expect(recoveredState.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'thinking-output-placeholder', role: 'assistant',
        thinkingBlocks: [expect.objectContaining({
          id: 'thinking-placeholder', content: 'reasoning fixture', tokenCount: 4,
        })],
      }),
      expect.objectContaining({
        id: 'compaction-placeholder', role: 'system', isCompacted: true,
        compaction: { boundary: true },
      }),
      expect.objectContaining({
        id: 'tool-call:call-placeholder',
        toolUse: expect.objectContaining({ kind: 'call', callId: 'call-placeholder' }),
        tokenUsage: { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 2, total: 28 },
      }),
      expect.objectContaining({
        id: 'tool-result:call-placeholder:00000000-0000-4000-8000-000000000002',
        toolUse: expect.objectContaining({
          kind: 'result', resultForCallId: 'call-placeholder', isError: false,
        }),
      }),
    ]);

    let recoveryConfig: InstanceCreateConfig | undefined;
    await reviveContinuitySession({
      resumeSession: vi.fn(), createInstance: vi.fn(),
      createRecoveryInstance: async (config) => {
        recoveryConfig = config;
        return {
          instance: { id: 'bridged-replacement', status: 'idle', ...config } as unknown as Instance,
          publish: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined),
        };
      },
      queueContinuityPreamble: vi.fn(), now: () => 1_000,
    }, {
      sourceInstanceId: instance.id,
      reason: 'crash-recovery',
      resolvedCandidate: {
        candidate: {
          recoveryKey: `instance:${instance.id}`, sourceInstanceId: instance.id,
          provider: 'claude', workingDirectory: '/workspace', lastActivityAt: 101,
          recoveredMessageCount: 4, reason: 'unarchived', nativeResumeAvailable: false,
        },
        continuityState: recoveredState,
        historyConversation: null,
      },
    });

    expect(recoveryConfig?.initialOutputBuffer).toEqual([
      expect.objectContaining({
        id: 'thinking-output-placeholder', type: 'assistant',
        thinking: [expect.objectContaining({
          id: 'thinking-placeholder', content: 'reasoning fixture', tokenCount: 4,
        })],
      }),
      expect.objectContaining({
        id: 'compaction-placeholder', type: 'system',
        metadata: expect.objectContaining({
          isCompacted: true, isCompactionBoundary: true,
        }),
      }),
      expect.objectContaining({
        type: 'tool_use',
        metadata: expect.objectContaining({ id: 'call-placeholder', tokens: 28 }),
      }),
      expect.objectContaining({
        type: 'tool_result',
        metadata: expect.objectContaining({
          tool_use_id: 'call-placeholder', is_error: false, output: 'fixture result',
        }),
      }),
    ]);

    const secondGeneration = {
      id: 'bridged-second-generation', displayName: 'Bridged second generation', agentId: 'build',
      currentModel: 'opus', provider: 'claude', workingDirectory: '/workspace',
      outputBuffer: recoveryConfig?.initialOutputBuffer ?? [], retainedPrompts: [],
      contextUsage: { used: 28, total: 1_000, percentage: 2.8 }, lastActivity: 200,
    } as unknown as Instance;
    await manager.startTracking(secondGeneration);
    await manager.writeThroughIdentity(secondGeneration.id, {});
    const secondGenerationState = await readEnvelope<SessionState>(path.join(
      mockState.userDataDir, 'session-continuity', 'states', `${secondGeneration.id}.json`,
    ));
    expect(secondGenerationState.conversationHistory).toContainEqual(
      expect.objectContaining({
        id: 'tool-call:call-placeholder',
        tokens: 28,
        tokenUsage: {
          input: 11, output: 7, cacheRead: 5, cacheWrite: 3, reasoning: 2, total: 28,
        },
      }),
    );
  });

  it('builds snapshot records from persisted activity and the read-only live-instance lookup', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const active = makeState('current-instance');
    active.historyThreadId = 'history-current';
    active.lastWriteTimestamp = 30;
    active.conversationHistory = [
      { id: 'user-entry', role: 'user', content: 'placeholder', timestamp: 40 },
      { id: 'assistant-entry', role: 'assistant', content: 'placeholder', timestamp: 50 },
    ];
    const stopped = makeState('stopped-instance');
    stopped.conversationHistory = [];

    await manager.importSession({ state: active });
    await manager.importSession({ state: stopped });
    const persistedActive = manager.getSessionState('current-instance');
    if (persistedActive) persistedActive.lastWriteTimestamp = 30;
    manager.setInstanceManager({
      getAdapter: () => undefined,
      getInstance: (instanceId) => instanceId === 'current-instance'
        ? { status: 'busy' }
        : undefined,
    });

    const records = manager.buildRecoverableSessionList();

    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        instanceId: 'current-instance',
        historyThreadId: 'history-current',
        lastActivityAt: 50,
        isLive: true,
        messageCount: 2,
        hasAssistantOutput: true,
      }),
      expect.objectContaining({
        instanceId: 'stopped-instance',
        isLive: false,
        messageCount: 0,
        hasAssistantOutput: false,
      }),
    ]));
  });

  it('enumerates only recent recovery metadata, isolates corrupt files, and loads state on demand', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    const recent = makeState('recent-recovery');
    recent.historyThreadId = 'stable-thread';
    recent.provider = 'claude';
    recent.sessionId = 'provider-session-placeholder';
    recent.conversationHistory.push({
      id: 'assistant-fixture',
      role: 'assistant',
      content: 'fixture response',
      timestamp: Date.now(),
    });
    const recentFile = path.join(stateDir, 'recent-recovery.json');
    const staleFile = path.join(stateDir, 'stale-recovery.json');
    await fs.promises.writeFile(recentFile, createEnvelope(recent));
    await fs.promises.writeFile(staleFile, createEnvelope(makeState('stale-recovery')));
    await fs.promises.writeFile(
      path.join(stateDir, 'corrupt-recovery.json'),
      '{"sensitive transcript fixture":',
    );
    const staleAt = new Date(Date.now() - RECOVERY_FALLBACK_WINDOW_MS - 1_000);
    await fs.promises.utimes(staleFile, staleAt, staleAt);

    const manager = createManager();
    await manager.readyPromise;
    await fs.promises.writeFile(
      path.join(stateDir, 'structurally-corrupt.json'),
      createEnvelope({ ...makeState('structurally-corrupt'), conversationHistory: [null] }),
    );
    mockState.logger.error.mockClear();
    mockState.logger.warn.mockClear();

    const records = await manager.listContinuityRecoveryMetadata(
      Date.now() - RECOVERY_FALLBACK_WINDOW_MS,
    );

    expect(records).toEqual([
      expect.objectContaining({
        sourceInstanceId: 'recent-recovery',
        recoveryKey: 'history:claude:stable-thread',
        messageCount: 2,
        hasUserPrompt: true,
        hasAssistantOutput: true,
      }),
    ]);
    expect(JSON.stringify(mockState.logger.error.mock.calls)).not.toContain('sensitive transcript fixture');
    expect(JSON.stringify(mockState.logger.warn.mock.calls)).not.toContain('corrupt-recovery');
    await expect(manager.loadRecoveryState('recent-recovery')).resolves.toMatchObject({
      instanceId: 'recent-recovery',
      historyThreadId: 'stable-thread',
    });
  });

  it('keeps candidate discovery behind actual initialization after the startup timeout', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, 'delayed-recovery.json'),
      createEnvelope(makeState('delayed-recovery')),
    );
    const barrier = createDeferred();
    const prototype = ImportedSessionContinuityManager.prototype as unknown as TestableSessionContinuityPrototype;
    const originalInit = prototype.initAsync;
    vi.spyOn(prototype, 'initAsync').mockImplementation(async function initAfterBarrier(
      this: SessionContinuityManager,
    ) {
      await barrier.promise;
      await originalInit.call(this);
    });
    vi.useFakeTimers();

    try {
      const manager = createManager();
      const metadata = vi.spyOn(manager, 'listContinuityRecoveryMetadata');
      const service = new SessionRecoveryCandidateService({
        getSnapshot: () => null,
        waitForContinuityReady: () => manager.waitForRecoveryDiscoveryReady(),
        listContinuityMetadata: (modifiedSince, preferredInstanceIds) =>
          manager.listContinuityRecoveryMetadata(modifiedSince, preferredInstanceIds),
        loadContinuityState: (sourceInstanceId) => manager.loadRecoveryState(sourceInstanceId),
        waitForHistoryReady: async () => undefined,
        getHistoryCoverage: async () => new Map(),
        loadHistoryConversation: async () => null,
        getLiveRecoveryKeys: () => new Set(),
        now: () => Date.now(),
      });
      let discoverySettled = false;
      const discovery = service.listCandidates().then((candidates) => {
        discoverySettled = true;
        return candidates;
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await manager.readyPromise;
      expect(manager.isInitDegraded()).toBe(true);
      expect(discoverySettled).toBe(false);
      expect(metadata).not.toHaveBeenCalled();

      barrier.resolve();
      await expect(discovery).resolves.toEqual([
        expect.objectContaining({ sourceInstanceId: 'delayed-recovery' }),
      ]);
      expect(manager.isInitDegraded()).toBe(false);
      await service.listCandidates();
      expect(metadata).toHaveBeenCalledOnce();
    } finally {
      barrier.resolve();
      vi.useRealTimers();
    }
  });

  it('uses persisted conversation activity rather than a touched file mtime', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    const copied = makeState('copied-state');
    copied.lastWriteTimestamp = 100;
    copied.conversationHistory[0].timestamp = 200;
    const copiedFile = path.join(stateDir, 'copied-state.json');
    await fs.promises.writeFile(copiedFile, createEnvelope(copied));
    const touched = new Date(Date.now());
    await fs.promises.utimes(copiedFile, touched, touched);
    const manager = createManager();
    await manager.readyPromise;

    const records = await manager.listContinuityRecoveryMetadata(0);

    expect(records.find((record) => record.sourceInstanceId === 'copied-state')?.lastActivityAt)
      .toBe(200);
  });

  it('persists a lightweight recovery sidecar without conversation content', async () => {
    const manager = createManager();
    await manager.readyPromise;
    await manager.importSession({ state: makeState('sidecar-state') });

    const raw = JSON.parse(await fs.promises.readFile(path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'sidecar-state.json',
    ), 'utf8')) as { data: string };
    const sidecar = JSON.parse(raw.data) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ sourceInstanceId: 'sidecar-state', messageCount: 1 });
    expect(sidecar).not.toHaveProperty('conversationHistory');
    const stateStat = await fs.promises.stat(path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'sidecar-state.json',
    ));
    expect(sidecar['stateFileGeneration']).toEqual({
      size: stateStat.size, mtimeMs: stateStat.mtimeMs,
      ctimeMs: stateStat.ctimeMs, ino: stateStat.ino,
    });
  });

  it('recovers the newest valid first-write state staging file after a crash', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    const oldest = path.join(stateDir, 'first-write.json.101-2000-1.tmp');
    const newestValid = path.join(stateDir, 'first-write.json.101-2000-2.tmp');
    const newestInvalid = path.join(stateDir, 'first-write.json.101-2000-3.tmp');
    await fs.promises.writeFile(oldest, createEnvelope({
      ...makeState('first-write'), displayName: 'Old valid state',
    }));
    await fs.promises.writeFile(newestValid, createEnvelope({
      ...makeState('first-write'), displayName: 'Newest valid state',
    }));
    await fs.promises.writeFile(newestInvalid, '{"encrypted":false,"data":"{incomplete"}');
    await fs.promises.utimes(oldest, new Date(1_000), new Date(1_000));
    await fs.promises.utimes(newestValid, new Date(2_000), new Date(2_000));
    await fs.promises.utimes(newestInvalid, new Date(3_000), new Date(3_000));

    const manager = createManager();
    await manager.readyPromise;

    const recovered = await manager.resumeSession('first-write');
    expect(recovered?.displayName).toBe('Newest valid state');
    expect((await fs.promises.readdir(stateDir)).sort()).toEqual(['first-write.json']);
  });

  it('recovers a complete first-write snapshot staging file after a crash', async () => {
    const snapshotDir = path.join(mockState.userDataDir, 'session-continuity', 'snapshots');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const snapshotState = makeState('snapshot-owner');
    const snapshot: SessionSnapshot = {
      id: 'snap-crash-recovery', instanceId: snapshotState.instanceId,
      timestamp: Date.now(), state: snapshotState, schemaVersion: 2,
      metadata: { messageCount: 1, tokensUsed: 123, duration: 1, trigger: 'manual' },
    };
    await fs.promises.writeFile(
      path.join(snapshotDir, 'snap-crash-recovery.json.101-2000-1.tmp'),
      createEnvelope(snapshot),
    );

    const manager = createManager();
    await manager.readyPromise;

    expect(manager.listSnapshots('snapshot-owner')).toEqual([
      expect.objectContaining({ id: 'snap-crash-recovery', instanceId: 'snapshot-owner' }),
    ]);
    expect(await fs.promises.readdir(snapshotDir)).toEqual(['snap-crash-recovery.json']);
  });

  it('cleans sidecar staging files and promotes only a generation-bound payload', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    const metadataDir = path.join(mockState.userDataDir, 'session-continuity', 'recovery-metadata');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.mkdir(metadataDir, { recursive: true });
    const stateFile = path.join(stateDir, 'sidecar-crash.json');
    await fs.promises.writeFile(stateFile, createEnvelope({
      ...makeState('sidecar-crash'), lastWriteTimestamp: 700,
    }));
    const stateStat = await fs.promises.stat(stateFile);
    const generation = {
      size: stateStat.size, mtimeMs: stateStat.mtimeMs,
      ctimeMs: stateStat.ctimeMs, ino: stateStat.ino,
    };
    const validStaging = path.join(metadataDir, 'sidecar-crash.json.101-2000-1.tmp');
    const invalidStaging = path.join(metadataDir, 'sidecar-crash.json.101-2000-2.tmp');
    const unboundStaging = path.join(metadataDir, 'unbound.json.101-2000-1.tmp');
    const metadata = {
      recoveryKey: 'instance:sidecar-crash', sourceInstanceId: 'sidecar-crash',
      provider: 'claude', lastActivityAt: 700, modifiedAt: stateStat.mtimeMs,
      messageCount: 1, hasUserPrompt: true, hasAssistantOutput: false,
      nativeResumeAvailable: false, stateFileGeneration: generation,
    };
    await fs.promises.writeFile(validStaging, createEnvelope(metadata));
    await fs.promises.writeFile(invalidStaging, createEnvelope({
      ...metadata, stateFileGeneration: { ...generation, ino: generation.ino + 1 },
    }));
    await fs.promises.writeFile(unboundStaging, createEnvelope({
      ...metadata, sourceInstanceId: 'unbound',
    }));
    await fs.promises.utimes(validStaging, new Date(1_000), new Date(1_000));
    await fs.promises.utimes(invalidStaging, new Date(2_000), new Date(2_000));

    const manager = createManager();
    await manager.readyPromise;

    expect(manager.isInitDegraded()).toBe(false);
    expect(manager.getSessionState('sidecar-crash')).not.toBeNull();
    expect(await fs.promises.readdir(metadataDir)).toEqual(['sidecar-crash.json']);
    await expect(readEnvelope<Record<string, unknown>>(path.join(
      metadataDir, 'sidecar-crash.json',
    ))).resolves.toMatchObject({
      sourceInstanceId: 'sidecar-crash', stateFileGeneration: generation,
    });
  });

  it('binds the synchronous shutdown sidecar to the state generation', async () => {
    const manager = createManager();
    await manager.readyPromise;
    await manager.importSession({ state: makeState('sync-sidecar') });
    await manager.updateState('sync-sidecar', { displayName: 'Updated fixture' });
    manager.shutdown();

    const stateFile = path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'sync-sidecar.json',
    );
    const raw = JSON.parse(await fs.promises.readFile(path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'sync-sidecar.json',
    ), 'utf8')) as { data: string };
    const sidecar = JSON.parse(raw.data) as Record<string, unknown>;
    const stateStat = await fs.promises.stat(stateFile);
    expect(sidecar['stateFileGeneration']).toEqual({
      size: stateStat.size, mtimeMs: stateStat.mtimeMs,
      ctimeMs: stateStat.ctimeMs, ino: stateStat.ino,
    });
  });

  it('atomically replaces a same-size synchronous state before binding its sidecar', async () => {
    const manager = createManager();
    await manager.readyPromise;
    const original = makeState('sync-generation');
    await manager.importSession({ state: original });
    const stateFile = path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'sync-generation.json',
    );
    const sidecarFile = path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'sync-generation.json',
    );
    const oldStateStat = await fs.promises.stat(stateFile);
    const oldSidecar = await fs.promises.readFile(sidecarFile, 'utf8');
    const replacementName = 'R'.repeat(original.displayName.length);
    await manager.updateState('sync-generation', { displayName: replacementName });

    manager.shutdown();
    const newStateStat = await fs.promises.stat(stateFile);
    await fs.promises.writeFile(sidecarFile, oldSidecar);
    const records = await manager.listContinuityRecoveryMetadata(0);

    expect(newStateStat.size).toBe(oldStateStat.size);
    expect(newStateStat.ino).not.toBe(oldStateStat.ino);
    expect(records).toEqual([expect.objectContaining({ displayName: replacementName })]);
  });

  it('keeps the synchronous state authoritative when an older queued save resumes after shutdown', async () => {
    const stateFile = path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'state-commit-race.json',
    );
    const metadataFile = path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'state-commit-race.json',
    );
    const opened = createDeferred();
    const resume = createDeferred();
    let interceptWrites = false;
    let intercepted = false;
    const manager = createManager({}, {
      writePayloadAtomic: async (filePath, serialized, canCommit) => {
        if (interceptWrites && !intercepted && filePath === stateFile) {
          intercepted = true;
          opened.resolve();
          await resume.promise;
        }
        return writeContinuityPayloadAsyncAtomic(filePath, serialized, canCommit);
      },
    });
    await manager.readyPromise;
    await manager.importSession({ state: makeState('state-commit-race') });
    _resetSessionPersistenceQueueForTesting();
    await manager.updateState('state-commit-race', { displayName: 'Async version' });

    interceptWrites = true;
    const queuedSave = manager.queueStateSaveAsync('state-commit-race');
    await opened.promise;
    await manager.updateState('state-commit-race', { displayName: 'Shutdown version' });
    manager.shutdown();
    resume.resolve();
    await queuedSave;

    const persistedState = await readEnvelope<SessionState>(stateFile);
    const sidecar = await readEnvelope<Record<string, unknown>>(metadataFile);
    const stateStat = await fs.promises.stat(stateFile);
    expect(persistedState.displayName).toBe('Shutdown version');
    expect(sidecar).toMatchObject({ displayName: 'Shutdown version' });
    expect(sidecar['stateFileGeneration']).toEqual({
      size: stateStat.size, mtimeMs: stateStat.mtimeMs,
      ctimeMs: stateStat.ctimeMs, ino: stateStat.ino,
    });
    const stateEntries = await fs.promises.readdir(path.dirname(stateFile));
    expect(stateEntries.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('keeps the synchronous sidecar coherent when an older sidecar commit resumes after shutdown', async () => {
    const stateFile = path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'sidecar-commit-race.json',
    );
    const metadataFile = path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'sidecar-commit-race.json',
    );
    const opened = createDeferred();
    const resume = createDeferred();
    let interceptWrites = false;
    let intercepted = false;
    const manager = createManager({}, {
      writePayloadAtomic: async (filePath, serialized, canCommit) => {
        if (interceptWrites && !intercepted && filePath === metadataFile) {
          intercepted = true;
          opened.resolve();
          await resume.promise;
        }
        return writeContinuityPayloadAsyncAtomic(filePath, serialized, canCommit);
      },
    });
    await manager.readyPromise;
    await manager.importSession({ state: makeState('sidecar-commit-race') });
    _resetSessionPersistenceQueueForTesting();
    await manager.updateState('sidecar-commit-race', { displayName: 'Async version' });

    interceptWrites = true;
    const queuedSave = manager.queueStateSaveAsync('sidecar-commit-race');
    await opened.promise;
    await manager.updateState('sidecar-commit-race', { displayName: 'Shutdown version' });
    manager.shutdown();
    resume.resolve();
    await queuedSave;

    const persistedState = await readEnvelope<SessionState>(stateFile);
    const sidecar = await readEnvelope<Record<string, unknown>>(metadataFile);
    const stateStat = await fs.promises.stat(stateFile);
    expect(persistedState.displayName).toBe('Shutdown version');
    expect(sidecar).toMatchObject({ displayName: 'Shutdown version' });
    expect(sidecar['stateFileGeneration']).toEqual({
      size: stateStat.size, mtimeMs: stateStat.mtimeMs,
      ctimeMs: stateStat.ctimeMs, ino: stateStat.ino,
    });
    const metadataEntries = await fs.promises.readdir(path.dirname(metadataFile));
    expect(metadataEntries.filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('does not commit a pre-shutdown queued save after it acquires the mutex later', async () => {
    const attempted = createDeferred();
    let observeAcquire = false;
    const manager = createManager({}, {
      acquireSaveLock: async (instanceId, source) => {
        if (observeAcquire && instanceId === 'mutex-wait-race' && source === 'auto-save') {
          attempted.resolve();
        }
        return getSessionMutex().acquire(instanceId, source);
      },
    });
    await manager.readyPromise;
    await manager.importSession({ state: makeState('mutex-wait-race') });
    _resetSessionPersistenceQueueForTesting();
    await manager.updateState('mutex-wait-race', { displayName: 'Shutdown version' });
    const stateFile = path.join(
      mockState.userDataDir, 'session-continuity', 'states', 'mutex-wait-race.json',
    );
    const metadataFile = path.join(
      mockState.userDataDir, 'session-continuity', 'recovery-metadata', 'mutex-wait-race.json',
    );
    const mutex = getSessionMutex();
    const release = await mutex.acquire('mutex-wait-race', 'test-holder');

    observeAcquire = true;
    const queuedSave = manager.queueStateSaveAsync('mutex-wait-race');
    await attempted.promise;
    manager.shutdown();
    const shutdownGeneration = await fs.promises.stat(stateFile);
    release();
    await queuedSave;

    const finalGeneration = await fs.promises.stat(stateFile);
    const sidecar = await readEnvelope<Record<string, unknown>>(metadataFile);
    expect(finalGeneration.ino).toBe(shutdownGeneration.ino);
    expect(sidecar['stateFileGeneration']).toEqual({
      size: shutdownGeneration.size, mtimeMs: shutdownGeneration.mtimeMs,
      ctimeMs: shutdownGeneration.ctimeMs, ino: shutdownGeneration.ino,
    });
  });

  it('rewrites the recovery sidecar when startup normalization rewrites state', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    const metadataDir = path.join(mockState.userDataDir, 'session-continuity', 'recovery-metadata');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.mkdir(metadataDir, { recursive: true });
    const duplicated = makeState('normalized-sidecar');
    duplicated.conversationHistory.push({
      ...duplicated.conversationHistory[0], content: 'replacement fixture', timestamp: 500,
    });
    const stateFile = path.join(stateDir, 'normalized-sidecar.json');
    await fs.promises.writeFile(stateFile, createEnvelope(duplicated));
    const oldStat = await fs.promises.stat(stateFile);
    await fs.promises.writeFile(path.join(metadataDir, 'normalized-sidecar.json'), createEnvelope({
      recoveryKey: 'instance:normalized-sidecar', sourceInstanceId: 'normalized-sidecar',
      provider: 'claude', lastActivityAt: 500, modifiedAt: oldStat.mtimeMs,
      messageCount: 2, hasUserPrompt: true, hasAssistantOutput: false,
      nativeResumeAvailable: false,
      stateFileGeneration: {
        size: oldStat.size, mtimeMs: oldStat.mtimeMs,
        ctimeMs: oldStat.ctimeMs, ino: oldStat.ino,
      },
    }));

    const manager = createManager();
    await manager.readyPromise;

    const rewrittenStat = await fs.promises.stat(stateFile);
    const raw = JSON.parse(await fs.promises.readFile(
      path.join(metadataDir, 'normalized-sidecar.json'), 'utf8',
    )) as { data: string };
    const sidecar = JSON.parse(raw.data) as Record<string, unknown>;
    expect(sidecar).toMatchObject({ messageCount: 1, lastActivityAt: 500 });
    expect(sidecar['stateFileGeneration']).toEqual({
      size: rewrittenStat.size, mtimeMs: rewrittenStat.mtimeMs,
      ctimeMs: rewrittenStat.ctimeMs, ino: rewrittenStat.ino,
    });
  });

  it('keeps normalized state available when only its startup sidecar write fails', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    const duplicated = makeState('normalization-sidecar-failure');
    duplicated.conversationHistory.push({
      ...duplicated.conversationHistory[0], content: 'replacement fixture', timestamp: 500,
    });
    await fs.promises.writeFile(
      path.join(stateDir, 'normalization-sidecar-failure.json'), createEnvelope(duplicated),
    );
    const manager = createManager({}, {
      writePayloadAtomic: async (filePath, serialized, canCommit) => {
        if (filePath.includes(`${path.sep}recovery-metadata${path.sep}`)) {
          throw Object.assign(new Error('fixture sidecar failure'), { code: 'EIO' });
        }
        return writeContinuityPayloadAsyncAtomic(filePath, serialized, canCommit);
      },
    });
    await manager.readyPromise;
    const records = await manager.listContinuityRecoveryMetadata(0);

    expect(manager.isInitDegraded()).toBe(false);
    expect(manager.getSessionState('normalization-sidecar-failure')).not.toBeNull();
    expect(records).toEqual([expect.objectContaining({
      sourceInstanceId: 'normalization-sidecar-failure', messageCount: 1,
    })]);
    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'Failed to update recovery metadata after state normalization',
      { failed: 1 },
    );
    expect(JSON.stringify(mockState.logger.warn.mock.calls)).not.toContain(
      'normalization-sidecar-failure',
    );
  });

  it('keeps normalized state available when binding its optional sidecar cannot stat state', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    const duplicated = makeState('normalization-sidecar-stat-failure');
    duplicated.conversationHistory.push({
      ...duplicated.conversationHistory[0], content: 'replacement fixture', timestamp: 500,
    });
    const stateFile = path.join(stateDir, 'normalization-sidecar-stat-failure.json');
    await fs.promises.writeFile(stateFile, createEnvelope(duplicated));
    let failed = false;
    const manager = createManager({}, {
      statStateFile: async (filePath) => {
        if (!failed && filePath === stateFile) {
          failed = true;
          throw Object.assign(new Error('sensitive stat fixture'), { code: 'EIO' });
        }
        return fs.promises.stat(filePath);
      },
    });

    await manager.readyPromise;
    const records = await manager.listContinuityRecoveryMetadata(0);

    expect(failed).toBe(true);
    expect(manager.isInitDegraded()).toBe(false);
    expect(manager.getSessionState('normalization-sidecar-stat-failure')).not.toBeNull();
    expect(records).toEqual([expect.objectContaining({
      sourceInstanceId: 'normalization-sidecar-stat-failure', messageCount: 1,
    })]);
    expect(mockState.logger.warn).toHaveBeenCalledWith(
      'Failed to update recovery metadata after state normalization',
      { failed: 1 },
    );
    const warningPayload = JSON.stringify(mockState.logger.warn.mock.calls);
    expect(warningPayload).not.toContain('normalization-sidecar-stat-failure');
    expect(warningPayload).not.toContain('sensitive stat fixture');
  });

  it('treats an errored instance as non-live for snapshot prioritization', async () => {
    const manager = createManager();
    await manager.readyPromise;
    await manager.importSession({ state: makeState('errored-instance') });
    manager.setInstanceManager({
      getAdapter: () => undefined,
      getInstance: () => ({ status: 'error' }),
    });

    const record = manager.buildRecoverableSessionList()
      .find((session) => session.instanceId === 'errored-instance');

    expect(record?.isLive).toBe(false);
  });

  afterEach(async () => {
    for (const manager of managers.splice(0, managers.length)) {
      manager.shutdown();
    }

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  });

  it('logs per-file load counts and skipped state files during startup', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(stateDir, 'good.json'),
      createEnvelope(makeState('good-session'))
    );
    await fs.promises.writeFile(path.join(stateDir, 'bad.json'), '{bad json');

    const manager = createManager();
    await manager.readyPromise;

    const sessions = await manager.getResumableSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.instanceId).toBe('good-session');

    expect(mockState.logger.warn.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'Skipped unloadable session state file',
          expect.objectContaining({
            file: 'bad.json',
            filePath: path.join(stateDir, 'bad.json'),
          }),
        ],
      ])
    );
    expect(mockState.logger.info.mock.calls).toEqual(
      expect.arrayContaining([
        [
          'Session states loaded',
          expect.objectContaining({ loaded: 1, failed: 1, total: 2 }),
        ],
      ])
    );
  });

  it('logs non-ENOENT read failures from readPayload', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const readFileSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    const result = await manager.readPayload('/tmp/blocked.json');

    expect(result).toBeNull();
    const errorCall = getLogCall(mockState.logger.error.mock.calls, 'Failed to read continuity file');
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        path: '/tmp/blocked.json',
        errorCode: 'EACCES',
      })
    );

    readFileSpy.mockRestore();
  });

  it('logs invalid outer JSON without leaking payload content', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const result = manager.deserializePayload('{"broken"', '/tmp/invalid.json');

    expect(result).toBeNull();
    const errorCall = getLogCall(mockState.logger.error.mock.calls, 'Session file contains invalid JSON');
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        filePath: '/tmp/invalid.json',
        rawLength: 9,
      })
    );
    expect(errorCall?.[2]).not.toHaveProperty('rawPreview');
  });

  it('logs decrypt failures with envelope metadata', async () => {
    const manager = createManager({
      encryptOnDisk: true,
    });
    await manager.readyPromise;
    mockState.safeStorage.decryptString.mockImplementationOnce(() => {
      throw new Error('decrypt failed');
    });

    const result = manager.deserializePayload(
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('ciphertext', 'utf8').toString('base64'),
      }),
      '/tmp/encrypted.json'
    );

    expect(result).toBeNull();
    const errorCall = getLogCall(
      mockState.logger.error.mock.calls,
      'Failed to decrypt/parse session payload'
    );
    expect(errorCall).toBeDefined();
    expect(errorCall?.[1]).toBeInstanceOf(Error);
    expect(errorCall?.[2]).toEqual(
      expect.objectContaining({
        filePath: '/tmp/encrypted.json',
        encrypted: true,
        dataType: 'string',
      })
    );
  });

  it('resumes a saved state by history thread id and native session id', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const state = makeState('instance-thread-aware');
    state.historyThreadId = 'thread-123';
    state.sessionId = 'native-session-123';

    await fs.promises.writeFile(
      path.join(stateDir, 'instance-thread-aware.json'),
      createEnvelope(state)
    );

    const manager = createManager();
    await manager.readyPromise;

    const byThread = await manager.resumeSession('thread-123');
    const byNativeSession = await manager.resumeSession('native-session-123');

    expect(byThread?.instanceId).toBe('instance-thread-aware');
    expect(byThread?.historyThreadId).toBe('thread-123');
    expect(byNativeSession?.instanceId).toBe('instance-thread-aware');
    expect(byNativeSession?.sessionId).toBe('native-session-123');
  });

  it('stores native session metadata on snapshots while keeping lookups thread-aware', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('instance-snapshot');
    state.historyThreadId = 'thread-snapshot';
    state.sessionId = 'native-session-snapshot';

    await manager.importSession({ state });
    const snapshot = await manager.createSnapshot('instance-snapshot', 'checkpoint');

    expect(snapshot).not.toBeNull();
    expect(snapshot?.instanceId).toBe('instance-snapshot');
    expect(snapshot?.historyThreadId).toBe('thread-snapshot');
    expect(snapshot?.sessionId).toBe('native-session-snapshot');

    const byInstance = manager.listSnapshots('instance-snapshot');
    const byThread = manager.listSnapshots('thread-snapshot');
    const byNativeSession = manager.listSnapshots('native-session-snapshot');

    expect(byInstance).toHaveLength(1);
    expect(byThread).toHaveLength(1);
    expect(byNativeSession).toHaveLength(1);
    expect(byThread[0]?.instanceId).toBe('instance-snapshot');
    expect(byNativeSession[0]?.sessionId).toBe('native-session-snapshot');
  });

  it('marks native resume failures on thread-aware session state and clears them on new native session ids', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('instance-failure');
    state.historyThreadId = 'thread-failure';
    state.sessionId = 'native-session-old';

    await manager.importSession({ state });
    await manager.markNativeResumeFailed('thread-failure', 4242);

    const failedState = await manager.resumeSession('thread-failure');
    expect(failedState?.nativeResumeFailedAt).toBe(4242);

    await manager.updateState('instance-failure', {
      sessionId: 'native-session-new',
    });

    const recoveredState = await manager.resumeSession('thread-failure');
    expect(recoveredState?.sessionId).toBe('native-session-new');
    expect(recoveredState?.nativeResumeFailedAt).toBeNull();
  });

  it('coalesces repeated conversation entry ids before keeping them in continuity state', async () => {
    const manager = createManager();
    await manager.readyPromise;

    const state = makeState('streaming-instance');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('streaming-instance', {
      id: 'assistant-stream-1',
      role: 'assistant',
      content: 'partial answer',
      timestamp: 1,
    });
    await manager.addConversationEntry('streaming-instance', {
      id: 'assistant-stream-1',
      role: 'assistant',
      content: 'final answer',
      timestamp: 2,
    });

    const exported = await manager.exportSession('streaming-instance');

    expect(exported?.state.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);
  });

  it('caps retained conversation entries at maxConversationEntries', async () => {
    // The old context-pressure policy trimmed history to 51 entries but only
    // once a session passed 80% context, so a session reporting no context
    // usage grew without bound. The cap is now unconditional.
    const manager = createManager({ maxConversationEntries: 5 });
    await manager.readyPromise;

    const state = makeState('capped-instance');
    state.conversationHistory = [];
    state.contextUsage = { used: 0, total: 0 };
    await manager.importSession({ state });

    for (let i = 0; i < 12; i++) {
      await manager.addConversationEntry('capped-instance', {
        id: `entry-${i}`,
        role: 'assistant',
        content: `message ${i}`,
        timestamp: i,
      });
    }

    const exported = await manager.exportSession('capped-instance');
    const history = exported?.state.conversationHistory ?? [];
    expect(history).toHaveLength(5);
    // Newest kept, oldest dropped, and no synthetic "[Compacted N earlier
    // messages]" summary entry is injected any more.
    expect(history.map((e) => e.id)).toEqual([
      'entry-7', 'entry-8', 'entry-9', 'entry-10', 'entry-11',
    ]);
    expect(history.some((e) => e.content.includes('Compacted'))).toBe(false);
  });

  it('does not emit a compaction display marker when trimming history', async () => {
    const manager = createManager({ maxConversationEntries: 2 });
    await manager.readyPromise;

    const emitted: string[] = [];
    (manager as unknown as { on(event: string, cb: () => void): void }).on(
      'session:compaction-display',
      () => emitted.push('display'),
    );
    (manager as unknown as { on(event: string, cb: () => void): void }).on(
      'session:compacting',
      () => emitted.push('compacting'),
    );

    const state = makeState('silent-trim');
    state.conversationHistory = [];
    state.contextUsage = { used: 190000, total: 200000 };
    await manager.importSession({ state });

    for (let i = 0; i < 8; i++) {
      await manager.addConversationEntry('silent-trim', {
        id: `entry-${i}`,
        role: 'assistant',
        content: `message ${i}`,
        timestamp: i,
      });
    }

    expect(emitted).toEqual([]);
  });

  it('normalizes legacy duplicated conversation entries when resuming from disk', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const state = makeState('legacy-duplicates');
    state.conversationHistory = [
      {
        id: 'assistant-stream-1',
        role: 'assistant',
        content: 'partial answer',
        timestamp: 1,
      },
      {
        id: 'assistant-stream-1',
        role: 'assistant',
        content: 'final answer',
        timestamp: 2,
      },
    ];

    const stateFile = path.join(stateDir, 'legacy-duplicates.json');
    await fs.promises.writeFile(stateFile, createEnvelope(state));

    const manager = createManager();
    await manager.readyPromise;

    const resumed = await manager.resumeSession('legacy-duplicates');

    expect(resumed?.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);

    const rewrittenEnvelope = JSON.parse(await fs.promises.readFile(stateFile, 'utf8')) as { data: string };
    const rewrittenState = JSON.parse(rewrittenEnvelope.data) as SessionState;
    expect(rewrittenState.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'assistant-stream-1',
        content: 'final answer',
        timestamp: 2,
      }),
    ]);
  });

  it('drops tool conversation entries entirely when redaction is enabled', async () => {
    // Redaction used to keep the entry with a '[REDACTED TOOL OUTPUT]' body.
    // Those placeholders carried no information and showed up as noise in
    // restored history, so redaction now omits the entry altogether. The old
    // marker survives only as LEGACY_REDACTED_TOOL_OUTPUT, for stripping
    // placeholders written by earlier versions.
    const manager = createManager({
      redactToolOutputs: true,
    });
    await manager.readyPromise;

    const state = makeState('tool-redaction');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('tool-redaction', {
      id: 'tool-result-1',
      role: 'tool',
      content: 'x'.repeat(50_000),
      timestamp: 1,
    });

    const exported = await manager.exportSession('tool-redaction');

    expect(exported?.state.conversationHistory).toEqual([]);
  });

  it('keeps tool conversation entries when redaction is disabled', async () => {
    // Guards the other half of the flag: dropping must be opt-in, not the
    // unconditional behaviour of the persistence path.
    const manager = createManager({
      redactToolOutputs: false,
    });
    await manager.readyPromise;

    const state = makeState('tool-kept');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('tool-kept', {
      id: 'tool-result-1',
      role: 'tool',
      content: 'tool output worth keeping',
      timestamp: 1,
    });

    const exported = await manager.exportSession('tool-kept');

    expect(exported?.state.conversationHistory).toEqual([
      expect.objectContaining({
        id: 'tool-result-1',
        content: 'tool output worth keeping',
      }),
    ]);
  });

  it('strips legacy redaction placeholders written by earlier versions', async () => {
    // State files on disk still contain these, whatever the current flag says,
    // so they must be removed on the way through rather than resurfacing.
    const manager = createManager({
      redactToolOutputs: false,
    });
    await manager.readyPromise;

    const state = makeState('legacy-placeholder');
    state.conversationHistory = [];
    await manager.importSession({ state });

    await manager.addConversationEntry('legacy-placeholder', {
      id: 'legacy-1',
      role: 'assistant',
      content: LEGACY_REDACTED_TOOL_OUTPUT,
      timestamp: 1,
    });
    await manager.addConversationEntry('legacy-placeholder', {
      id: 'real-1',
      role: 'assistant',
      content: 'a real message',
      timestamp: 2,
    });

    const exported = await manager.exportSession('legacy-placeholder');

    expect(exported?.state.conversationHistory).toEqual([
      expect.objectContaining({ id: 'real-1', content: 'a real message' }),
    ]);
  });

  it('loads only the newest configured state files at startup without deleting older resumable files', async () => {
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    for (const [index, instanceId] of ['old-session', 'middle-session', 'new-session'].entries()) {
      const stateFile = path.join(stateDir, `${instanceId}.json`);
      await fs.promises.writeFile(stateFile, createEnvelope(makeState(instanceId)));
      const mtime = new Date(1_000 + index * 1_000);
      await fs.promises.utimes(stateFile, mtime, mtime);
    }

    const manager = createManager({
      maxLoadedStateFiles: 2,
    });
    await manager.readyPromise;

    const startupSessions = await manager.getResumableSessions();
    expect(startupSessions.map((session) => session.instanceId).sort()).toEqual([
      'middle-session',
      'new-session',
    ]);

    const oldSession = await manager.resumeSession('old-session');
    expect(oldSession?.instanceId).toBe('old-session');
    await fs.promises.access(path.join(stateDir, 'old-session.json'));
  });

  it('quarantines state files whose envelope is structurally valid but whose contents cannot be decrypted', async () => {
    // This reproduces the post-reinstall / Keychain-rotation failure mode:
    // after a new install, `safeStorage.decryptString` throws on ciphertext
    // written by a previous install. The envelope ({encrypted, data}) still
    // parses as valid JSON, so `repairFile()` can't detect it as corrupt and
    // the file would otherwise stay in states/ and re-throw the same decrypt
    // error on every subsequent startup. readPayload must quarantine it so
    // future startups stay clean.
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    const quarantineDir = path.join(mockState.userDataDir, 'session-continuity', 'quarantine');
    await fs.promises.mkdir(stateDir, { recursive: true });

    // Well-formed envelope, but `data` is not real ciphertext. We'll make
    // decryptString throw for this file so deserializePayload returns null.
    const undecryptableFile = path.join(stateDir, 'undecryptable.json');
    await fs.promises.writeFile(
      undecryptableFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('not-real-ciphertext', 'utf8').toString('base64'),
      })
    );

    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockState.safeStorage.decryptString.mockImplementation(() => {
      throw new Error('Decryption failed (simulated post-reinstall key rotation).');
    });

    const manager = createManager({ encryptOnDisk: true });
    await manager.readyPromise;

    // Original file should have been moved into the quarantine directory,
    // and readPayload should have returned null (no resumable session loaded).
    const sessions = await manager.getResumableSessions();
    expect(sessions).toHaveLength(0);

    await expect(fs.promises.access(undecryptableFile)).rejects.toMatchObject({ code: 'ENOENT' });

    const quarantineEntries = await fs.promises.readdir(quarantineDir);
    const quarantinedMatch = quarantineEntries.find((f) =>
      f.startsWith('undecryptable.json.') && f.endsWith('.corrupt'),
    );
    expect(quarantinedMatch).toBeDefined();

    // The warn log should call this out specifically (post-reinstall hint),
    // not bundle it together with a generic "skipped unloadable" message.
    const quarantineLog = getLogCall(
      mockState.logger.warn.mock.calls,
      'Quarantined undecryptable session state file (likely post-reinstall safeStorage key change)',
    );
    expect(quarantineLog).toBeDefined();
    expect(quarantineLog?.[1]).toEqual(
      expect.objectContaining({
        original: undecryptableFile,
        dest: expect.stringContaining(path.join(quarantineDir, 'undecryptable.json.')),
      })
    );
  });

  it('leaves a good encrypted file untouched when its sibling is undecryptable', async () => {
    // Regression guard: the quarantine branch in readPayload must not
    // over-reach and touch files that load cleanly. Here both files use
    // the encrypted envelope; `good-enc.json` decrypts normally while
    // `bad-enc.json` throws inside decryptString.
    const stateDir = path.join(mockState.userDataDir, 'session-continuity', 'states');
    await fs.promises.mkdir(stateDir, { recursive: true });

    const goodState = makeState('good-session');
    const goodFile = path.join(stateDir, 'good-enc.json');
    const badFile = path.join(stateDir, 'bad-enc.json');

    // Both envelopes carry distinguishable "ciphertext" so the mock can
    // tell them apart by the bytes it receives.
    await fs.promises.writeFile(
      goodFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('good-cipher', 'utf8').toString('base64'),
      }),
    );
    await fs.promises.writeFile(
      badFile,
      JSON.stringify({
        encrypted: true,
        data: Buffer.from('bad-cipher', 'utf8').toString('base64'),
      }),
    );

    mockState.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    mockState.safeStorage.decryptString.mockImplementation((value: Buffer) => {
      const cipherText = value.toString('utf8');
      if (cipherText === 'good-cipher') return JSON.stringify(goodState);
      throw new Error(`Simulated decrypt failure for ${cipherText}.`);
    });

    const manager = createManager({ encryptOnDisk: true });
    await manager.readyPromise;

    const sessions = await manager.getResumableSessions();
    const ids = sessions.map((s) => s.instanceId).sort();
    expect(ids).toEqual(['good-session']);

    // decryptString should have been called for BOTH files (once each).
    const decryptCalls = mockState.safeStorage.decryptString.mock.calls.map(([buf]) =>
      (buf as Buffer).toString('utf8'),
    );
    expect(decryptCalls.sort()).toEqual(['bad-cipher', 'good-cipher']);

    // Good file still present, bad file quarantined.
    await fs.promises.access(goodFile);
    await expect(fs.promises.access(badFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  describe('writeThroughIdentity', () => {
    it('updates sessionId and persists immediately', async () => {
      const manager = createManager();
      await manager.readyPromise;

      await manager.importSession({ state: makeState('inst-write-through') });
      await manager.writeThroughIdentity('inst-write-through', { sessionId: 'new-session-123' });

      const exported = await manager.exportSession('inst-write-through');
      expect(exported?.state.sessionId).toBe('new-session-123');
    });

    it('updates nativeResumeFailedAt and persists immediately', async () => {
      const manager = createManager();
      await manager.readyPromise;

      await manager.importSession({ state: makeState('inst-wt-2') });
      await manager.writeThroughIdentity('inst-wt-2', { nativeResumeFailedAt: 9999 });

      const exported = await manager.exportSession('inst-wt-2');
      expect(exported?.state.nativeResumeFailedAt).toBe(9999);
    });

    it('clears nativeResumeFailedAt when passed null', async () => {
      const manager = createManager();
      await manager.readyPromise;

      const state = makeState('inst-wt-clear');
      await manager.importSession({ state });
      await manager.writeThroughIdentity('inst-wt-clear', { nativeResumeFailedAt: 1234 });
      await manager.writeThroughIdentity('inst-wt-clear', { nativeResumeFailedAt: null });

      const exported = await manager.exportSession('inst-wt-clear');
      expect(exported?.state.nativeResumeFailedAt).toBeNull();
    });

    it('is a no-op for an untracked instanceId', async () => {
      const manager = createManager();
      await manager.readyPromise;
      // Should not throw
      await expect(
        manager.writeThroughIdentity('not-tracked', { sessionId: 'x' }),
      ).resolves.toBeUndefined();
    });
  });

  // Regression: lock-holding lifecycle ops (respawn fresh-fallback, YOLO/model/
  // agent-mode toggle) call writeThroughIdentityLocked while already holding the
  // per-instance session lock. The non-reentrant SessionMutex means the public
  // writeThroughIdentity (which acquires inside saveStateAsync) self-deadlocks
  // there — it stalls for the full 120s acquire timeout, surfaces as "CLI not
  // ready for input", and kills the session. The *Locked variant must write
  // under the already-held lock without re-acquiring.
  describe('writeThroughIdentityLocked (re-entrant write under held lock)', () => {
    afterEach(() => {
      _resetSessionMutexForTesting();
    });

    it('persists without re-acquiring while the caller holds the session lock', async () => {
      const manager = createManager();
      await manager.readyPromise;
      await manager.importSession({ state: makeState('inst-locked') });

      const release = await getSessionMutex().acquire('inst-locked', 'test-holder');
      try {
        // If this re-acquired the lock it would block until the 120s timeout.
        // Race against a short deadline so a regression fails in ~1s, not 120s.
        const outcome = await Promise.race([
          manager.writeThroughIdentityLocked('inst-locked', { sessionId: 'locked-session' }).then(() => 'done'),
          new Promise<string>((resolve) => setTimeout(() => resolve('deadlocked'), 1000)),
        ]);
        expect(outcome).toBe('done');
      } finally {
        release();
      }

      const exported = await manager.exportSession('inst-locked');
      expect(exported?.state.sessionId).toBe('locked-session');
    });

    it('public writeThroughIdentity still serializes on the lock (does not bypass it)', async () => {
      const manager = createManager();
      await manager.readyPromise;
      await manager.importSession({ state: makeState('inst-pub') });

      const release = await getSessionMutex().acquire('inst-pub', 'test-holder');
      let settled = false;
      const pending = manager
        .writeThroughIdentity('inst-pub', { sessionId: 'pub-session' })
        .then(() => {
          settled = true;
        });

      // While another op holds the lock, the acquiring path must wait.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      release();
      await pending;
      expect(settled).toBe(true);

      const exported = await manager.exportSession('inst-pub');
      expect(exported?.state.sessionId).toBe('pub-session');
    });
  });
});
