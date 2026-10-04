import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ConversationEntry, SessionState } from '../session/session-continuity.types';
import type {
  ContinuityRecoveryMetadata,
  SessionRecoveryCandidateService,
} from '../session/session-recovery-candidate-service';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const NOW = Date.now();

function entry(id: string, role: ConversationEntry['role'], content: string, timestamp: number): ConversationEntry {
  return { id, role, content, timestamp };
}

function continuityState(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return {
    instanceId: id,
    sessionId: `session-${id}`,
    historyThreadId: `thread-${id}`,
    parentId: null,
    displayName: `Autosaved ${id}`,
    agentId: 'build',
    modelId: 'opus',
    provider: 'claude',
    workingDirectory: '/workspace/project',
    conversationHistory: [
      entry(`${id}-u1`, 'user', 'first prompt', NOW - 4_000),
      entry(`${id}-a1`, 'assistant', 'first answer', NOW - 3_000),
    ],
    contextUsage: { used: 0, total: 1 },
    pendingTasks: [],
    environmentVariables: {},
    activeFiles: [],
    skillsLoaded: [],
    hooksActive: [],
    ...overrides,
  };
}

function metadataFor(state: SessionState): ContinuityRecoveryMetadata {
  const lastActivityAt = Math.max(...state.conversationHistory.map((item) => item.timestamp));
  return {
    recoveryKey: `history:${state.provider}:${state.historyThreadId}`,
    sourceInstanceId: state.instanceId,
    historyThreadId: state.historyThreadId,
    sessionId: state.sessionId,
    ...(state.parentId !== undefined ? { parentId: state.parentId } : {}),
    provider: state.provider ?? 'claude',
    modelId: state.modelId,
    displayName: state.displayName,
    workingDirectory: state.workingDirectory,
    lastActivityAt,
    modifiedAt: lastActivityAt,
    messageCount: state.conversationHistory.length,
    hasUserPrompt: state.conversationHistory.some((item) => item.role === 'user'),
    hasAssistantOutput: state.conversationHistory.some((item) => item.role === 'assistant'),
    nativeResumeAvailable: Boolean(state.sessionId),
  };
}

function message(id: string, type: OutputMessage['type'], content: string, timestamp: number): OutputMessage {
  return { id, type, content, timestamp };
}

