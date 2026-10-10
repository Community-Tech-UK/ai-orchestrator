import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function message(id: string, type: OutputMessage['type'], timestamp: number): OutputMessage {
  return { id, type, content: `${type} placeholder content`, timestamp };
}

function makeInstance(
  id: string,
  outputBuffer: OutputMessage[],
  overrides: Partial<Instance> = {},
): Instance {
  return {
    id,
    displayName: 'Coverage integrity fixture',
    createdAt: 100,
    historyThreadId: 'thread-coverage-integrity',
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    depth: 0,
    terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'hibernated',
    contextUsage: { used: 0, total: 200_000, percentage: 0 },
    lastActivity: 200,
    processId: null,
    providerSessionId: `provider-${id}`,
    sessionId: `provider-${id}`,
    restartEpoch: 0,
    workingDirectory: '/tmp/coverage-integrity',
    yoloMode: false,
    provider: 'claude',
    currentModel: 'opus',
    outputBuffer,
    outputBufferMaxSize: 1_000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    ...overrides,
  };
}

function indexedEntry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: 'entry-coverage-integrity',
    displayName: 'Indexed coverage fixture',
    createdAt: 50,
    endedAt: 900,
    historyThreadId: 'thread-coverage-integrity',
    workingDirectory: '/tmp/coverage-integrity',
    messageCount: 99,
    firstUserMessage: 'Indexed placeholder prompt',
    lastUserMessage: 'Indexed placeholder prompt',
    status: 'completed',
    originalInstanceId: 'prior-generation',
    parentId: null,
    sessionId: 'provider-prior-generation',
    provider: 'claude',
    currentModel: 'opus',
    ...overrides,
  };
}

