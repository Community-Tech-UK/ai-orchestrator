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
const mockLoggerWarn = vi.hoisted(() => vi.fn());

interface MockOutputMessage {
  id?: string;
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
    warn: mockLoggerWarn,
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockLoadConversation = vi.fn();
const mockMarkNativeResumeFailed = vi.fn();
const mockDeleteEntry = vi.fn();
const mockArchiveEntry = vi.fn();
const mockGetEntries = vi.fn().mockReturnValue([]);
const mockBackfillMissingAiTitles = vi.fn();
const mockGenerateLocalTitle = vi.fn();
const mockListArchivedSessions = vi.fn().mockReturnValue([]);
const mockRestoreArchivedSession = vi.fn();
const mockDeleteArchivedSession = vi.fn();
const mockGetArchiveStats = vi.fn();
const mockGetResumableSessions = vi.fn().mockResolvedValue([]);
const mockResumeSession = vi.fn();
const mockListSnapshots = vi.fn().mockReturnValue([]);
const mockCreateSnapshot = vi.fn();
const mockGetSessionStats = vi.fn();
const mockListRecoveryCandidates = vi.fn().mockResolvedValue([]);
const mockResolveRecoveryCandidate = vi.fn();
let mockRecoveryCandidateService: {
  listCandidates: typeof mockListRecoveryCandidates;
  resolveCandidate: typeof mockResolveRecoveryCandidate;
} | null = {
  listCandidates: mockListRecoveryCandidates,
  resolveCandidate: mockResolveRecoveryCandidate,
};

vi.mock('../../../history', () => ({
  getHistoryManager: () => ({
    getEntries: mockGetEntries,
    loadConversation: mockLoadConversation,
    markNativeResumeFailed: mockMarkNativeResumeFailed,
    deleteEntry: mockDeleteEntry,
    archiveEntry: mockArchiveEntry,
    clearAll: vi.fn(),
    backfillMissingAiTitles: mockBackfillMissingAiTitles,
  }),
}));

vi.mock('../../../instance/auto-title-service', () => ({
  getAutoTitleService: () => ({
    generateLocalTitle: mockGenerateLocalTitle,
  }),
}));

vi.mock('../../../session/session-archive', () => ({
  getSessionArchiveManager: () => ({
    archiveSession: vi.fn(),
    listArchivedSessions: mockListArchivedSessions,
    restoreSession: mockRestoreArchivedSession,
    deleteArchivedSession: mockDeleteArchivedSession,
    getArchivedSessionMeta: vi.fn(),
    updateTags: vi.fn(),
    getArchiveStats: mockGetArchiveStats,
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
    getResumableSessions: mockGetResumableSessions,
    resumeSession: mockResumeSession,
    listSnapshots: mockListSnapshots,
    createSnapshot: mockCreateSnapshot,
    getStats: mockGetSessionStats,
  }),
}));

vi.mock('../../../session/session-recovery-candidate-service', () => ({
  getSessionRecoveryCandidateServiceIfInitialized: () => mockRecoveryCandidateService,
}));

const mockIsRemoteNodeReachable = vi.fn().mockReturnValue(true);
vi.mock('../remote-node-check', () => ({
  isRemoteNodeReachable: (...args: unknown[]) => mockIsRemoteNodeReachable(...args),
}));

const mockListAdmissions = vi.fn().mockReturnValue([]);
vi.mock('../../../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    listAdmissions: mockListAdmissions,
  }),
}));

import { registerSessionHandlers } from '../session-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';
import { OrchestratorPausedError } from '../../../pause/orchestrator-paused-error';

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
    recoverFromContinuity: vi.fn(),
  } as unknown as InstanceManager;
}

const recoveryCandidate = {
  recoveryKey: 'history:claude:thread-1',
  sourceInstanceId: 'source-1',
  historyThreadId: 'thread-1',
  provider: 'claude',
  modelId: 'opus',
  displayName: 'Recovered fixture',
  workingDirectory: '/repo',
  lastActivityAt: 1_775_024_000_000,
  historyCoveredThrough: 1_775_023_000_000,
  recoveredMessageCount: 3,
  reason: 'newer-than-history',
  nativeResumeAvailable: true,
};

