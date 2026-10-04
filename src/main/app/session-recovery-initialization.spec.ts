import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { RecoverableSessionSelectionInput } from '../session/recoverable-session-selection';
import type { SessionState } from '../session/session-continuity.types';
import type { ContinuityRecoveryMetadata } from '../session/session-recovery-candidate-service';

const NOW = Date.now();

const history = vi.hoisted(() => ({
  startupTasks: Promise.resolve(),
  getEntries: vi.fn(() => [] as { historyThreadId?: string }[]),
  isRecoverySuppressed: vi.fn((_query: { historyThreadId?: string }) => false),
  archiveInstance: vi.fn(async (_instance: Instance) => undefined),
  getRecoveryCoverage: vi.fn(async () => new Map()),
  loadConversation: vi.fn(async () => null),
}));
const snapshotSessions = vi.hoisted(() => ({ value: [] as RecoverableSessionSelectionInput[] }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/user-data' } }));
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => logger }));
vi.mock('../history/history-manager', () => ({ getHistoryManager: () => history }));
vi.mock('../session/last-stop-snapshot', () => ({
  initLastStopSnapshot: () => ({
    getSnapshot: () => ({ version: 2, writtenAt: NOW, sessions: snapshotSessions.value }),
  }),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    loadMessages: async () => [{ id: 'm', type: 'user', content: 'prompt', timestamp: NOW }],
  }),
}));

function lastStopSession(id: string): RecoverableSessionSelectionInput {
  return {
    instanceId: id,
    sessionId: `session-${id}`,
    historyThreadId: `thread-${id}`,
    provider: 'claude',
    displayName: `Session ${id}`,
    workingDirectory: '/workspace',
    capturedAt: NOW,
    recoveryKey: `history:claude:thread-${id}`,
    lastActivityAt: NOW - 1_000,
    isLive: true,
    messageCount: 1,
    hasAssistantOutput: false,
  };
}

function continuityWith(states: Record<string, Partial<SessionState> | Error>) {
  return {
    waitForRecoveryDiscoveryReady: vi.fn(async () => undefined),
    listContinuityRecoveryMetadata: vi.fn(async (): Promise<ContinuityRecoveryMetadata[]> => []),
    loadRecoveryState: vi.fn(async (id: string) => {
      const state = states[id];
      if (state instanceof Error) throw state;
      return (state ?? null) as SessionState | null;
    }),
  };
}

function instanceManager() {
  return Object.assign(new EventEmitter(), { getLiveRecoveryKeys: () => new Set<string>() });
}