describe('HistoryManager archive coverage integrity', () => {
  let userDataDir = '';
  let storageDir = '';
  const pendingStartups: Promise<void>[] = [];

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-coverage-integrity-'));
    storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    vi.doMock('electron', () => ({
      app: { getPath: () => userDataDir },
    }));
  });

  afterEach(async () => {
    await Promise.allSettled(pendingStartups.splice(0));
    vi.doUnmock('electron');
    vi.resetModules();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  });

  async function createManager(entry: ConversationHistoryEntry) {
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: 900, entries: [entry] }),
    );
    const { HistoryManager } = await import('./history-manager');
    const manager = new HistoryManager();
    pendingStartups.push(manager.startupTasks);
    await manager.startupTasks;
    return manager;
  }

  async function expectSourceArchive(manager: Awaited<ReturnType<typeof createManager>>, sourceId: string) {
    const sourceMessages = [
      message(`${sourceId}-user`, 'user', 100),
      message(`${sourceId}-assistant`, 'assistant', 200),
    ];
    await manager.archiveInstance(makeInstance(sourceId, sourceMessages));

    const entry = manager.getEntries()[0];
    expect(entry?.originalInstanceId).toBe(sourceId);
    expect(entry?.messageCount).toBe(2);
    const conversation = await manager.loadConversation(entry!.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual(
      sourceMessages.map((item) => item.id),
    );
  }

  it('archives when matching index metadata has no backing conversation', async () => {
    const manager = await createManager(indexedEntry());

    await expectSourceArchive(manager, 'source-missing-conversation');
  });

  it('archives when the matching conversation gzip is corrupt', async () => {
    const entry = indexedEntry();
    fs.writeFileSync(path.join(storageDir, `${entry.id}.json.gz`), 'corrupt gzip placeholder');
    const manager = await createManager(entry);

    await expectSourceArchive(manager, 'source-corrupt-conversation');
  });

  it('archives when index count overstates the successfully loaded transcript', async () => {
    const entry = indexedEntry();
    const persisted: ConversationData = {
      entry,
      messages: [message('persisted-user-only', 'user', 200)],
    };
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(persisted)),
    );
    const manager = await createManager(entry);

    await expectSourceArchive(manager, 'source-overstated-index');
  });

  it('archives when persisted conversation identity conflicts with the matching index thread', async () => {
    const entry = indexedEntry({
      endedAt: 200,
      messageCount: 2,
    });
    const persistedEntry = {
      ...entry,
      historyThreadId: 'thread-conflicting-persisted-identity',
    };
    const persisted: ConversationData = {
      entry: persistedEntry,
      messages: [
        message('conflicting-user', 'user', 100),
        message('conflicting-assistant', 'assistant', 200),
      ],
    };
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(persisted)),
    );
    const manager = await createManager(entry);

    await expectSourceArchive(manager, 'source-conflicting-persisted-identity');

    const archived = await manager.loadConversation(entry.id);
    expect(archived?.entry.historyThreadId).toBe('thread-coverage-integrity');
    expect(archived?.messages.map((item) => item.id)).toEqual([
      'source-conflicting-persisted-identity-user',
      'source-conflicting-persisted-identity-assistant',
    ]);
  });

  it('does not backfill an unrelated legacy-shaped conversation before archiving the indexed session', async () => {
    const indexedSessionId = 'provider-indexed-session-a';
    const persistedSessionId = 'provider-unrelated-session-b';
    const entry = indexedEntry({
      endedAt: 200,
      historyThreadId: indexedSessionId,
      messageCount: 2,
      sessionId: indexedSessionId,
    });
    const persisted: ConversationData = {
      entry: {
        ...entry,
        historyThreadId: persistedSessionId,
        sessionId: persistedSessionId,
      },
      messages: [
        message('unrelated-user', 'user', 100),
        message('unrelated-assistant', 'assistant', 200),
      ],
    };
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(persisted)),
    );
    const manager = await createManager(entry);
    const canonicalHistoryThreadId = manager.getEntries()[0]!.historyThreadId!;

    const loadedBeforeArchive = await manager.loadConversation(entry.id);
    const sourceId = 'source-indexed-session-a';
    const sourceMessages = [
      message(`${sourceId}-user`, 'user', 100),
      message(`${sourceId}-assistant`, 'assistant', 200),
    ];
    await manager.archiveInstance(makeInstance(sourceId, sourceMessages, {
      historyThreadId: canonicalHistoryThreadId,
      providerSessionId: indexedSessionId,
      sessionId: indexedSessionId,
    }));

    const archivedEntry = manager.getEntries()[0];
    const archived = await manager.loadConversation(archivedEntry!.id);
    expect(archivedEntry?.originalInstanceId).toBe(sourceId);
    expect(archived?.messages.map((item) => item.id)).toEqual(
      sourceMessages.map((item) => item.id),
    );
    expect(loadedBeforeArchive?.entry.historyThreadId).toBe(persistedSessionId);
    expect(loadedBeforeArchive?.entry.sessionId).toBe(persistedSessionId);
  });

  it('keeps the full archive when a trimmed revival of the same thread is re-archived', async () => {
    // 2026-10-08: a crash-recovery revival seeded with 1,000 of 19,398 messages
    // replaced the whole archive. Same ids prove the revival descends from it.
    const fullTranscript = [
      message('full-user', 'user', 100),
      message('full-early-assistant', 'assistant', 200),
      message('full-middle-tool', 'tool_use', 300),
      message('full-late-assistant', 'assistant', 400),
    ];
    const entry = indexedEntry({ endedAt: 400, messageCount: fullTranscript.length });
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry, messages: fullTranscript } satisfies ConversationData)),
    );
    const manager = await createManager(entry);

    const revivedBuffer = [fullTranscript[1], fullTranscript[2], message('revival-new-reply', 'assistant', 500)];
    await manager.archiveInstance(makeInstance('revived-trimmed', revivedBuffer, {
      status: 'idle',
      metadata: { continuityRevival: true },
    }));

    const archivedEntry = manager.getEntries()[0];
    expect(archivedEntry?.originalInstanceId).toBe('revived-trimmed');
    expect(archivedEntry?.messageCount).toBe(5);
    const archived = await manager.loadConversation(archivedEntry!.id);
    expect(archived?.messages.map((item) => item.id)).toEqual([
      'full-user',
      'full-early-assistant',
      'full-middle-tool',
      'full-late-assistant',
      'revival-new-reply',
    ]);
  });

  it('drops the discarded branch when an edit-and-resend fork re-archives the thread', async () => {
    const sourceTranscript = [
      message('source-user', 'user', 100),
      message('source-reply', 'assistant', 200),
      message('discarded-user', 'user', 300),
      message('discarded-reply', 'assistant', 400),
    ];
    const entry = indexedEntry({ endedAt: 400, messageCount: sourceTranscript.length });
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry, messages: sourceTranscript } satisfies ConversationData)),
    );
    const manager = await createManager(entry);

    // A fork keeps the source's prefix objects (same ids) and thread id.
    const forkBuffer = [sourceTranscript[0], sourceTranscript[1], message('edited-user', 'user', 500)];
    await manager.archiveInstance(makeInstance('edit-fork', forkBuffer, { status: 'idle' }));

    const archived = await manager.loadConversation(manager.getEntries()[0]!.id);
    expect(archived?.messages.map((item) => item.id)).toEqual(['source-user', 'source-reply', 'edited-user']);
  });
});