const resolvedRecoveryCandidate = {
  candidate: recoveryCandidate,
  continuityState: {
    instanceId: 'source-1',
    displayName: 'Recovered fixture',
    agentId: 'general',
    modelId: 'opus',
    provider: 'claude',
    workingDirectory: '/repo',
    conversationHistory: [],
    contextUsage: { used: 0, total: 1 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
  },
  historyConversation: null,
};

function recoveryCandidateAt(index: number): typeof recoveryCandidate {
  const suffix = String(index).padStart(3, '0');
  return {
    ...recoveryCandidate,
    recoveryKey: `history:claude:thread-${suffix}`,
    sourceInstanceId: `source-${suffix}`,
    historyThreadId: `thread-${suffix}`,
    displayName: `Recovered fixture ${suffix}`,
    lastActivityAt: recoveryCandidate.lastActivityAt - index,
    historyCoveredThrough: recoveryCandidate.historyCoveredThrough - index,
  };
}

function shutdownLivePreservedCandidates(): typeof recoveryCandidate[] {
  return [
    ...Array.from({ length: 50 }, (_, index) => recoveryCandidateAt(index)),
    {
      ...recoveryCandidateAt(50),
      recoveryKey: 'history:claude:thread-shutdown-live',
      sourceInstanceId: 'shutdown-live',
      historyThreadId: 'thread-shutdown-live',
      displayName: 'Preserved shutdown-live fixture',
    },
  ];
}

function recoveryChannel(name: 'SESSION_RECOVERY_LIST' | 'SESSION_RECOVERY_RESTORE'): string {
  return (IPC_CHANNELS as unknown as Record<string, string>)[name];
}

describe('session-handlers', () => {
  let mockInstanceManager: InstanceManager;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mockMarkNativeResumeFailed.mockReset();
    mockDeleteEntry.mockReset();
    mockArchiveEntry.mockReset();
    mockGetEntries.mockReset();
    mockGetEntries.mockReturnValue([]);
    mockListArchivedSessions.mockReset();
    mockListArchivedSessions.mockReturnValue([]);
    mockRestoreArchivedSession.mockReset();
    mockDeleteArchivedSession.mockReset();
    mockGetArchiveStats.mockReset();
    mockBackfillMissingAiTitles.mockReset();
    mockGenerateLocalTitle.mockReset();
    mockIsRemoteNodeReachable.mockReset();
    mockGetResumableSessions.mockReset();
    mockGetResumableSessions.mockResolvedValue([]);
    mockResumeSession.mockReset();
    mockListSnapshots.mockReset();
    mockListSnapshots.mockReturnValue([]);
    mockCreateSnapshot.mockReset();
    mockGetSessionStats.mockReset();
    mockListRecoveryCandidates.mockReset();
    mockListRecoveryCandidates.mockResolvedValue([]);
    mockResolveRecoveryCandidate.mockReset();
    mockLoggerWarn.mockReset();
    mockRecoveryCandidateService = {
      listCandidates: mockListRecoveryCandidates,
      resolveCandidate: mockResolveRecoveryCandidate,
    };
    mockListAdmissions.mockReset();
    mockListAdmissions.mockReturnValue([]);

    mockInstanceManager = makeMockInstanceManager();

    registerSessionHandlers({
      instanceManager: mockInstanceManager,
      serializeInstance: vi.fn((instance: unknown) => instance as Record<string, unknown>),
    });
  });

  describe('history maintenance', () => {
    it('starts bounded local-only title backfill while listing history', async () => {
      const originalVitest = process.env['VITEST'];
      process.env['VITEST'] = 'false';
      try {
        const entries = [
          {
            id: 'entry-needs-title',
            displayName: 'Please implement this',
            createdAt: Date.now() - 10_000,
            endedAt: Date.now(),
            workingDirectory: '/tmp/project',
            messageCount: 1,
            firstUserMessage: 'Please implement this thoroughly',
            lastUserMessage: 'Please implement this thoroughly',
            status: 'completed',
            originalInstanceId: 'instance-1',
            parentId: null,
            sessionId: 'session-1',
          },
        ];
        mockGetEntries.mockReturnValue(entries);

        const result = await invoke(IPC_CHANNELS.HISTORY_LIST, {});

        expect(result.success).toBe(true);
        expect(result.data).toBe(entries);
        expect(mockBackfillMissingAiTitles).toHaveBeenCalledWith(entries, expect.any(Function));

        mockGenerateLocalTitle.mockResolvedValue('Session title repair');
        const generate = mockBackfillMissingAiTitles.mock.calls[0]?.[1] as
          | ((text: string) => Promise<string | null>)
          | undefined;
        await expect(generate?.(entries[0].firstUserMessage)).resolves.toBe('Session title repair');
        expect(mockGenerateLocalTitle).toHaveBeenCalledWith(entries[0].firstUserMessage);
      } finally {
        process.env['VITEST'] = originalVitest;
      }
    });

    it('registers archive and delete handlers', async () => {
      mockArchiveEntry.mockResolvedValue(true);
      mockDeleteEntry.mockResolvedValue(true);

      await expect(invoke(IPC_CHANNELS.HISTORY_ARCHIVE, { entryId: 'entry-1' }))
        .resolves.toMatchObject({ success: true });
      await expect(invoke(IPC_CHANNELS.HISTORY_DELETE, { entryId: 'entry-1' }))
        .resolves.toMatchObject({ success: true });

      expect(mockArchiveEntry).toHaveBeenCalledWith('entry-1');
      expect(mockDeleteEntry).toHaveBeenCalledWith('entry-1');
    });
  });

  describe('archive search', () => {
    it('handles ARCHIVE_SEARCH using the archive manager search filter', async () => {
      mockListArchivedSessions.mockReturnValue([{ sessionId: 'arch-1', displayName: 'Build failure' }]);

      const result = await invoke(IPC_CHANNELS.ARCHIVE_SEARCH, {
        query: 'build failure',
        options: { tags: ['ci'], limit: 1 },
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ sessionId: 'arch-1', displayName: 'Build failure' }]);
      expect(mockListArchivedSessions).toHaveBeenCalledWith({
        searchTerm: 'build failure',
        tags: ['ci'],
      });
    });

    it('accepts archive IDs and wrapped filters emitted by renderer services', async () => {
      mockRestoreArchivedSession.mockReturnValue({ sessionId: 'arch-1' });
      mockListArchivedSessions.mockReturnValue([{ sessionId: 'arch-1' }]);

      await expect(invoke(IPC_CHANNELS.ARCHIVE_RESTORE, { archiveId: 'arch-1' }))
        .resolves.toMatchObject({ success: true });
      await expect(invoke(IPC_CHANNELS.ARCHIVE_LIST, {
        filter: {
          tags: ['ci'],
          startDate: 100,
          endDate: 200,
          search: 'failure',
        },
      })).resolves.toMatchObject({ success: true });

      expect(mockRestoreArchivedSession).toHaveBeenCalledWith('arch-1');
      expect(mockListArchivedSessions).toHaveBeenCalledWith({
        afterDate: 100,
        beforeDate: 200,
        tags: ['ci'],
        searchTerm: 'failure',
      });
    });

    it('rejects malformed archive search options before listing archives', async () => {
      const result = await invoke(IPC_CHANNELS.ARCHIVE_SEARCH, {
        query: 'failure',
        options: { limit: 0 },
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'ARCHIVE_SEARCH_FAILED' }),
      });
      expect(mockListArchivedSessions).not.toHaveBeenCalled();
    });
  });

  it('rejects an untrusted sender before legacy session handlers read state', async () => {
    const trustError: IpcResponse = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerSessionHandlers({
      instanceManager: mockInstanceManager,
      serializeInstance: vi.fn((instance: unknown) => instance as Record<string, unknown>),
      ensureTrustedSender,
    });

    await expect(invoke(IPC_CHANNELS.HISTORY_LIST)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.HISTORY_LIST);
    expect(mockGetEntries).not.toHaveBeenCalled();
  });

  describe('session:admissions-list', () => {
    it('returns admissions filtered by instanceId and states', async () => {
      const rows = [{ admissionId: 'a1', instanceId: 'instance-1', state: 'suppressed' }];
      mockListAdmissions.mockReturnValue(rows);

      const result = await invoke(IPC_CHANNELS.SESSION_ADMISSIONS_LIST, {
        instanceId: 'instance-1',
        states: ['suppressed'],
      });

      expect(result).toEqual({ success: true, data: rows });
      expect(mockListAdmissions).toHaveBeenCalledWith({
        instanceId: 'instance-1',
        states: ['suppressed'],
      });
    });

    it('accepts an empty payload', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_ADMISSIONS_LIST);
      expect(result).toEqual({ success: true, data: [] });
    });

    it('rejects an invalid payload before calling the admission service', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_ADMISSIONS_LIST, { states: ['not-a-real-state'] });
      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(mockListAdmissions).not.toHaveBeenCalled();
    });

    it('returns a structured error when the admission service throws', async () => {
      mockListAdmissions.mockImplementation(() => {
        throw new Error('db unavailable');
      });
      const result = await invoke(IPC_CHANNELS.SESSION_ADMISSIONS_LIST);
      expect(result).toMatchObject({
        success: false,
        error: { code: 'SESSION_ADMISSIONS_LIST_FAILED', message: 'db unavailable', timestamp: expect.any(Number) },
      });
    });
  });

  describe('session continuity', () => {
    it('wraps resumable sessions in a structured IPC response', async () => {
      const sessions = [{ instanceId: 'instance-1' }];
      mockGetResumableSessions.mockResolvedValue(sessions);

      await expect(invoke(IPC_CHANNELS.SESSION_LIST_RESUMABLE)).resolves.toEqual({
        success: true,
        data: sessions,
      });
    });

    it('rejects an invalid resume payload before calling the continuity manager', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_RESUME, { options: {} });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(mockResumeSession).not.toHaveBeenCalled();
    });

    it('validates and wraps a session resume result', async () => {
      const resumed = { instanceId: 'instance-1', status: 'ready' };
      mockResumeSession.mockResolvedValue(resumed);

      const result = await invoke(IPC_CHANNELS.SESSION_RESUME, {
        instanceId: 'instance-1',
        options: { fromSnapshot: 'snapshot-1', restoreMessages: false },
      });

      expect(result).toEqual({ success: true, data: resumed });
      expect(mockResumeSession).toHaveBeenCalledWith('instance-1', {
        fromSnapshot: 'snapshot-1',
        restoreMessages: false,
      });
    });

    it('rejects an invalid snapshot payload before creating a snapshot', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_CREATE_SNAPSHOT, {
        instanceId: '',
        name: 'checkpoint',
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(mockCreateSnapshot).not.toHaveBeenCalled();
    });

    it('returns structured errors when a continuity operation fails', async () => {
      mockListSnapshots.mockImplementation(() => {
        throw new Error('snapshot index unavailable');
      });

      const result = await invoke(IPC_CHANNELS.SESSION_LIST_SNAPSHOTS, {
        instanceId: 'instance-1',
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_LIST_SNAPSHOTS_FAILED',
          message: 'snapshot index unavailable',
          timestamp: expect.any(Number),
        },
      });
    });

    it('rejects an untrusted sender before invoking session continuity', async () => {
      const trustError: IpcResponse = {
        success: false,
        error: {
          code: 'IPC_TRUST_FAILED',
          message: 'Untrusted sender',
          timestamp: 123,
        },
      };
      const ensureTrustedSender = vi.fn(() => trustError);
      registerSessionHandlers({
        instanceManager: mockInstanceManager,
        serializeInstance: vi.fn((instance: unknown) => instance as Record<string, unknown>),
        ensureTrustedSender,
      });

      const result = await invoke(IPC_CHANNELS.SESSION_RESUME, {
        instanceId: 'instance-1',
      });

      expect(result).toEqual(trustError);
      expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.SESSION_RESUME);
      expect(mockResumeSession).not.toHaveBeenCalled();
    });
  });

  describe('session recovery IPC', () => {
    it('wraps an empty recovery candidate list without starting recovery work', async () => {
      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'));

      expect(result).toEqual({ success: true, data: [] });
      expect(mockListRecoveryCandidates).toHaveBeenCalledOnce();
      expect(mockResolveRecoveryCandidate).not.toHaveBeenCalled();
      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(mockGetResumableSessions).not.toHaveBeenCalled();
      expect(mockInstanceManager.recoverFromContinuity).not.toHaveBeenCalled();
    });

    it('returns only public recovery candidate fields from discovery', async () => {
      mockListRecoveryCandidates.mockResolvedValue([{
        ...recoveryCandidate,
        resumeCursor: 'cursor-secret',
        transcript: [{ content: 'private transcript text' }],
      }]);

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'));

      expect(result).toEqual({
        success: true,
        data: [recoveryCandidate],
      });
      expect(JSON.stringify(result)).not.toContain('cursor-secret');
      expect(JSON.stringify(result)).not.toContain('private transcript text');
    });

    it('isolates and reports an invalid public candidate while returning valid siblings', async () => {
      mockListRecoveryCandidates.mockResolvedValue([
        {
          ...recoveryCandidate,
          recoveryKey: 'history:claude:private-invalid-key',
          sourceInstanceId: '',
        },
        recoveryCandidate,
      ]);

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'));

      expect(result).toEqual({ success: true, data: [recoveryCandidate] });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Skipped invalid session recovery candidates',
        { skipped: 1 },
      );
      expect(JSON.stringify(result)).not.toContain('private-invalid-key');
      expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('private-invalid-key');
    });

    it('passes through preserved shutdown-live overflow lists without truncating or leaking private fields', async () => {
      const candidates = shutdownLivePreservedCandidates();
      mockListRecoveryCandidates.mockResolvedValue(candidates.map((candidate, index) => index === 50
        ? { ...candidate, resumeCursor: { threadId: 'redacted-cursor-placeholder' } }
        : candidate));

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'));

      expect(result).toEqual({
        success: true,
        data: candidates,
      });
      const data = result.data as unknown as typeof candidates;
      expect(data).toHaveLength(51);
      expect(data.at(-1)?.sourceInstanceId).toBe('shutdown-live');
      expect(JSON.stringify(result)).not.toContain('redacted-cursor-placeholder');
      expect(mockResolveRecoveryCandidate).not.toHaveBeenCalled();
      expect(mockInstanceManager.recoverFromContinuity).not.toHaveBeenCalled();
    });

    it('rejects malformed recovery list payloads before discovery', async () => {
      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'), {
        recoveryKey: 'history:claude:thread-1',
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(mockListRecoveryCandidates).not.toHaveBeenCalled();
    });

    it('rejects malformed recovery restore payloads before resolving candidates', async () => {
      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: '',
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(mockResolveRecoveryCandidate).not.toHaveBeenCalled();
      expect(mockInstanceManager.recoverFromContinuity).not.toHaveBeenCalled();
    });

    it('maps an unknown or stale recovery key to a redacted typed error', async () => {
      mockResolveRecoveryCandidate.mockRejectedValue(
        new Error('Recovery candidate is unavailable for history:claude:secret-thread'),
      );

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: 'history:claude:secret-thread',
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_RECOVERY_NOT_FOUND',
          message: 'Recovery candidate is no longer available',
          timestamp: expect.any(Number),
        },
      });
      expect(JSON.stringify(result)).not.toContain('secret-thread');
      expect(mockInstanceManager.recoverFromContinuity).not.toHaveBeenCalled();
    });

    it('maps candidate validation failure to a typed error without source details', async () => {
      mockResolveRecoveryCandidate.mockResolvedValue(resolvedRecoveryCandidate);
      vi.mocked(mockInstanceManager.recoverFromContinuity).mockRejectedValue(
        new Error('Recovery candidate validation failed: source-1 transcript mismatch'),
      );

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: recoveryCandidate.recoveryKey,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_RECOVERY_VALIDATION_FAILED',
          message: 'Recovery candidate validation failed',
          timestamp: expect.any(Number),
        },
      });
      expect(JSON.stringify(result)).not.toContain('source-1');
      expect(JSON.stringify(result)).not.toContain('transcript mismatch');
    });

    it('maps provider unavailable failures to a typed redacted error', async () => {
      mockResolveRecoveryCandidate.mockResolvedValue(resolvedRecoveryCandidate);
      const providerError = Object.assign(
        new Error('Provider unavailable for cursor-secret and private transcript text'),
        { code: 'PROVIDER_UNAVAILABLE' },
      );
      vi.mocked(mockInstanceManager.recoverFromContinuity).mockRejectedValue(providerError);

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: recoveryCandidate.recoveryKey,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_RECOVERY_PROVIDER_UNAVAILABLE',
          message: 'Recovery provider is unavailable',
          timestamp: expect.any(Number),
        },
      });
      expect(JSON.stringify(result)).not.toContain('cursor-secret');
      expect(JSON.stringify(result)).not.toContain('private transcript text');
    });

    it('preserves orchestrator pause failures as typed redacted recovery errors', async () => {
      mockResolveRecoveryCandidate.mockResolvedValue(resolvedRecoveryCandidate);
      vi.mocked(mockInstanceManager.recoverFromContinuity).mockRejectedValue(
        new OrchestratorPausedError(
          'Paused while contacting api.provider.example with cursor-secret',
          { hostname: 'api.provider.example' },
        ),
      );

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: recoveryCandidate.recoveryKey,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'ORCHESTRATOR_PAUSED',
          message: 'Session recovery refused while orchestrator is paused',
          timestamp: expect.any(Number),
        },
      });
      expect(JSON.stringify(result)).not.toContain('api.provider.example');
      expect(JSON.stringify(result)).not.toContain('cursor-secret');
    });

    it('maps replacement start failures to a typed redacted error', async () => {
      mockResolveRecoveryCandidate.mockResolvedValue(resolvedRecoveryCandidate);
      vi.mocked(mockInstanceManager.recoverFromContinuity).mockRejectedValue(
        new Error('Recovery replacement failed to start: spawn stderr cursor-secret'),
      );

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: recoveryCandidate.recoveryKey,
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_RECOVERY_START_FAILED',
          message: 'Recovery replacement failed to start',
          timestamp: expect.any(Number),
        },
      });
      expect(JSON.stringify(result)).not.toContain('cursor-secret');
      expect(JSON.stringify(result)).not.toContain('spawn stderr');
    });

    it('resolves a recovery candidate and returns only the public restore result', async () => {
      mockResolveRecoveryCandidate.mockResolvedValue(resolvedRecoveryCandidate);
      vi.mocked(mockInstanceManager.recoverFromContinuity).mockResolvedValue({
        instanceId: 'replacement-1',
        recoveredMessageCount: 3,
        usedNativeResume: false,
        resumeCursor: 'cursor-secret',
        transcript: [{ content: 'private transcript text' }],
      } as never);

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_RESTORE'), {
        recoveryKey: recoveryCandidate.recoveryKey,
      });

      expect(result).toEqual({
        success: true,
        data: {
          instanceId: 'replacement-1',
          recoveredMessageCount: 3,
          usedNativeResume: false,
        },
      });
      expect(mockResolveRecoveryCandidate).toHaveBeenCalledWith(recoveryCandidate.recoveryKey);
      expect(mockInstanceManager.recoverFromContinuity).toHaveBeenCalledWith(resolvedRecoveryCandidate);
      expect(mockResumeSession).not.toHaveBeenCalled();
      expect(mockGetResumableSessions).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain('cursor-secret');
      expect(JSON.stringify(result)).not.toContain('private transcript text');
    });

    it('reports recovery as unavailable when the startup service is not initialized', async () => {
      mockRecoveryCandidateService = null;

      const result = await invoke(recoveryChannel('SESSION_RECOVERY_LIST'));

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'SESSION_RECOVERY_UNAVAILABLE',
          message: 'Session recovery is not available yet',
          timestamp: expect.any(Number),
        },
      });
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
            historyThreadId: 'thread-resume-1',
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
          historyThreadId: 'thread-legacy-1',
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
          historyThreadId: 'thread-resume-2',
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

    it('does not revive a failed provider session by reusing the app-owned history identity', async () => {
      const failedSessionId = '66061320-7298-4d9b-9552-25f024f5e90d';
      const appHistoryThreadId = 'd813b60a-de12-4f83-9a09-8cc9d0714d12';
      const fallbackInstance: { id: string; outputBuffer: MockOutputMessage[] } = {
        id: 'fallback-repair',
        outputBuffer: [],
      };

      mockLoadConversation.mockResolvedValue({
        entry: {
          id: 'entry-repair',
          displayName: 'Claude thread',
          createdAt: Date.now() - 10_000,
          endedAt: Date.now(),
          workingDirectory: '/tmp/project',
          messageCount: 4,
          firstUserMessage: 'Continue fixing restore',
          lastUserMessage: 'Can you restore this session?',
          status: 'completed',
          originalInstanceId: 'instance-repair',
          parentId: null,
          sessionId: failedSessionId,
          historyThreadId: appHistoryThreadId,
          provider: 'claude',
          nativeResumeFailedAt: Date.now() - 1_000,
        },
        messages: [
          { id: 'u1', type: 'user', content: 'Continue fixing restore', timestamp: Date.now() - 4_000 },
          { id: 'a1', type: 'assistant', content: 'I was working on restore.', timestamp: Date.now() - 3_500 },
          {
            id: 'e1',
            type: 'error',
            content: `No conversation found with session ID: ${failedSessionId}`,
            timestamp: Date.now() - 3_000,
          },
          {
            id: 's1',
            type: 'system',
            content: 'Previous Claude CLI session could not be restored natively. Your conversation history is displayed above.',
            timestamp: Date.now() - 2_500,
            metadata: {
              isRestoreNotice: true,
              systemMessageKind: 'restore-fallback',
              originalSessionId: failedSessionId,
            },
          },
        ],
      });

      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fallbackInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.HISTORY_RESTORE, {
        entryId: 'entry-repair',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        instanceId: 'fallback-repair',
        restoreMode: 'replay-fallback',
      });
      // A row already marked nativeResumeFailedAt must never be handed back to the
      // provider — the app-owned historyThreadId is an internal identity, not a
      // provider-native resume handle, so restore falls straight to replay.
      expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
      expect(createCall).not.toMatchObject({ resume: true });
      expect(createCall.sessionId).not.toBe(appHistoryThreadId);
      expect(mockMarkNativeResumeFailed).not.toHaveBeenCalled();
    });

    it('removes archived restore errors and notices before replay fallback display', async () => {
      const fallbackInstance: { id: string; outputBuffer: MockOutputMessage[] } = {
        id: 'fallback-clean',
        outputBuffer: [],
      };

      mockLoadConversation.mockResolvedValue({
        entry: {
          id: 'entry-clean',
          displayName: 'Claude thread',
          createdAt: Date.now() - 10_000,
          endedAt: Date.now(),
          workingDirectory: '/tmp/project',
          messageCount: 4,
          firstUserMessage: 'Continue fixing restore',
          lastUserMessage: 'Can you restore this session?',
          status: 'completed',
          originalInstanceId: 'instance-clean',
          parentId: null,
          sessionId: 'fresh-unused-session',
          historyThreadId: 'thread-clean',
          nativeResumeFailedAt: Date.now() - 1_000,
        },
        messages: [
          { id: 'u1', type: 'user', content: 'Continue fixing restore', timestamp: Date.now() - 4_000 },
          { id: 'a1', type: 'assistant', content: 'I was working on restore.', timestamp: Date.now() - 3_500 },
          {
            id: 'e1',
            type: 'error',
            content: 'No conversation found with session ID: native-session',
            timestamp: Date.now() - 3_000,
          },
          {
            id: 's1',
            type: 'system',
            content: 'Previous Claude CLI session could not be restored natively. Your conversation history is displayed above.',
            timestamp: Date.now() - 2_500,
            metadata: {
              isRestoreNotice: true,
              systemMessageKind: 'restore-fallback',
              originalSessionId: 'native-session',
            },
          },
        ],
      });

      vi.mocked(mockInstanceManager.createInstance).mockResolvedValue(
        fallbackInstance as unknown as Awaited<ReturnType<typeof mockInstanceManager.createInstance>>
      );

      const result = await invoke(IPC_CHANNELS.HISTORY_RESTORE, {
        entryId: 'entry-clean',
      });

      expect(result.success).toBe(true);
      expect(mockInstanceManager.createInstance).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(mockInstanceManager.createInstance).mock.calls[0][0];
      expect(createCall.initialOutputBuffer).toEqual([
        expect.objectContaining({ id: 'u1' }),
        expect.objectContaining({ id: 'a1' }),
      ]);

      const restoredMessages = result.data?.['restoredMessages'] as MockOutputMessage[];
      expect(restoredMessages).toHaveLength(3);
      expect(restoredMessages.map((message) => message.id)).toEqual([
        'u1',
        'a1',
        expect.any(String),
      ]);
      expect(JSON.stringify(restoredMessages)).not.toContain('No conversation found');
      expect(
        restoredMessages.filter(
          (message) => message.metadata?.['systemMessageKind'] === 'restore-fallback'
        )
      ).toHaveLength(1);
      expect(fallbackInstance.outputBuffer.at(-1)?.metadata).toMatchObject({
        originalSessionId: 'native-session',
        restoredMessageCount: 2,
      });
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
            historyThreadId: 'thread-remote-1',
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
          historyThreadId: 'thread-remote-2',
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