describe('initializeSessionRecoveryRuntime', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    history.isRecoverySuppressed.mockImplementation(() => false);
    snapshotSessions.value = [];
    const service = await import('../session/session-recovery-candidate-service');
    service._resetSessionRecoveryCandidateServiceForTesting();
  });

  afterEach(async () => {
    const service = await import('../session/session-recovery-candidate-service');
    service._resetSessionRecoveryCandidateServiceForTesting();
  });

  async function initialize(continuity: ReturnType<typeof continuityWith>): Promise<void> {
    const { initializeSessionRecoveryRuntime } = await import('./session-recovery-initialization');
    await initializeSessionRecoveryRuntime(
      continuity as unknown as Parameters<typeof initializeSessionRecoveryRuntime>[0],
      instanceManager() as unknown as Parameters<typeof initializeSessionRecoveryRuntime>[1],
    );
  }

  it('ingests last-stop top-level sessions but not children or threads the user deleted', async () => {
    snapshotSessions.value = [
      lastStopSession('root'),
      lastStopSession('child'),
      lastStopSession('deleted'),
      lastStopSession('unreadable'),
    ];
    history.isRecoverySuppressed.mockImplementation((query) => query.historyThreadId === 'thread-deleted');

    await initialize(continuityWith({
      root: { parentId: null },
      child: { parentId: 'root' },
      unreadable: new Error('state could not be read'),
    }));

    const ingested = history.archiveInstance.mock.calls.map(([instance]) => instance.id).sort();
    expect(ingested).toEqual(['root', 'unreadable']);
  });

  function crashedState(): SessionState {
    return {
      instanceId: 'crashed',
      sessionId: 'session-crashed',
      historyThreadId: 'thread-crashed',
      parentId: null,
      displayName: 'Crashed session',
      agentId: 'build',
      modelId: 'opus',
      provider: 'claude',
      workingDirectory: '/workspace',
      conversationHistory: [
        { id: 'u1', role: 'user', content: 'prompt', timestamp: NOW - 2_000 },
        { id: 'a1', role: 'assistant', content: 'answer', timestamp: NOW - 1_000 },
      ],
      contextUsage: { used: 0, total: 1 },
      pendingTasks: [],
      environmentVariables: {},
      activeFiles: [],
      skillsLoaded: [],
      hooksActive: [],
    };
  }

  function crashedMetadata(): ContinuityRecoveryMetadata {
    return {
      recoveryKey: 'history:claude:thread-crashed',
      sourceInstanceId: 'crashed',
      historyThreadId: 'thread-crashed',
      sessionId: 'session-crashed',
      parentId: null,
      provider: 'claude',
      modelId: 'opus',
      displayName: 'Crashed session',
      workingDirectory: '/workspace',
      lastActivityAt: NOW - 1_000,
      modifiedAt: NOW - 1_000,
      messageCount: 2,
      hasUserPrompt: true,
      hasAssistantOutput: true,
      nativeResumeAvailable: true,
    };
  }

  it('copies a top-level autosave into History during startup', async () => {
    const { waitForSessionRecoveryStartupArchive } = await import('../session/session-recovery-candidate-service');
    const continuity = continuityWith({ crashed: crashedState() });
    continuity.listContinuityRecoveryMetadata.mockResolvedValue([crashedMetadata()]);

    await initialize(continuity);
    await waitForSessionRecoveryStartupArchive();

    expect(history.archiveInstance).toHaveBeenCalledOnce();
    const [archived] = history.archiveInstance.mock.calls[0]!;
    expect(archived).toMatchObject({ id: 'crashed', historyThreadId: 'thread-crashed', status: 'idle' });
    expect(archived.outputBuffer.map((item) => item.id)).toEqual(['u1', 'a1']);
  });

  it('logs why an autosave could not be archived', async () => {
    const { waitForSessionRecoveryStartupArchive } = await import('../session/session-recovery-candidate-service');
    const state = crashedState();
    state.conversationHistory.push({
      id: 'x1', role: 'robot' as SessionState['conversationHistory'][number]['role'],
      content: 'unreadable', timestamp: NOW - 500,
    });
    const continuity = continuityWith({ crashed: state });
    continuity.listContinuityRecoveryMetadata.mockResolvedValue([crashedMetadata()]);

    await initialize(continuity);
    await waitForSessionRecoveryStartupArchive();

    expect(history.archiveInstance).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('Autosaved session could not be archived to history', {
      instanceId: 'crashed',
      error: 'Recovery candidate validation failed',
    });
  });

  it('holds recovery listing behind the startup archive registered during initialization', async () => {
    const { waitForSessionRecoveryStartupArchive } = await import('../session/session-recovery-candidate-service');
    const { initializeSessionRecoveryRuntime } = await import('./session-recovery-initialization');
    let releaseHistory!: () => void;
    history.startupTasks = new Promise<void>((resolve) => { releaseHistory = resolve; });
    let listingReleased = false;

    // No await between starting initialization and asking for the gate.
    const initializing = initializeSessionRecoveryRuntime(
      continuityWith({}) as unknown as Parameters<typeof initializeSessionRecoveryRuntime>[0],
      instanceManager() as unknown as Parameters<typeof initializeSessionRecoveryRuntime>[1],
    );
    void waitForSessionRecoveryStartupArchive().then(() => { listingReleased = true; });
    await Promise.resolve();
    expect(listingReleased).toBe(false);

    releaseHistory();
    await initializing;
    await waitForSessionRecoveryStartupArchive();
    expect(listingReleased).toBe(true);
    history.startupTasks = Promise.resolve();
  });
});
