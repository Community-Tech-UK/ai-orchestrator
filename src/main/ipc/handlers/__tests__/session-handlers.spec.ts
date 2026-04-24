/**
 * Tests for session/history IPC handlers.
 *
 * Strategy: mock `electron` to capture ipcMain.handle registrations, then
 * invoke the captured handlers directly to verify restore behavior without
 * launching an Electron process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';
import type { InstanceManager } from '../../../instance/instance-manager';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

interface MockOutputMessage {
  type?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
  clipboard: {
    writeText: vi.fn(),
  },
  shell: {
    showItemInFolder: vi.fn(),
  },
}));

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockLoadConversation = vi.fn();
const mockMarkNativeResumeFailed = vi.fn();

vi.mock('../../../history', () => ({
  getHistoryManager: () => ({
    getEntries: vi.fn().mockReturnValue([]),
    loadConversation: mockLoadConversation,
    markNativeResumeFailed: mockMarkNativeResumeFailed,
    deleteEntry: vi.fn(),
    archiveEntry: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock('../../../session/session-archive', () => ({
  getSessionArchiveManager: () => ({
    archiveSession: vi.fn(),
    listArchivedSessions: vi.fn().mockReturnValue([]),
    restoreSession: vi.fn(),
    deleteArchivedSession: vi.fn(),
    getArchivedSessionMeta: vi.fn(),
    updateTags: vi.fn(),
    getArchiveStats: vi.fn(),
    cleanupOldArchives: vi.fn(),
  }),
}));

vi.mock('../../../session/session-share-service', () => ({
  getSessionShareService: () => ({
    createBundle: vi.fn(),
    saveBundle: vi.fn(),
    loadBundle: vi.fn(),
    toExportedSession: vi.fn(),
  }),
}));

vi.mock('../../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({
    getResumableSessions: vi.fn().mockReturnValue([]),
    resumeSession: vi.fn(),
    listSnapshots: vi.fn().mockReturnValue([]),
    createSnapshot: vi.fn(),
    getStats: vi.fn(),
  }),
}));

const mockIsRemoteNodeReachable = vi.fn().mockReturnValue(true);
vi.mock('../remote-node-check', () => ({
  isRemoteNodeReachable: (...args: unknown[]) => mockIsRemoteNodeReachable(...args),
}));

import { registerSessionHandlers } from '../session-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

async function invoke(
  channel: string,
  payload?: unknown
): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for channel: ${channel}`);
  }

  return handler({}, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

function makeMockInstanceManager(): InstanceManager {
  return {
    createInstance: vi.fn(),
    getInstance: vi.fn(),
    terminateInstance: vi.fn(),
    queueContinuityPreamble: vi.fn(),
  } as unknown as InstanceManager;
}

describe('session-handlers', () => {
  let mockInstanceManager: InstanceManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mockMarkNativeResumeFailed.mockReset();
    mockIsRemoteNodeReachable.mockReset();

    mockInstanceManager = makeMockInstanceManager();

    registerSessionHandlers({
      instanceManager: mockInstanceManager,
      serializeInstance: vi.fn((instance: unknown) => instance as Record<string, unknown>),
    });
  });

  describe('HISTORY_RESTORE', () => {
    it('treats a live resumed instance without context usage as unconfirmed resume', async () => {
      vi.useFakeTimers();
      try {
        const resumeInstance = {
          id: 'resume-1',
          outputBuffer: [{ type: 'assistant', content: 'Restored response' }],
          readyPromise: Promise.resolve(),
        };

        mockLoadConversation.mockResolvedValue({
          entry: {
            id: 'entry-1',
            displayName: 'Claude thread',
            createdAt: Date.now() - 10_000,
            endedAt: Date.now(),
            workingDirectory: '/tmp/project',
            messageCount: 1,
            firstUserMessage: 'Hello',
            lastUserMessage: 'Continue',
            status: 'completed',
            originalInstanceId: 'instance-1',
            parentId: null,
            sessionId: 'resume-session-1',
          },
          messages: [],
        });

        vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
          resumeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
        );

        vi.mocked(mockInstanceManager.getInstance).mockReturnValue({
          id: 'resume-1',
          status: 'busy',
          outputBuffer: resumeInstance.outputBuffer,
          contextUsage: { used: 0, total: 200_000, percentage: 0 },
        } as unknown as ReturnType<typeof mockInstanceManager.getInstance>);

        const resultPromise = invoke(IPC_CHANNELS.HISTORY_RESTORE, {
          entryId: 'entry-1',
        });

        await vi.advanceTimersByTimeAsync(5_000);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({
          instanceId: 'resume-1',
          restoreMode: 'resume-unconfirmed',
          restoredMessages: resumeInstance.outputBuffer,
        });
        expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
        expect(mockInstanceManager.terminateInstance).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the inferred provider when a legacy thread falls back to a fresh instance', async () => {
      mockLoadConversation.mockResolvedValue({
        entry: {
          id: 'entry-1',
          displayName: 'Legacy thread',
          createdAt: Date.now() - 10_000,
          endedAt: Date.now(),
          workingDirectory: '/tmp/project',
          messageCount: 1,
          firstUserMessage: 'Hey Gemini!',
          lastUserMessage: 'What model are you?',
          status: 'completed',
          originalInstanceId: 'instance-1',
          parentId: null,
          sessionId: 'legacy-session-1',
        },
        messages: [
          {
            id: 'u1',
            type: 'user',
            content: 'Hey Gemini, continue from where we left off.',
            timestamp: Date.now() - 3_000,
          },
          {
            id: 'a1',
            type: 'assistant',
            content: 'I was comparing native MCP passthrough with orchestrator-owned tool routing.',
            timestamp: Date.now() - 2_500,
          },
        ],
      });

      const resumeInstance = {
        id: 'resume-1',
        outputBuffer: [],
      };
      const fallbackInstance: { id: string; outputBuffer: MockOutputMessage[] } = {
        id: 'fallback-1',
        outputBuffer: [],
      };

      vi.mocked(mockInstanceManager.createInstance)
        .mockResolvedValueOnce(
          resumeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
        )
        .mockResolvedValueOnce(
          fallbackInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
        );

      vi.mocked(mockInstanceManager.getInstance).mockReturnValue({
        id: 'resume-1',
        status: 'error',
        outputBuffer: [],
      } as unknown as ReturnType<typeof mockInstanceManager.getInstance>);

      vi.mocked(mockInstanceManager.terminateInstance).mockResolvedValue(undefined);

      const result = await invoke(IPC_CHANNELS.HISTORY_RESTORE, {
        entryId: 'entry-1',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        instanceId: 'fallback-1',
        restoreMode: 'replay-fallback',
      });

      expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0]).toMatchObject({
        provider: 'gemini',
        resume: true,
      });
      expect(vi.mocked(mockInstanceManager.createInstance).mock.calls[1][0]).toMatchObject({
        provider: 'gemini',
      });
      expect(mockMarkNativeResumeFailed).toHaveBeenCalledWith('entry-1');
      expect(mockInstanceManager.queueContinuityPreamble).toHaveBeenCalledTimes(1);
      const lastMessage = fallbackInstance.outputBuffer.at(-1);
      expect(lastMessage).toBeDefined();
      if (!lastMessage) {
        throw new Error('Expected restore fallback system message');
      }
      expect(lastMessage).toMatchObject({
        type: 'system',
        content: expect.stringContaining('Previous Gemini CLI session could not be restored natively.'),
      });
      // Verify typed metadata for restore fallback system message (Phase 1)
      const metadata = lastMessage.metadata as Record<string, unknown>;
      expect(metadata).toBeDefined();
      expect(metadata['isRestoreNotice']).toBe(true);
      expect(metadata['systemMessageKind']).toBe('restore-fallback');
      expect(metadata['provider']).toBe('gemini');
      expect(metadata['originalSessionId']).toBe('legacy-session-1');
      expect(metadata['continuityInjectionQueued']).toBe(true);
      expect(typeof metadata['restoredMessageCount']).toBe('number');
    });

    it('skips native resume when the archived session handle is already marked failed', async () => {
      const fallbackInstance: { id: string; outputBuffer: MockOutputMessage[] } = {
        id: 'fallback-2',
        outputBuffer: [],
      };

      mockLoadConversation.mockResolvedValue({
        entry: {
          id: 'entry-2',
          displayName: 'Claude thread',
          createdAt: Date.now() - 10_000,
          endedAt: Date.now(),
          workingDirectory: '/tmp/project',
          messageCount: 2,
          firstUserMessage: 'Continue fixing restore',
          lastUserMessage: 'Can you restore this session?',
          status: 'completed',
          originalInstanceId: 'instance-2',
          parentId: null,
          sessionId: 'resume-session-2',
          nativeResumeFailedAt: Date.now() - 1_000,
        },
        messages: [
          { id: 'u1', type: 'user', content: 'Continue fixing restore', timestamp: Date.now() - 2_000 },
          { id: 'a1', type: 'assistant', content: 'I was working on the session fallback path.', timestamp: Date.now() - 1_500 },
        ],
      });

      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fallbackInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.HISTORY_RESTORE, {
        entryId: 'entry-2',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        instanceId: 'fallback-2',
        restoreMode: 'replay-fallback',
      });
      expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0]).not.toMatchObject({
        resume: true,
      });
      expect(mockMarkNativeResumeFailed).not.toHaveBeenCalled();
      expect(mockInstanceManager.queueContinuityPreamble).toHaveBeenCalledTimes(1);
    });

    it('passes forceNodeId when restoring a remote session with a connected node', async () => {
      vi.useFakeTimers();
      try {
        const resumeInstance = {
          id: 'remote-resume-1',
          outputBuffer: [{ type: 'assistant', content: 'Remote response' }],
          readyPromise: Promise.resolve(),
        };

        mockLoadConversation.mockResolvedValue({
          entry: {
            id: 'entry-remote-1',
            displayName: 'Remote Claude thread',
            createdAt: Date.now() - 10_000,
            endedAt: Date.now(),
            workingDirectory: '/remote/project',
            messageCount: 1,
            firstUserMessage: 'Hello from remote',
            lastUserMessage: 'Continue',
            status: 'completed',
            originalInstanceId: 'instance-remote-1',
            parentId: null,
            sessionId: 'remote-session-1',
            executionLocation: { type: 'remote', nodeId: 'node-abc' },
          },
          messages: [],
        });

        // Remote node is connected
        mockIsRemoteNodeReachable.mockReturnValue(true);

        vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
          resumeInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
        );

        vi.mocked(mockInstanceManager.getInstance).mockReturnValue({
          id: 'remote-resume-1',
          status: 'busy',
          outputBuffer: resumeInstance.outputBuffer,
          contextUsage: { used: 0, total: 200_000, percentage: 0 },
        } as unknown as ReturnType<typeof mockInstanceManager.getInstance>);

        const resultPromise = invoke(IPC_CHANNELS.HISTORY_RESTORE, {
          entryId: 'entry-remote-1',
        });

        // Remote sessions use a 15s timeout (vs 5s for local)
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await resultPromise;

        expect(result.success).toBe(true);
        expect(result.data).toMatchObject({
          instanceId: 'remote-resume-1',
          restoreMode: 'resume-unconfirmed',
        });

        // Verify forceNodeId was passed to createInstance
        const createCall = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
        expect(createCall).toMatchObject({
          resume: true,
          forceNodeId: 'node-abc',
          sessionId: 'remote-session-1',
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('skips native resume and falls back when remote node is disconnected', async () => {
      const fallbackInstance: { id: string; outputBuffer: MockOutputMessage[] } = {
        id: 'fallback-remote-1',
        outputBuffer: [],
      };

      mockLoadConversation.mockResolvedValue({
        entry: {
          id: 'entry-remote-2',
          displayName: 'Remote session (node gone)',
          createdAt: Date.now() - 10_000,
          endedAt: Date.now(),
          workingDirectory: '/remote/project',
          messageCount: 2,
          firstUserMessage: 'Hello from remote',
          lastUserMessage: 'Continue',
          status: 'completed',
          originalInstanceId: 'instance-remote-2',
          parentId: null,
          sessionId: 'remote-session-2',
          executionLocation: { type: 'remote', nodeId: 'node-xyz' },
        },
        messages: [
          { id: 'u1', type: 'user', content: 'Hello from remote', timestamp: Date.now() - 2_000 },
          { id: 'a1', type: 'assistant', content: 'Working on it remotely.', timestamp: Date.now() - 1_500 },
        ],
      });

      // Remote node is NOT connected
      mockIsRemoteNodeReachable.mockReturnValue(false);

      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fallbackInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.HISTORY_RESTORE, {
        entryId: 'entry-remote-2',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        instanceId: 'fallback-remote-1',
        restoreMode: 'replay-fallback',
      });

      // Should only create one instance (fallback), not attempt native resume
      expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
      expect(createCall).not.toMatchObject({ resume: true });
      // forceNodeId should NOT be passed when the remote node is disconnected —
      // otherwise resolveExecutionLocation falls through to local with the remote
      // working directory (which doesn't exist on the local machine).
      expect(createCall.forceNodeId).toBeUndefined();
      // Working directory should fall back to something local, not the remote path
      expect(createCall.workingDirectory).not.toBe('/remote/project');

      // Should NOT mark native resume as failed (it wasn't attempted; the node is just offline)
      expect(mockMarkNativeResumeFailed).not.toHaveBeenCalled();
    });

    it('serializes concurrent history restores so only one heavy spawn path runs at a time', async () => {
      // Regression guard for the restore thundering-herd fix: when the user
      // rapid-fires several history-restore clicks, the main process must not
      // run the `createInstance + readyPromise + CLI spawn + context poll`
      // pipeline in parallel — doing so starves the main event loop and can
      // delay an individual spawn by 3+ minutes.
      //
      // We prove the mutex works by gating the first call's `loadConversation`
      // on a promise we control. If the handler body were NOT wrapped in the
      // `withHistoryRestoreLock` chain, the second invoke would also call
      // `loadConversation` immediately and advance independently.
      let releaseFirst!: (value: null) => void;
      const firstGate = new Promise<null>((resolve) => {
        releaseFirst = resolve;
      });

      mockLoadConversation.mockImplementationOnce(() => firstGate);
      // Any later calls (from the second invoke, or any chained after) simply
      // resolve to null — the handler short-circuits to HISTORY_NOT_FOUND.
      mockLoadConversation.mockResolvedValue(null);

      const first = invoke(IPC_CHANNELS.HISTORY_RESTORE, { entryId: 'entry-first' });
      const second = invoke(IPC_CHANNELS.HISTORY_RESTORE, { entryId: 'entry-second' });

      // Let microtasks flush so both invocations have had a chance to start.
      // After this point: restore #1 is blocked on firstGate (inside the lock),
      // restore #2 is queued on the chain and MUST NOT have called
      // `loadConversation` yet.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(mockLoadConversation).toHaveBeenCalledTimes(1);
      expect(mockLoadConversation).toHaveBeenCalledWith('entry-first');

      // Release the first call — now #1 completes, lock releases, #2 runs.
      releaseFirst(null);

      const [firstResult, secondResult] = await Promise.all([first, second]);

      // Both restores short-circuited to HISTORY_NOT_FOUND (because
      // loadConversation returned null in both cases after the gate opened).
      expect(firstResult).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'HISTORY_NOT_FOUND' }),
      });
      expect(secondResult).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'HISTORY_NOT_FOUND' }),
      });

      expect(mockLoadConversation).toHaveBeenCalledTimes(2);
      // Ordering is preserved: #1 first, #2 second.
      expect(mockLoadConversation.mock.calls[0][0]).toBe('entry-first');
      expect(mockLoadConversation.mock.calls[1][0]).toBe('entry-second');
    });

    it('keeps the restore queue alive after a thrown restore so later restores still run', async () => {
      // Regression guard: the mutex chain must swallow rejections so a single
      // failed restore doesn't poison the chain and block every subsequent
      // restore forever. `historyRestoreChain = current.catch(() => undefined)`
      // in withHistoryRestoreLock is the specific line under test.
      let failFirst!: (reason: Error) => void;
      const firstFailure = new Promise<never>((_resolve, reject) => {
        failFirst = reject;
      });

      mockLoadConversation.mockImplementationOnce(() => firstFailure);
      mockLoadConversation.mockResolvedValue(null);

      const first = invoke(IPC_CHANNELS.HISTORY_RESTORE, { entryId: 'entry-a' });
      const second = invoke(IPC_CHANNELS.HISTORY_RESTORE, { entryId: 'entry-b' });

      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      // Second call blocked behind the lock — loadConversation not yet called.
      expect(mockLoadConversation).toHaveBeenCalledTimes(1);

      failFirst(new Error('simulated loadConversation failure'));

      const [firstResult, secondResult] = await Promise.all([first, second]);

      // The handler itself catches the loadConversation rejection and turns it
      // into a HISTORY_RESTORE_FAILED response, so the invoke resolves.
      expect(firstResult).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'HISTORY_RESTORE_FAILED' }),
      });
      // Crucially, the second restore is not blocked forever — the chain
      // recovered and ran the second handler.
      expect(secondResult).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'HISTORY_NOT_FOUND' }),
      });
      expect(mockLoadConversation).toHaveBeenCalledTimes(2);
    });
  });
});