describe('archiveRecoverableSessionsToHistory', () => {
  let userDataDir = '';
  const startups: Promise<void>[] = [];

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-recoverable-'));
    vi.doMock('electron', () => ({
      app: { getPath: vi.fn(() => userDataDir) },
    }));
  });

  afterEach(async () => {
    await Promise.allSettled(startups.splice(0));
    vi.doUnmock('electron');
    vi.resetModules();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  async function setup(states: SessionState[]) {
    const { HistoryManager } = await import('./history-manager');
    const { SessionRecoveryCandidateService, initializeSessionRecoveryCandidateService } =
      await import('../session/session-recovery-candidate-service');
    const { archiveRecoverableSessionsToHistory } = await import('./archive-recoverable-sessions');
    const { clearToolOutcomes, recordToolOutcome } = await import('../learning/tool-outcome-store');
    const history = new HistoryManager();
    startups.push(history.startupTasks);
    await history.startupTasks;
    const byId = new Map(states.map((state) => [state.instanceId, state]));
    const deps = {
      getSnapshot: () => null,
      waitForContinuityReady: async () => undefined,
      listContinuityMetadata: async () => states.map(metadataFor),
      loadContinuityState: vi.fn(async (id: string) => byId.get(id) ?? null),
      waitForHistoryReady: () => history.startupTasks,
      getHistoryCoverage: (identities: Parameters<typeof history.getRecoveryCoverage>[0]) =>
        history.getRecoveryCoverage(identities),
      loadHistoryConversation: (entryId: string) => history.loadConversation(entryId),
      isSuppressedByHistory: (record: Parameters<typeof history.isRecoverySuppressed>[0]) =>
        history.isRecoverySuppressed(record),
      getLiveRecoveryKeys: () => new Set<string>(),
      now: () => Date.now(),
    };
    // Registered as the singleton so History's post-archive invalidation reaches it.
    const service: SessionRecoveryCandidateService = initializeSessionRecoveryCandidateService(deps);
    expect(service).toBeInstanceOf(SessionRecoveryCandidateService);
    const archiveInstance = vi.fn((instance: Instance) => history.archiveInstance(instance, 'completed'));
    const run = () => archiveRecoverableSessionsToHistory({
      candidates: service, archiveInstance, recordToolOutcome, clearToolOutcomes,
    });
    return { history, service, run, archiveInstance };
  }

  it('copies an unarchived top-level autosave into History and clears the candidate', async () => {
    const { history, service, run } = await setup([continuityState('crashed')]);
    expect(await service.listCandidates()).toHaveLength(1);

    const result = await run();

    expect(result).toEqual({ submitted: 1, skipped: 0, failed: [] });
    const [archived] = history.getEntries();
    expect(archived).toMatchObject({
      displayName: 'Autosaved crashed',
      historyThreadId: 'thread-crashed',
      sessionId: 'session-crashed',
      originalInstanceId: 'crashed',
      provider: 'claude',
      workingDirectory: '/workspace/project',
      messageCount: 2,
      firstUserMessage: 'first prompt',
      createdAt: NOW - 4_000,
    });
    const conversation = await history.loadConversation(archived!.id);
    expect(conversation?.messages.map((item) => [item.id, item.type])).toEqual([
      ['crashed-u1', 'user'],
      ['crashed-a1', 'assistant'],
    ]);
    expect(await service.listCandidates()).toEqual([]);
  });

  it('merges a newer autosave with the existing History entry instead of replacing it', async () => {
    // The session kept going after its History archive was written, then crashed.
    const later = Date.now() + 60_000;
    const state = continuityState('continued', {
      conversationHistory: [
        // Continuity keeps only a recent window; the opening exchange is History-only.
        entry('continued-u2', 'user', 'second prompt', later),
        entry('continued-a2', 'assistant', 'second answer', later + 1_000),
      ],
    });
    const { history, service, run } = await setup([state]);
    const { createInstance } = await import('../../shared/types/instance.types');
    const earlier = createInstance({
      displayName: 'Autosaved continued',
      workingDirectory: '/workspace/project',
      provider: 'claude',
      historyThreadId: 'thread-continued',
      sessionId: 'session-continued',
    });
    earlier.id = 'earlier-generation';
    earlier.status = 'idle';
    earlier.outputBuffer = [
      message('continued-u1', 'user', 'first prompt', NOW - 60_000),
      message('continued-a1', 'assistant', 'first answer', NOW - 59_000),
    ];
    await history.archiveInstance(earlier, 'completed');
    service.invalidate();
    expect((await service.listCandidates()).map((item) => item.reason)).toEqual(['newer-than-history']);

    await run();

    const entries = history.getEntries();
    expect(entries).toHaveLength(1);
    const conversation = await history.loadConversation(entries[0]!.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'continued-u1', 'continued-a1', 'continued-u2', 'continued-a2',
    ]);
    expect(await service.listCandidates()).toEqual([]);
  });

  it('folds in output the crashed runtime spilled to disk before its autosave window', async () => {
    const { history, run } = await setup([continuityState('spilled')]);
    const { getOutputStorageManager } = await import('../memory/output-storage');
    await getOutputStorageManager().storeMessages('spilled', [
      message('spilled-u0', 'user', 'opening prompt only on disk', NOW - 9_000),
      message('spilled-a0', 'assistant', 'opening answer only on disk', NOW - 8_000),
    ]);

    await run();

    const [archived] = history.getEntries();
    const conversation = await history.loadConversation(archived!.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'spilled-u0', 'spilled-a0', 'spilled-u1', 'spilled-a1',
    ]);
    expect(archived?.firstUserMessage).toBe('opening prompt only on disk');
  });

  it('keeps the archived tool outcomes of a thread it merges into', async () => {
    const later = Date.now() + 60_000;
    const state = continuityState('outcomes', {
      conversationHistory: [entry('outcomes-u2', 'user', 'second prompt', later)],
    });
    const { history, service, run } = await setup([state]);
    const { createInstance } = await import('../../shared/types/instance.types');
    const { recordToolOutcome } = await import('../learning/tool-outcome-store');
    const earlier = createInstance({
      workingDirectory: '/workspace/project',
      provider: 'claude',
      historyThreadId: 'thread-outcomes',
      sessionId: 'session-outcomes',
    });
    earlier.id = 'earlier-outcomes';
    earlier.status = 'idle';
    earlier.outputBuffer = [message('outcomes-u1', 'user', 'first prompt', NOW - 60_000)];
    recordToolOutcome('earlier-outcomes', {
      ...message('outcomes-o1', 'tool_outcome', 'exit 1', NOW - 59_000),
      metadata: { tool_use_id: 'toolu_1', is_error: true },
    });
    await history.archiveInstance(earlier, 'completed');
    service.invalidate();

    await run();

    const [archived] = history.getEntries();
    const conversation = await history.loadConversation(archived!.id);
    expect(conversation?.messages.map((item) => [item.id, item.type])).toEqual([
      ['outcomes-u1', 'user'],
      ['outcomes-o1', 'tool_outcome'],
      ['outcomes-u2', 'user'],
    ]);
  });

  it('leaves child and legacy autosaves for manual recovery', async () => {
    const legacy = continuityState('legacy');
    delete legacy.parentId;
    const { history, service, run, archiveInstance } = await setup([
      continuityState('child', { parentId: 'parent-instance' }),
      legacy,
    ]);

    const result = await run();

    expect(result).toEqual({ submitted: 0, skipped: 0, failed: [] });
    expect(archiveInstance).not.toHaveBeenCalled();
    expect(history.getEntries()).toEqual([]);
    expect((await service.listCandidates()).map((item) => item.sourceInstanceId)).toEqual(['legacy']);
  });

  it('does not resurrect a thread the user deleted from History', async () => {
    const { history, service, run, archiveInstance } = await setup([continuityState('deleted')]);
    await run();
    const [archived] = history.getEntries();
    await history.deleteEntry(archived!.id);
    service.invalidate();

    expect(await service.listCandidates()).toEqual([]);
    archiveInstance.mockClear();
    await run();
    expect(archiveInstance).not.toHaveBeenCalled();
    expect(history.getEntries()).toEqual([]);
  });

  it('does not refill History with autosaves from before a clear', async () => {
    const { history, service, run } = await setup([continuityState('cleared')]);
    await history.clearAll();
    service.invalidate();

    await run();

    expect(history.getEntries()).toEqual([]);
    expect(await service.listCandidates()).toEqual([]);
  });

  it('counts a candidate that fails validation and still archives the rest', async () => {
    const broken = continuityState('broken');
    broken.conversationHistory.push({
      ...entry('broken-x', 'assistant', 'unreadable', NOW - 2_000),
      role: 'robot' as ConversationEntry['role'],
    });
    const { history, run } = await setup([broken, continuityState('healthy')]);

    const result = await run();

    expect(result).toEqual({
      submitted: 1,
      skipped: 0,
      failed: [{ instanceId: 'broken', error: 'Recovery candidate validation failed' }],
    });
    expect(history.getEntries().map((item) => item.historyThreadId)).toEqual(['thread-healthy']);
  });
});
