import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ConversationData } from '../../shared/types/history.types';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => loggerMock,
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  const sessionId = overrides.sessionId ?? 'session-1';
  return {
    id: 'instance-1',
    displayName: 'Thread',
    createdAt: 100,
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
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: 200,
    processId: null,
    providerSessionId: sessionId,
    sessionId,
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    currentModel: 'opus',
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
    ...overrides,
  };
}

function message(
  id: string,
  type: OutputMessage['type'],
  content: string,
  timestamp: number,
  metadata?: Record<string, unknown>
): OutputMessage {
  return {
    id,
    type,
    content,
    timestamp,
    metadata,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function drainMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await Promise.resolve();
  }
}

describe('HistoryManager', () => {
  let userDataDir = '';

  const pendingStartups: Promise<void>[] = [];

  /**
   * `new HistoryManager()` starts `startupTasks` (backfill -> orphan recovery)
   * and returns before they finish. Deleting the temp dir underneath a still
   * running task makes it write into a removed directory: ENOENT on write,
   * ENOTEMPTY on rmSync, and a failure in whichever test the scheduler happened
   * to interleave with. Track every manager so teardown can wait for it.
   */
  function track<T extends { startupTasks: Promise<void> }>(manager: T): T {
    pendingStartups.push(manager.startupTasks);
    return manager;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-manager-'));
    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) => {
          if (name === 'userData') {
            return userDataDir;
          }

          throw new Error(`Unexpected path lookup: ${name}`);
        }),
      },
    }));
  });

  afterEach(async () => {
    await Promise.allSettled(pendingStartups.splice(0));
    vi.doUnmock('electron');
    vi.resetModules();
    if (userDataDir) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  it('creates a safety backup before clearing conversation history', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const entry = {
      id: 'entry-1',
      displayName: 'Example',
      createdAt: 1,
      endedAt: 2,
      workingDirectory: '/tmp/example',
      messageCount: 1,
      firstUserMessage: 'hello',
      lastUserMessage: 'hello',
      status: 'completed' as const,
      originalInstanceId: 'instance-1',
      sessionId: 'session-1',
    };

    const conversationData = {
      entry,
      messages: [
        {
          id: 'message-1',
          timestamp: 1,
          type: 'user',
          content: 'hello',
        },
      ],
    };

    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: Date.now(),
          entries: [entry],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(conversationData))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    await manager.clearAll();

    const backupDirs = fs
      .readdirSync(userDataDir)
      .filter(name => name.startsWith('conversation-history.bak-'));

    expect(backupDirs).toHaveLength(1);

    const backupDir = path.join(userDataDir, backupDirs[0]);
    expect(fs.existsSync(path.join(backupDir, 'index.json'))).toBe(true);
    expect(fs.existsSync(path.join(backupDir, `${entry.id}.json.gz`))).toBe(true);

    const activeIndex = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'index.json'), 'utf-8')
    ) as { entries: unknown[] };

    expect(activeIndex.entries).toEqual([]);
    expect(fs.existsSync(path.join(storageDir, `${entry.id}.json.gz`))).toBe(false);
  });

  it('LT-196: folds tool-outcome records into the archive so the miner can read them back', async () => {
    // This is the seam the whole feature rests on. The record is deliberately
    // kept out of `outputBuffer` (see `tool-outcome-store.ts`), so the ONLY
    // thing putting it in front of the correction miner is the merge in
    // `getCompleteArchiveMessages()`. Without this test, reordering that
    // concatenation or dropping the `getToolOutcomes()` call would silently
    // kill the feature with every other test still green.
    const { HistoryManager } = await import('./history-manager');
    const {
      recordToolOutcome,
      getToolOutcomes,
      _resetToolOutcomeStoreForTesting,
    } = await import('../learning/tool-outcome-store');
    _resetToolOutcomeStoreForTesting();
    const manager = track(new HistoryManager());

    // A genuine failure-then-correction shape: the tool_use messages live in
    // the buffer, their outcomes only in the side store.
    const buffer = [
      message('u1', 'user', 'fix the grep', 1),
      message('t1', 'tool_use', 'Bash', 2, { id: 'toolu_1', name: 'Bash', input: { command: 'grep --bogus-flag x' } }),
      message('t2', 'tool_use', 'Bash', 4, { id: 'toolu_2', name: 'Bash', input: { command: 'grep -F x' } }),
    ];
    recordToolOutcome('instance-lt196', message(
      'o1', 'tool_outcome', 'grep: unrecognized option --bogus-flag', 3,
      { tool_use_id: 'toolu_1', is_error: true, name: 'Bash' },
    ));
    recordToolOutcome('instance-lt196', message(
      'o2', 'tool_outcome', '', 5,
      { tool_use_id: 'toolu_2', is_error: false, name: 'Bash' },
    ));

    await manager.archiveInstance(makeInstance({
      id: 'instance-lt196',
      historyThreadId: 'thread-lt196',
      outputBuffer: buffer,
    }));

    const entry = manager.getEntries().find((item) => item.historyThreadId === 'thread-lt196');
    expect(entry).toBeDefined();
    const conversation = await manager.loadConversation(entry!.id);

    // Both records survived the round trip, in timestamp order with their pairs.
    const archived = conversation?.messages ?? [];
    expect(archived.map((m) => m.id)).toEqual(['u1', 't1', 'o1', 't2', 'o2']);
    const failure = archived.find((m) => m.id === 'o1');
    expect(failure?.type).toBe('tool_outcome');
    expect(failure?.metadata).toMatchObject({ tool_use_id: 'toolu_1', is_error: true });

    // And the miner can actually pair them from exactly this transcript.
    const { mineCorrections } = await import('../learning/correction-miner');
    const pairs = mineCorrections(archived.map((m) => ({
      type: m.type,
      content: m.content,
      timestamp: m.timestamp,
      metadata: m.metadata,
    })));
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs[0]).toMatchObject({
      failCommand: 'grep --bogus-flag x',
      fixCommand: 'grep -F x',
      fixIsError: false,
    });

    // Archiving clears the store — the records have served their purpose.
    expect(getToolOutcomes('instance-lt196')).toEqual([]);
  });

  it('archives disk-backed overflow before the retained output tail', async () => {
    const { getOutputStorageManager } = await import('../memory/output-storage');
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    const overflow = [
      message('prompt-1', 'user', 'Original prompt that must remain in history', 1),
      message('response-1', 'assistant', 'Initial response', 2),
    ];
    const retained = [
      message('prompt-2', 'user', 'Follow-up prompt', 3),
      message('response-2', 'assistant', 'Final response', 4),
    ];

    // Simulate a live bounded buffer: storeMessages is intentionally not
    // awaited by the overflow path, so archiveInstance must flush it itself.
    void getOutputStorageManager().storeMessages('instance-complete-history', overflow);

    await manager.archiveInstance(makeInstance({
      id: 'instance-complete-history',
      historyThreadId: 'thread-complete-history',
      outputBuffer: retained,
    }));

    const entry = manager.getEntries().find(
      (item) => item.historyThreadId === 'thread-complete-history',
    );
    expect(entry?.messageCount).toBe(4);
    expect(entry?.firstUserMessage).toBe('Original prompt that must remain in history');

    if (!entry) {
      throw new Error('Expected complete history entry to be archived');
    }
    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'prompt-1',
      'response-1',
      'prompt-2',
      'response-2',
    ]);
  });

  it('archives disk-only complete messages before applying positive coverage skip', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const previousEntry = {
      id: 'entry-storage-only',
      displayName: 'Previous empty tail',
      createdAt: 50,
      endedAt: 999,
      historyThreadId: 'thread-storage-only',
      workingDirectory: '/tmp/project',
      messageCount: 0,
      firstUserMessage: '',
      lastUserMessage: '',
      status: 'completed' as const,
      originalInstanceId: 'fork-storage-only',
      parentId: null,
      sessionId: 'session-storage-only',
      provider: 'claude' as const,
      currentModel: 'opus',
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [previousEntry] })
    );
    fs.writeFileSync(
      path.join(storageDir, `${previousEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry: previousEntry, messages: [] }))
    );

    const { getOutputStorageManager } = await import('../memory/output-storage');
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;
    void getOutputStorageManager().storeMessages('instance-storage-only', [
      message('stored-user', 'user', 'Stored prompt beyond the live tail', 100),
      message('stored-assistant', 'assistant', 'Stored response beyond the live tail', 200),
    ]);

    await manager.archiveInstance(makeInstance({
      id: 'instance-storage-only',
      historyThreadId: 'thread-storage-only',
      sessionId: 'source-session-storage-only',
      status: 'hibernated',
      outputBuffer: [],
    }), 'completed');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(previousEntry.id);
    expect(entries[0]?.messageCount).toBe(2);
    expect(entries[0]?.originalInstanceId).toBe('instance-storage-only');

    const conversation = await manager.loadConversation(previousEntry.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'stored-user',
      'stored-assistant',
    ]);
  });

  it('archives an older storage prefix when history covers only the non-empty live tail', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const previousEntry = {
      id: 'entry-covered-tail',
      displayName: 'Covered live tail',
      createdAt: 50,
      endedAt: 400,
      historyThreadId: 'thread-covered-tail',
      workingDirectory: '/tmp/project',
      messageCount: 2,
      firstUserMessage: 'Tail prompt',
      lastUserMessage: 'Tail prompt',
      status: 'completed' as const,
      originalInstanceId: 'fork-covered-tail',
      parentId: null,
      sessionId: 'session-covered-tail',
      provider: 'claude' as const,
      currentModel: 'opus',
    };
    const tail = [
      message('tail-user', 'user', 'Tail prompt', 300),
      message('tail-assistant', 'assistant', 'Tail response', 400),
    ];
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [previousEntry] }),
    );
    fs.writeFileSync(
      path.join(storageDir, `${previousEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry: previousEntry, messages: tail })),
    );

    const { getOutputStorageManager } = await import('../memory/output-storage');
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;
    void getOutputStorageManager().storeMessages('instance-covered-tail', [
      message('prefix-user', 'user', 'Older stored prompt', 100),
      message('prefix-assistant', 'assistant', 'Older stored response', 200),
    ]);

    await manager.archiveInstance(makeInstance({
      id: 'instance-covered-tail',
      historyThreadId: 'thread-covered-tail',
      sessionId: 'source-session-covered-tail',
      status: 'hibernated',
      outputBuffer: tail,
    }), 'completed');

    const entry = manager.getEntries()[0];
    expect(entry?.id).toBe(previousEntry.id);
    expect(entry?.messageCount).toBe(4);
    expect(entry?.originalInstanceId).toBe('instance-covered-tail');
    const conversation = await manager.loadConversation(previousEntry.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'prefix-user',
      'prefix-assistant',
      'tail-user',
      'tail-assistant',
    ]);
  });

  it('archives retained prompts that never reached disk storage', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    // enableDiskStorage off ⇒ the trim persisted nothing; the evicted prompt
    // survives only on the instance's retained set.
    const retainedPrompts = [message('prompt-1', 'user', 'The ask that outlived the buffer', 1)];
    const retained = [
      message('prompt-2', 'user', 'Follow-up prompt', 3),
      message('response-2', 'assistant', 'Final response', 4),
    ];

    await manager.archiveInstance(makeInstance({
      id: 'instance-retained-prompts',
      historyThreadId: 'thread-retained-prompts',
      outputBuffer: retained,
      retainedPrompts,
    }));

    const entry = manager.getEntries().find(
      (item) => item.historyThreadId === 'thread-retained-prompts',
    );
    expect(entry?.firstUserMessage).toBe('The ask that outlived the buffer');

    if (!entry) {
      throw new Error('Expected retained-prompt entry to be archived');
    }
    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'prompt-1',
      'prompt-2',
      'response-2',
    ]);
  });

  it('does not archive a retained prompt twice when its id was renumbered by a wake', async () => {
    const { getOutputStorageManager } = await import('../memory/output-storage');
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    // Disk keeps the original id; a hibernate/wake round trip renumbers the
    // persisted entry positionally, so `retainedPrompts` now holds the SAME
    // prompt under a derived id. Id-keyed dedup cannot see they are one prompt.
    void getOutputStorageManager().storeMessages('instance-renumbered', [
      message('prompt-1', 'user', 'Opening ask', 1),
    ]);

    await manager.archiveInstance(makeInstance({
      id: 'instance-renumbered',
      historyThreadId: 'thread-renumbered',
      outputBuffer: [message('response-2', 'assistant', 'Final response', 4)],
      retainedPrompts: [message('restored-prompt-msg-0', 'user', 'Opening ask', 1)],
    }));

    const entry = manager.getEntries().find(
      (item) => item.historyThreadId === 'thread-renumbered',
    );
    if (!entry) {
      throw new Error('Expected renumbered entry to be archived');
    }
    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.messages.filter((m) => m.content === 'Opening ask')).toHaveLength(1);
  });

  it('archives an empty complete root transcript through the shared archive decision', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    await manager.archiveInstance(makeInstance({
      id: 'instance-empty-complete',
      historyThreadId: 'thread-empty-complete',
      outputBuffer: [],
    }));

    const entry = manager.getEntries().find(
      (item) => item.historyThreadId === 'thread-empty-complete',
    );
    expect(entry?.messageCount).toBe(0);
    if (!entry) {
      throw new Error('Expected empty complete transcript to be archived');
    }
    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.messages).toEqual([]);
  });

  it('logs duplicate archive skips without raw instance identifiers', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    const duplicate = makeInstance({
      id: 'instance-duplicate-skip',
      historyThreadId: 'thread-duplicate-skip',
      outputBuffer: [message('duplicate-user', 'user', 'first prompt', 10)],
    });

    await manager.archiveInstance(duplicate);
    await manager.archiveInstance(duplicate);

    const skipLogs = loggerMock.info.mock.calls.filter(([messageText]) =>
      String(messageText).includes('Skipping archive')
    );
    expect(JSON.stringify(skipLogs)).toContain('sha256:');
    expect(JSON.stringify(skipLogs)).not.toContain('instance-duplicate-skip');
  });

  it('orders the merged archive chronologically when the sources overlap', async () => {
    const { getOutputStorageManager } = await import('../memory/output-storage');
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    const opening = message('prompt-1', 'user', 'Opening ask', 1);
    // The same prompt is on disk AND in the retained set — the real steady
    // state once a trim has both persisted and retained it.
    void getOutputStorageManager().storeMessages('instance-overlap', [
      opening,
      message('response-1', 'assistant', 'Early response', 2),
    ]);

    await manager.archiveInstance(makeInstance({
      id: 'instance-overlap',
      historyThreadId: 'thread-overlap',
      outputBuffer: [message('response-2', 'assistant', 'Final response', 4)],
      retainedPrompts: [opening],
    }));

    const entry = manager.getEntries().find(
      (item) => item.historyThreadId === 'thread-overlap',
    );
    if (!entry) {
      throw new Error('Expected overlap entry to be archived');
    }
    const conversation = await manager.loadConversation(entry.id);
    // Deduplicated to one copy of the prompt, in timestamp order.
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'prompt-1',
      'response-1',
      'response-2',
    ]);
  });

  it('does not let a superseded source clobber the fork-owned thread entry', async () => {
    // Regression: an edit-and-resend fork inherits the source's historyThreadId
    // and archives the full conversation. If the superseded source later archives
    // (e.g. after being torn down post-fork) it must NOT replace the fork's
    // richer entry with its short pre-fork stub. See history-manager.archiveInstance.
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const forkEntry = {
      id: 'entry-thread-1',
      displayName: 'Prod readiness',
      aiTitle: 'Prod readiness',
      createdAt: 100,
      endedAt: 5000,
      historyThreadId: 'thread-1',
      workingDirectory: '/tmp/project',
      messageCount: 3,
      firstUserMessage: 'full first',
      lastUserMessage: 'full last',
      status: 'completed' as const,
      originalInstanceId: 'fork-1',
      parentId: null,
      sessionId: 'fork-session',
      provider: 'claude' as const,
      currentModel: 'opus',
    };
    const forkConversation = {
      entry: forkEntry,
      messages: [
        { id: 'u1', timestamp: 1, type: 'user', content: 'full first' },
        { id: 'a1', timestamp: 2, type: 'assistant', content: 'full answer' },
        { id: 'u2', timestamp: 3, type: 'user', content: 'full last' },
      ],
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [forkEntry] })
    );
    fs.writeFileSync(
      path.join(storageDir, `${forkEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(forkConversation))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;

    const supersededSource = makeInstance({
      id: 'instance-1',
      historyThreadId: 'thread-1',
      status: 'superseded',
      supersededBy: 'fork-1',
      sessionId: 'source-session',
      outputBuffer: [message('s1', 'user', 'short pre-fork stub', 1)],
    });
    await manager.archiveInstance(supersededSource, 'completed');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('entry-thread-1');
    expect(entries[0].messageCount).toBe(3);
    expect(entries[0].originalInstanceId).toBe('fork-1');

    const conversation = await manager.loadConversation('entry-thread-1');
    expect(conversation?.messages).toHaveLength(3);

    const skipLogs = loggerMock.info.mock.calls.filter(([messageText]) =>
      String(messageText).includes('Skipping archive')
    );
    expect(JSON.stringify(skipLogs)).toContain('sha256:');
    expect(JSON.stringify(skipLogs)).not.toContain('instance-1');
    expect(JSON.stringify(skipLogs)).not.toContain('fork-1');
    expect(JSON.stringify(skipLogs)).not.toContain('thread-1');
    expect(JSON.stringify(skipLogs)).not.toContain('entry-thread-1');
  });

  it.each([
    ['richer current archive completes first', 'current-first' as const],
    ['stale superseded archive completes first', 'stale-first' as const],
  ])('serializes shared-thread generations when %s', async (_label, firstArchive) => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    const internals = manager as unknown as {
      getCompleteArchiveMessages: (instance: Instance) => Promise<OutputMessage[]>;
      saveConversation: (entryId: string, data: ConversationData) => Promise<void>;
    };
    const originalSaveConversation = internals.saveConversation.bind(manager);
    const currentSaveGate = deferred();
    const staleSaveGate = deferred();
    const currentSaveEntered = deferred();
    const staleSaveEntered = deferred();

    internals.getCompleteArchiveMessages = vi.fn(async (instance: Instance) => [
      ...instance.outputBuffer,
    ]);
    internals.saveConversation = vi.fn(async (entryId, data) => {
      if (data.entry.originalInstanceId === 'instance-current-generation') {
        currentSaveEntered.resolve();
        await currentSaveGate.promise;
      } else if (data.entry.originalInstanceId === 'instance-stale-generation') {
        staleSaveEntered.resolve();
        await staleSaveGate.promise;
      }
      await originalSaveConversation(entryId, data);
    });

    const current = makeInstance({
      id: 'instance-current-generation',
      historyThreadId: 'thread-concurrent-generations',
      sessionId: 'session-current-generation',
      status: 'idle',
      outputBuffer: [
        message('current-user-1', 'user', 'Opening prompt', 100),
        message('current-assistant-1', 'assistant', 'Opening response', 200),
        message('current-user-2', 'user', 'Fork continuation', 300),
        message('current-assistant-2', 'assistant', 'Richer current response', 400),
      ],
    });
    const stale = makeInstance({
      id: 'instance-stale-generation',
      historyThreadId: 'thread-concurrent-generations',
      sessionId: 'session-stale-generation',
      status: 'superseded',
      supersededBy: current.id,
      outputBuffer: current.outputBuffer.slice(0, 2),
    });

    const firstPromise = firstArchive === 'current-first'
      ? manager.archiveInstance(current, 'completed')
      : manager.archiveInstance(stale, 'completed');
    await (firstArchive === 'current-first'
      ? currentSaveEntered.promise
      : staleSaveEntered.promise);
    const secondPromise = firstArchive === 'current-first'
      ? manager.archiveInstance(stale, 'completed')
      : manager.archiveInstance(current, 'completed');
    await drainMicrotasks();

    if (firstArchive === 'current-first') {
      currentSaveGate.resolve();
      await firstPromise;
      staleSaveGate.resolve();
    } else {
      staleSaveGate.resolve();
      await firstPromise;
      currentSaveGate.resolve();
    }
    await Promise.all([firstPromise, secondPromise]);

    const entries = manager.getEntries().filter(
      (entry) => entry.historyThreadId === 'thread-concurrent-generations',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.originalInstanceId).toBe(current.id);
    expect(entries[0]?.messageCount).toBe(4);
    const conversation = await manager.loadConversation(entries[0]!.id);
    expect(conversation?.messages.map((item) => item.id)).toEqual(
      current.outputBuffer.map((item) => item.id),
    );

    if (firstArchive === 'current-first') {
      const staleWrites = (internals.saveConversation as ReturnType<typeof vi.fn>).mock.calls
        .filter(([, data]) => data.entry.originalInstanceId === stale.id);
      expect(staleWrites).toHaveLength(0);
      const positiveCoverageSkip = loggerMock.info.mock.calls.find(
        ([messageText, data]) => messageText === 'Skipping archive - already covered by history'
          && (data as Record<string, unknown>)['historyMessageCount'] === 4
          && (data as Record<string, unknown>)['outputMessageCount'] === 2,
      );
      expect(positiveCoverageSkip).toBeDefined();
    }
  });

  it('archives a superseded source when fork-owned coverage is stale', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const forkEntry = {
      id: 'entry-thread-stale',
      displayName: 'Partial fork',
      aiTitle: 'Partial fork',
      createdAt: 100,
      endedAt: 120,
      historyThreadId: 'thread-stale',
      workingDirectory: '/tmp/project',
      messageCount: 2,
      firstUserMessage: 'old first',
      lastUserMessage: 'old last',
      status: 'completed' as const,
      originalInstanceId: 'fork-stale',
      parentId: null,
      sessionId: 'fork-session-stale',
      provider: 'claude' as const,
      currentModel: 'opus',
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [forkEntry] })
    );
    fs.writeFileSync(
      path.join(storageDir, `${forkEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({
        entry: forkEntry,
        messages: [
          message('fork-user', 'user', 'old first', 100),
          message('fork-assistant', 'assistant', 'old last', 120),
        ],
      }))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;

    const supersededSource = makeInstance({
      id: 'instance-stale-source',
      historyThreadId: 'thread-stale',
      status: 'superseded',
      supersededBy: 'fork-stale',
      sessionId: 'source-session-stale',
      outputBuffer: [
        message('source-user', 'user', 'new first', 100),
        message('source-assistant', 'assistant', 'new answer after stale fork coverage', 240),
      ],
    });

    await manager.archiveInstance(supersededSource, 'completed');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('entry-thread-stale');
    expect(entries[0].messageCount).toBe(2);
    expect(entries[0].originalInstanceId).toBe('instance-stale-source');

    const conversation = await manager.loadConversation('entry-thread-stale');
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'source-user',
      'source-assistant',
    ]);
  });

  it('archives a superseded source when fork-owned coverage has too few messages', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const forkEntry = {
      id: 'entry-thread-short',
      displayName: 'Short fork',
      aiTitle: 'Short fork',
      createdAt: 100,
      endedAt: 500,
      historyThreadId: 'thread-short',
      workingDirectory: '/tmp/project',
      messageCount: 1,
      firstUserMessage: 'old first',
      lastUserMessage: 'old first',
      status: 'completed' as const,
      originalInstanceId: 'fork-short',
      parentId: null,
      sessionId: 'fork-session-short',
      provider: 'claude' as const,
      currentModel: 'opus',
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [forkEntry] })
    );
    fs.writeFileSync(
      path.join(storageDir, `${forkEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({
        entry: forkEntry,
        messages: [
          message('fork-user-short', 'user', 'old first', 500),
        ],
      }))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;

    const supersededSource = makeInstance({
      id: 'instance-short-source',
      historyThreadId: 'thread-short',
      status: 'superseded',
      supersededBy: 'fork-short',
      sessionId: 'source-session-short',
      outputBuffer: [
        message('source-user-short', 'user', 'old first', 100),
        message('source-assistant-short', 'assistant', 'source has the missing response', 200),
      ],
    });

    await manager.archiveInstance(supersededSource, 'completed');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('entry-thread-short');
    expect(entries[0].messageCount).toBe(2);
    expect(entries[0].originalInstanceId).toBe('instance-short-source');

    const conversation = await manager.loadConversation('entry-thread-short');
    expect(conversation?.messages.map((item) => item.id)).toEqual([
      'source-user-short',
      'source-assistant-short',
    ]);
  });

  it('archives a history entry without deleting the conversation file', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const entry = {
      id: 'entry-archive',
      displayName: 'Archive me',
      createdAt: 10,
      endedAt: 20,
      workingDirectory: '/tmp/archive-me',
      messageCount: 2,
      firstUserMessage: 'hello',
      lastUserMessage: 'bye',
      status: 'completed' as const,
      originalInstanceId: 'instance-archive',
      parentId: null,
      sessionId: 'session-archive',
    };

    const conversationData = {
      entry,
      messages: [
        {
          id: 'message-1',
          timestamp: 10,
          type: 'user',
          content: 'hello',
        },
      ],
    };

    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: Date.now(),
          entries: [entry],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(conversationData))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    await expect(manager.archiveEntry(entry.id)).resolves.toBe(true);

    const index = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'index.json'), 'utf-8')
    ) as { entries: { archivedAt?: number | null }[] };

    expect(index.entries[0]?.archivedAt).toEqual(expect.any(Number));
    expect(fs.existsSync(path.join(storageDir, `${entry.id}.json.gz`))).toBe(true);
  });

  /**
   * A legacy entry with no `historyThreadId` makes the constructor schedule the
   * backfill, which rewrites that entry's `.json.gz` while `archiveEntry` is
   * rewriting the same file. Both used to `writeFile` the destination directly:
   * the second call's `O_TRUNC` emptied the file between the first call's write
   * and its size check, so `archiveEntry` rejected with "Conversation file
   * written as 0 bytes" roughly once per CI run, and whichever save landed last
   * silently dropped the other's field.
   */
  it('keeps both the startup backfill and the archive write when they target one entry', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    // No historyThreadId -> requiresHistoryThreadIdBackfill() -> startup rewrites this file.
    const entry = {
      id: 'entry-concurrent',
      displayName: 'Concurrent',
      createdAt: 10,
      endedAt: 20,
      workingDirectory: '/tmp/concurrent',
      messageCount: 1,
      firstUserMessage: 'hello',
      lastUserMessage: 'hello',
      status: 'completed' as const,
      originalInstanceId: 'instance-concurrent',
      parentId: null,
      sessionId: 'session-concurrent',
    };

    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [entry] }, null, 2)
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(
        JSON.stringify({
          entry,
          messages: [{ id: 'message-1', timestamp: 10, type: 'user', content: 'hello' }],
        })
      )
    );

    // Count how many writes to this entry's file are open at once. Measuring the
    // overlap directly is what makes this deterministic: asserting on the merged
    // result instead would only fail on the interleavings that happen to lose a
    // field, which is exactly the once-per-CI-run flake being fixed.
    const conversationPath = path.join(storageDir, `${entry.id}.json.gz`);
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let inFlight = 0;
    let maxOverlap = 0;
    const writeSpy = vi
      .spyOn(fs.promises, 'writeFile')
      .mockImplementation(async (file, data, options) => {
        // The atomic save writes `<conversationPath>.<uuid>.tmp`, so match the prefix.
        const targetsEntry = String(file).startsWith(conversationPath);
        if (targetsEntry) {
          inFlight += 1;
          maxOverlap = Math.max(maxOverlap, inFlight);
        }
        try {
          return await realWriteFile(file, data as never, options as never);
        } finally {
          if (targetsEntry) inFlight -= 1;
        }
      });

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    try {
      // Do not await startupTasks first — racing them is the point.
      await expect(manager.archiveEntry(entry.id)).resolves.toBe(true);
      await manager.startupTasks;
    } finally {
      writeSpy.mockRestore();
    }

    expect(maxOverlap).toBe(1);

    const stored = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(conversationPath)).toString()
    ) as ConversationData;

    // Neither writer clobbered the other.
    expect(stored.entry.archivedAt).toEqual(expect.any(Number));
    expect(stored.entry.historyThreadId).toEqual(expect.any(String));
    expect(stored.entry.historyThreadId).not.toBe('');
    expect(stored.messages).toHaveLength(1);

    // The atomic save must not leave its temp file behind, and must not leave
    // anything that recoverOrphans would mistake for a conversation.
    const leftovers = fs.readdirSync(storageDir).filter((file) => file.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  /**
   * loadConversation self-heals a legacy entry's historyThreadId, and that write
   * is a fifth writer to the same file. It used to persist the snapshot it had
   * already read, so a save committing in between was reverted — silently
   * dropping whatever that writer had just archived. It now re-reads inside the
   * write queue, so it heals the field without carrying the stale copy along.
   */
  it('heals historyThreadId on read without reverting a write that landed first', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const entry = {
      id: 'entry-heal',
      displayName: 'Heal me',
      createdAt: 10,
      endedAt: 20,
      workingDirectory: '/tmp/heal',
      messageCount: 1,
      firstUserMessage: 'hello',
      lastUserMessage: 'hello',
      status: 'completed' as const,
      originalInstanceId: 'instance-heal',
      parentId: null,
      sessionId: 'session-heal',
    };

    // The index entry already has a canonical historyThreadId, so the startup
    // backfill is a no-op and cannot heal the file first. Only the stored copy
    // lacks one, which is exactly what makes loadConversation heal on read.
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: Date.now(),
          entries: [{ ...entry, historyThreadId: 'thread-heal' }],
        },
        null,
        2
      )
    );
    const conversationPath = path.join(storageDir, `${entry.id}.json.gz`);
    fs.writeFileSync(
      conversationPath,
      zlib.gzipSync(
        JSON.stringify({
          entry,
          messages: [{ id: 'message-1', timestamp: 10, type: 'user', content: 'hello' }],
        })
      )
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;

    // Force the interleaving the fix is about: another writer commits AFTER
    // loadConversation's read resolves but BEFORE its heal is written. Injected
    // from the read itself so the ordering is deterministic rather than raced.
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let injected = false;
    const readSpy = vi
      .spyOn(fs.promises, 'readFile')
      .mockImplementation(async (file, options) => {
        const data = await realReadFile(file, options as never);
        if (!injected && String(file) === conversationPath) {
          injected = true;
          const current = JSON.parse(
            zlib.gunzipSync(fs.readFileSync(conversationPath)).toString()
          ) as ConversationData;
          fs.writeFileSync(
            conversationPath,
            zlib.gzipSync(
              JSON.stringify({
                entry: current.entry,
                messages: [
                  ...current.messages,
                  { id: 'message-2', timestamp: 30, type: 'user', content: 'archived later' },
                ],
              })
            )
          );
        }
        return data;
      });

    let loaded: ConversationData | null;
    try {
      loaded = await manager.loadConversation(entry.id);
    } finally {
      readSpy.mockRestore();
    }
    expect(injected).toBe(true);
    expect(loaded).not.toBeNull();

    const stored = JSON.parse(
      zlib.gunzipSync(fs.readFileSync(conversationPath)).toString()
    ) as ConversationData;

    // The later write survives the heal, and the heal still happened.
    expect(stored.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(stored.entry.historyThreadId).toBe('thread-heal');
    expect(loaded?.entry.historyThreadId).toBe('thread-heal');

    // The caller must get what was healed, not the pre-heal snapshot. The
    // restore coordinator builds its transcript straight from these messages,
    // so returning the stale read would drop the newest one from a restored
    // session while the file on disk looked perfectly correct.
    expect(loaded?.messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
  });

  it('carries automation provenance from instance metadata into the archived entry', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const automationInstance = makeInstance({
      id: 'instance-auto',
      historyThreadId: 'thread-auto',
      sessionId: 'session-auto',
      metadata: { automationId: 'automation-7', automationRunId: 'run-7' },
      outputBuffer: [message('m-auto', 'user', 'run the marketing sweep', 10)],
    });
    const manualInstance = makeInstance({
      id: 'instance-manual',
      historyThreadId: 'thread-manual',
      sessionId: 'session-manual',
      outputBuffer: [message('m-manual', 'user', 'fix the login bug', 10)],
    });

    await manager.archiveInstance(automationInstance, 'completed');
    await manager.archiveInstance(manualInstance, 'completed');

    const entries = manager.getEntries();
    const autoEntry = entries.find((e) => e.historyThreadId === 'thread-auto');
    const manualEntry = entries.find((e) => e.historyThreadId === 'thread-manual');

    expect(autoEntry?.isAutomation).toBe(true);
    // Manual threads stay unflagged so the rail clock only marks automations.
    expect(manualEntry?.isAutomation).toBeUndefined();
  });

  it('carries hidden-automation visibility into the archived entry', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const hiddenInstance = makeInstance({
      id: 'instance-hidden',
      historyThreadId: 'thread-hidden',
      sessionId: 'session-hidden',
      metadata: {
        automationId: 'automation-8',
        automationRunId: 'run-8',
        automationHidden: true,
        automationRunSucceeded: true,
      },
      outputBuffer: [message('m-hidden', 'user', 'run the uptime check', 10)],
    });
    const visibleInstance = makeInstance({
      id: 'instance-visible',
      historyThreadId: 'thread-visible',
      sessionId: 'session-visible',
      metadata: { automationId: 'automation-9', automationRunId: 'run-9' },
      outputBuffer: [message('m-visible', 'user', 'publish the blog post', 10)],
    });

    await manager.archiveInstance(hiddenInstance, 'completed');
    await manager.archiveInstance(visibleInstance, 'completed');

    const entries = manager.getEntries();
    expect(entries.find((e) => e.historyThreadId === 'thread-hidden')?.isHiddenAutomation).toBe(true);
    expect(entries.find((e) => e.historyThreadId === 'thread-visible')?.isHiddenAutomation).toBeUndefined();
  });

  it('does not hide an archived hidden run that did not finish cleanly', async () => {
    // Termination maps every non-`error` status to the `completed`
    // ConversationEndStatus, so the archived entry cannot infer the outcome
    // itself. Anything short of a recorded success must stay visible.
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const failedInstance = makeInstance({
      id: 'instance-hidden-failed',
      historyThreadId: 'thread-hidden-failed',
      sessionId: 'session-hidden-failed',
      metadata: {
        automationId: 'automation-10',
        automationRunId: 'run-10',
        automationHidden: true,
      },
      outputBuffer: [message('m-failed', 'user', 'run the uptime check', 10)],
    });

    await manager.archiveInstance(failedInstance, 'completed');

    const entry = manager.getEntries().find((e) => e.historyThreadId === 'thread-hidden-failed');
    expect(entry?.isAutomation).toBe(true);
    expect(entry?.isHiddenAutomation).toBeUndefined();
  });

  it('keeps a hidden run visible when it is killed mid-run at app shutdown', async () => {
    // terminateAll() on quit archives the instance BEFORE the status change
    // that would tell AutomationRunner the run died, so no outcome stamp can
    // exist yet. Recording success (rather than failure) is what makes this
    // unknown state resolve to "visible".
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const inFlight = makeInstance({
      id: 'instance-hidden-inflight',
      historyThreadId: 'thread-hidden-inflight',
      sessionId: 'session-hidden-inflight',
      status: 'busy',
      metadata: {
        automationId: 'automation-11',
        automationRunId: 'run-11',
        automationHidden: true,
      },
      outputBuffer: [message('m-inflight', 'user', 'run the uptime check', 10)],
    });

    await manager.archiveInstance(inFlight, 'completed');

    const entry = manager.getEntries().find((e) => e.historyThreadId === 'thread-hidden-inflight');
    expect(entry?.isHiddenAutomation).toBeUndefined();
  });

  it('does not re-hide a restored thread that is archived again', async () => {
    // A restored instance carries none of the original automation metadata. If
    // the previous entry's hidden flag were inherited, a thread the operator
    // deliberately reopened — and that may since have failed in front of them —
    // would silently drop out of the rail again.
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const original = makeInstance({
      id: 'instance-hidden-restore',
      historyThreadId: 'thread-hidden-restore',
      sessionId: 'session-hidden-restore',
      metadata: {
        automationId: 'automation-12',
        automationRunId: 'run-12',
        automationHidden: true,
        automationRunSucceeded: true,
      },
      outputBuffer: [message('m-orig', 'user', 'run the uptime check', 10)],
    });
    await manager.archiveInstance(original, 'completed');
    expect(
      manager.getEntries().find((e) => e.historyThreadId === 'thread-hidden-restore')?.isHiddenAutomation,
    ).toBe(true);

    const restored = makeInstance({
      id: 'instance-hidden-restored',
      historyThreadId: 'thread-hidden-restore',
      sessionId: 'session-hidden-restore',
      outputBuffer: [message('m-restored', 'user', 'now do something else', 20)],
    });
    await manager.archiveInstance(restored, 'error');

    const entries = manager.getEntries().filter((e) => e.historyThreadId === 'thread-hidden-restore');
    expect(entries.every((e) => e.isHiddenAutomation === undefined)).toBe(true);
  });

  it('persists local-model runtime summaries in history entries and conversation data', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const runtimeSummary = {
      kind: 'local-model' as const,
      label: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      modelId: 'qwen',
    };
    const instance = makeInstance({
      id: 'instance-local-model',
      historyThreadId: 'thread-local-model',
      sessionId: 'session-local-model',
      provider: 'claude',
      currentModel: 'qwen',
      runtimeSummary,
      outputBuffer: [message('m-local', 'user', 'run this on qwen', 10)],
    });

    await manager.archiveInstance(instance, 'completed');

    const entry = manager.getEntries().find((item) => item.historyThreadId === 'thread-local-model');
    expect(entry?.runtimeSummary).toEqual(runtimeSummary);
    if (!entry) {
      throw new Error('Expected local-model history entry to be archived');
    }

    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.entry.runtimeSummary).toEqual(runtimeSummary);
  });

  it('carries project rail hide provenance from internal worker metadata into the archived entry', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const workerInstance = makeInstance({
      id: 'instance-worker',
      historyThreadId: 'thread-worker',
      sessionId: 'session-worker',
      metadata: { spawnDepth: 1, spawnParentInstanceId: 'parent-instance' },
      outputBuffer: [message('m-worker', 'user', 'run diagnostics on windows', 10)],
    });

    await manager.archiveInstance(workerInstance, 'completed');

    const entry = manager.getEntries().find((item) => item.historyThreadId === 'thread-worker');
    expect(entry?.hideFromProjectRail).toBe(true);
    if (!entry) {
      throw new Error('Expected worker history entry to be archived');
    }

    const conversation = await manager.loadConversation(entry.id);
    expect(conversation?.entry.hideFromProjectRail).toBe(true);
  });

  it('backfills isAutomation for legacy entries with an "Automation:" displayName on load', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const legacyAutomationEntry = {
      id: 'entry-legacy-auto',
      displayName: 'Automation: Daily Marketplace Marketing',
      createdAt: 10,
      endedAt: 20,
      workingDirectory: '/repo/binsout',
      messageCount: 2,
      firstUserMessage: 'twice-daily marketing sweep',
      lastUserMessage: 'done',
      status: 'completed' as const,
      originalInstanceId: 'instance-legacy-auto',
      parentId: null,
      sessionId: 'session-legacy-auto',
      // No isAutomation flag — predates provenance tracking.
    };
    const legacyManualEntry = {
      id: 'entry-legacy-manual',
      displayName: 'Fix the login bug',
      createdAt: 11,
      endedAt: 21,
      workingDirectory: '/repo/binsout',
      messageCount: 1,
      firstUserMessage: 'fix login',
      lastUserMessage: 'fix login',
      status: 'completed' as const,
      originalInstanceId: 'instance-legacy-manual',
      parentId: null,
      sessionId: 'session-legacy-manual',
    };

    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({
        version: 1,
        lastUpdated: Date.now(),
        entries: [legacyAutomationEntry, legacyManualEntry],
      })
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const entries = manager.getEntries();
    expect(entries.find((e) => e.id === 'entry-legacy-auto')?.isAutomation).toBe(true);
    expect(entries.find((e) => e.id === 'entry-legacy-manual')?.isAutomation).toBeUndefined();
  });

  it('upserts history by stable thread identity when a restored session falls back to a new CLI session', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const firstInstance: Instance = {
      id: 'instance-original',
      displayName: 'Central Auth',
      createdAt: 100,
      historyThreadId: 'thread-central-auth',
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
      status: 'error',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 200,
      processId: null,
      providerSessionId: 'session-original',
      sessionId: 'session-original',
      restartEpoch: 0,
      workingDirectory: '/tmp/central-auth',
      yoloMode: false,
      provider: 'claude',
      currentModel: 'opus',
      outputBuffer: [
        {
          id: 'message-user-1',
          timestamp: 101,
          type: 'user',
          content: 'What is the backend for central auth written in?',
        },
        {
          id: 'message-assistant-1',
          timestamp: 102,
          type: 'assistant',
          content: 'It is written in TypeScript.',
        },
      ],
      outputBufferMaxSize: 1000,
      communicationTokens: new Map(),
      subscribedTo: [],
      totalTokensUsed: 0,
      requestCount: 0,
      errorCount: 0,
      restartCount: 0,
    };

    await manager.archiveInstance(firstInstance, 'error');
    const firstEntry = manager.getEntries()[0];
    expect(firstEntry?.sessionId).toBe('session-original');
    expect(firstEntry?.historyThreadId).toBe('thread-central-auth');
    expect(firstEntry?.provider).toBe('claude');
    expect(firstEntry?.currentModel).toBe('opus');

    const fallbackCopy: Instance = {
      ...firstInstance,
      id: 'instance-fallback-copy',
      createdAt: 500,
      sessionId: 'session-fallback-copy',
      outputBuffer: [
        ...firstInstance.outputBuffer,
        {
          id: 'message-user-2',
          timestamp: 501,
          type: 'user',
          content: 'hey',
        },
      ],
    };

    await manager.archiveInstance(fallbackCopy, 'error');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(firstEntry?.id);
    expect(entries[0]?.createdAt).toBe(100);
    expect(entries[0]?.sessionId).toBe('session-fallback-copy');
    expect(entries[0]?.historyThreadId).toBe('thread-central-auth');
    expect(entries[0]?.messageCount).toBe(3);
    expect(entries[0]?.provider).toBe('claude');
    expect(entries[0]?.currentModel).toBe('opus');

    const storageFiles = fs
      .readdirSync(path.join(userDataDir, 'conversation-history'))
      .filter((file) => file.endsWith('.json.gz'));
    expect(storageFiles).toHaveLength(1);
  });

  it('preserves the failed native session id when archiving an unresolved replay fallback', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const originalMessages = [
      message('message-user-1', 'user', 'Continue the refactor plan', 101),
      message('message-assistant-1', 'assistant', 'The plan is in progress.', 102),
    ];
    const original = makeInstance({
      id: 'instance-original-native',
      historyThreadId: 'thread-native',
      sessionId: 'native-session',
      providerSessionId: 'native-session',
      outputBuffer: originalMessages,
    });

    await manager.archiveInstance(original, 'completed');

    const fallback = makeInstance({
      id: 'instance-fallback-idle',
      historyThreadId: 'thread-native',
      sessionId: 'fresh-unused-session',
      providerSessionId: 'fresh-unused-session',
      outputBuffer: [
        ...originalMessages,
        message(
          'message-error-1',
          'error',
          'No conversation found with session ID: native-session',
          103
        ),
        message(
          'message-notice-1',
          'system',
          'Previous Claude CLI session could not be restored natively. Your conversation history is displayed above.',
          104,
          {
            isRestoreNotice: true,
            systemMessageKind: 'restore-fallback',
            originalSessionId: 'native-session',
          }
        ),
      ],
    });

    await manager.archiveInstance(fallback, 'terminated');

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.sessionId).toBe('native-session');
    expect(entries[0]?.nativeResumeFailedAt).toBe(104);
    expect(entries[0]?.messageCount).toBe(4);
  });

  it('uses the fresh session id once replay fallback receives new assistant output', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const originalMessages = [
      message('message-user-1', 'user', 'Continue the refactor plan', 101),
      message('message-assistant-1', 'assistant', 'The plan is in progress.', 102),
    ];
    const original = makeInstance({
      id: 'instance-original-native',
      historyThreadId: 'thread-native-recovered',
      sessionId: 'native-session',
      providerSessionId: 'native-session',
      outputBuffer: originalMessages,
    });

    await manager.archiveInstance(original, 'completed');

    const recoveredFallback = makeInstance({
      id: 'instance-fallback-recovered',
      historyThreadId: 'thread-native-recovered',
      sessionId: 'fresh-real-session',
      providerSessionId: 'fresh-real-session',
      outputBuffer: [
        ...originalMessages,
        message(
          'message-error-1',
          'error',
          'No conversation found with session ID: native-session',
          103
        ),
        message(
          'message-notice-1',
          'system',
          'Previous Claude CLI session could not be restored natively. Your conversation history is displayed above.',
          104,
          {
            isRestoreNotice: true,
            systemMessageKind: 'restore-fallback',
            originalSessionId: 'native-session',
          }
        ),
        message('message-user-2', 'user', 'Use the replayed context.', 105),
        message('message-assistant-2', 'assistant', 'Continuing from the replayed context.', 106),
      ],
    });

    await manager.archiveInstance(recoveredFallback, 'completed');

    const entry = manager.getEntries()[0];
    expect(entry?.sessionId).toBe('fresh-real-session');
    expect(entry?.nativeResumeFailedAt).toBeUndefined();
  });

  it('marks archived sessions as non-resumable when resume failures were never followed by assistant output', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const instance: Instance = {
      id: 'instance-resume-failed',
      displayName: 'Binsout',
      createdAt: 100,
      historyThreadId: 'thread-binsout',
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
      status: 'error',
      contextUsage: {
        used: 0,
        total: 200000,
        percentage: 0,
      },
      lastActivity: 200,
      processId: null,
      providerSessionId: 'session-resume-failed',
      sessionId: 'session-resume-failed',
      restartEpoch: 0,
      workingDirectory: '/tmp/binsout',
      yoloMode: false,
      provider: 'claude',
      currentModel: 'opus',
      outputBuffer: [
        {
          id: 'message-user-1',
          timestamp: 101,
          type: 'user',
          content: 'continue',
        },
        {
          id: 'message-system-1',
          timestamp: 102,
          type: 'system',
          content: 'Session restarted automatically (resume failed)',
        },
        {
          id: 'message-user-2',
          timestamp: 103,
          type: 'user',
          content: 'continue',
        },
        {
          id: 'message-error-1',
          timestamp: 104,
          type: 'error',
          content: 'No conversation found with session ID: stale-session',
        },
      ],
      outputBufferMaxSize: 1000,
      communicationTokens: new Map(),
      subscribedTo: [],
      totalTokensUsed: 0,
      requestCount: 0,
      errorCount: 0,
      restartCount: 1,
    };

    await manager.archiveInstance(instance, 'error');

    const entry = manager.getEntries()[0];
    expect(entry?.nativeResumeFailedAt).toBe(104);
  });

  it('keeps archived sessions resumable after assistant output lands post-recovery', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const instance: Instance = {
      id: 'instance-resume-recovered',
      displayName: 'Binsout',
      createdAt: 100,
      historyThreadId: 'thread-binsout-2',
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
      status: 'idle',
      contextUsage: {
        used: 1234,
        total: 200000,
        percentage: 1,
      },
      lastActivity: 200,
      processId: null,
      providerSessionId: 'session-resume-recovered',
      sessionId: 'session-resume-recovered',
      restartEpoch: 0,
      workingDirectory: '/tmp/binsout',
      yoloMode: false,
      provider: 'claude',
      currentModel: 'opus',
      outputBuffer: [
        {
          id: 'message-user-1',
          timestamp: 101,
          type: 'user',
          content: 'continue',
        },
        {
          id: 'message-system-1',
          timestamp: 102,
          type: 'system',
          content: 'Session restarted automatically (resume failed)',
        },
        {
          id: 'message-assistant-1',
          timestamp: 103,
          type: 'assistant',
          content: 'Recovered and ready.',
        },
      ],
      outputBufferMaxSize: 1000,
      communicationTokens: new Map(),
      subscribedTo: [],
      totalTokensUsed: 0,
      requestCount: 0,
      errorCount: 0,
      restartCount: 1,
    };

    await manager.archiveInstance(instance, 'completed');

    const entry = manager.getEntries()[0];
    expect(entry?.nativeResumeFailedAt).toBeUndefined();
  });

  it('backfills and persists distinct app history identities for legacy provider-ID collisions', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const duplicateEntries = [
      {
        id: 'entry-newest',
        displayName: 'Central Auth',
        createdAt: 10,
        endedAt: 30,
        workingDirectory: '/tmp/central-auth',
        messageCount: 5,
        firstUserMessage: 'What is the backend for central auth written in?',
        lastUserMessage: 'hey',
        status: 'error' as const,
        originalInstanceId: 'instance-newest',
        parentId: null,
        sessionId: 'session-central-auth',
      },
      {
        id: 'entry-older',
        displayName: 'Central Auth',
        createdAt: 10,
        endedAt: 20,
        workingDirectory: '/tmp/central-auth',
        messageCount: 4,
        firstUserMessage: 'What is the backend for central auth written in?',
        lastUserMessage: 'hi',
        status: 'completed' as const,
        originalInstanceId: 'instance-older',
        parentId: null,
        sessionId: 'session-central-auth',
      },
    ];

    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify(
        {
          version: 1,
          lastUpdated: Date.now(),
          entries: duplicateEntries,
        },
        null,
        2
      )
    );
    for (const entry of duplicateEntries) {
      fs.writeFileSync(
        path.join(storageDir, `${entry.id}.json.gz`),
        zlib.gzipSync(JSON.stringify({ entry, messages: [] }))
      );
    }

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;

    const entries = manager.getEntries();
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.historyThreadId)).size).toBe(2);
    expect(entries.every((entry) => entry.historyThreadId !== 'session-central-auth')).toBe(true);

    const persistedIds = new Map(entries.map((entry) => [entry.id, entry.historyThreadId]));
    const reloaded = track(new HistoryManager());
    await reloaded.startupTasks;
    expect(new Map(reloaded.getEntries().map((entry) => [entry.id, entry.historyThreadId])))
      .toEqual(persistedIds);

    for (const entry of entries) {
      const conversation = await reloaded.loadConversation(entry.id);
      expect(conversation?.entry.historyThreadId).toBe(entry.historyThreadId);
    }
  });

  it('rotates a factory-derived session alias while preserving an independent app history id', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const aliased = {
      id: 'entry-aliased', displayName: 'Aliased', createdAt: 1, endedAt: 2,
      workingDirectory: '/tmp/aliased', messageCount: 0, firstUserMessage: '',
      lastUserMessage: '', status: 'completed' as const,
      originalInstanceId: 'instance-aliased', parentId: null,
      sessionId: 'provider-session-aliased', historyThreadId: 'provider-session-aliased',
    };
    const independent = {
      id: 'entry-independent', displayName: 'Independent', createdAt: 1, endedAt: 3,
      workingDirectory: '/tmp/independent', messageCount: 0, firstUserMessage: '',
      lastUserMessage: '', status: 'completed' as const,
      originalInstanceId: 'instance-independent', parentId: null,
      sessionId: 'provider-session-independent', historyThreadId: 'app-history-independent',
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [independent, aliased], lastUpdated: 0 }),
    );
    for (const entry of [aliased, independent]) {
      fs.writeFileSync(
        path.join(storageDir, `${entry.id}.json.gz`),
        zlib.gzipSync(JSON.stringify({ entry, messages: [] })),
      );
    }

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;
    const byId = new Map(manager.getEntries().map((entry) => [entry.id, entry]));

    expect(byId.get(aliased.id)?.historyThreadId).not.toBe(aliased.sessionId);
    expect(byId.get(independent.id)?.historyThreadId).toBe(independent.historyThreadId);

    const stableAlias = byId.get(aliased.id)?.historyThreadId;
    const reloaded = track(new HistoryManager());
    await reloaded.startupTasks;
    expect(reloaded.getEntries().find((entry) => entry.id === aliased.id)?.historyThreadId)
      .toBe(stableAlias);
    expect((await reloaded.loadConversation(aliased.id))?.entry.historyThreadId).toBe(stableAlias);
    expect((await reloaded.loadConversation(independent.id))?.entry.historyThreadId)
      .toBe(independent.historyThreadId);
  });

  it('returns coverage through the later of endedAt and last message for stable identities only', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const entry = {
      id: 'coverage-entry',
      displayName: 'A duplicated display label',
      createdAt: 100,
      endedAt: 200,
      workingDirectory: '/tmp/project',
      messageCount: 2,
      firstUserMessage: 'fixture prompt',
      lastUserMessage: 'fixture prompt',
      status: 'completed' as const,
      originalInstanceId: 'coverage-instance',
      parentId: null,
      sessionId: 'provider-session-placeholder',
      historyThreadId: 'stable-coverage-thread',
      provider: 'claude' as const,
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: 0, entries: [entry] }),
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({
        entry,
        messages: [
          message('coverage-user', 'user', 'fixture prompt', 150),
          message('coverage-assistant', 'assistant', 'fixture response', 350),
        ],
      })),
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;
    let releaseReady!: () => void;
    const delayedReady = new Promise<void>((resolve) => { releaseReady = resolve; });
    Object.defineProperty(manager, 'startupTasks', { value: delayedReady });
    let settled = false;
    const pendingCoverage = manager.getRecoveryCoverage([
      {
        recoveryKey: 'history:claude:stable-coverage-thread',
        provider: 'claude',
        historyThreadId: 'stable-coverage-thread',
      },
      {
        recoveryKey: 'history:claude:not-the-thread',
        provider: 'claude',
        historyThreadId: 'not-the-thread',
      },
    ]);
    void pendingCoverage.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseReady();
    const coverage = await pendingCoverage;

    expect(coverage.get('history:claude:stable-coverage-thread')).toEqual({
      recoveryKey: 'history:claude:stable-coverage-thread',
      historyEntryId: 'coverage-entry',
      provider: 'claude',
      historyThreadId: 'stable-coverage-thread',
      sessionId: 'provider-session-placeholder',
      coveredThrough: 350,
      messageCount: 2,
    });
    expect(coverage.has('history:claude:not-the-thread')).toBe(false);
  });

  it('rotates and persists a factory-derived alias recovered from an orphan gzip', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const orphan = {
      id: 'entry-orphan-alias', displayName: 'Orphan', createdAt: 1, endedAt: 2,
      workingDirectory: '/tmp/orphan', messageCount: 0, firstUserMessage: '',
      lastUserMessage: '', status: 'completed' as const,
      originalInstanceId: 'instance-orphan', parentId: null,
      sessionId: 'provider-session-orphan', historyThreadId: 'provider-session-orphan',
    };
    fs.writeFileSync(
      path.join(storageDir, `${orphan.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry: orphan, messages: [] })),
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());
    await manager.startupTasks;
    const recovered = manager.getEntries()[0];

    expect(recovered.historyThreadId).not.toBe(orphan.sessionId);
    expect((await manager.loadConversation(orphan.id))?.entry.historyThreadId)
      .toBe(recovered.historyThreadId);
    const reloaded = track(new HistoryManager());
    await reloaded.startupTasks;
    expect(reloaded.getEntries()[0]?.historyThreadId).toBe(recovered.historyThreadId);
  });

  it('persists an AI title to the index and conversation file via setEntryAiTitle', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const entry = {
      id: 'entry-ai',
      displayName: 'review this PR UnstablePvP core',
      createdAt: 1,
      endedAt: 2,
      workingDirectory: '/tmp/ai',
      messageCount: 1,
      firstUserMessage: 'Please review this PR [UnstablePvP/core]',
      lastUserMessage: 'Please review this PR [UnstablePvP/core]',
      status: 'completed' as const,
      originalInstanceId: 'instance-ai',
      parentId: null,
      sessionId: 'session-ai',
    };
    const conversationData = {
      entry,
      messages: [{ id: 'm1', timestamp: 1, type: 'user', content: 'x' }],
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries: [entry] }, null, 2)
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify(conversationData))
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    expect(await manager.setEntryAiTitle('entry-ai', '  UnstablePvP coin audit  ')).toBe(true);
    expect(manager.getEntries()[0]?.aiTitle).toBe('UnstablePvP coin audit');

    const conv = await manager.loadConversation('entry-ai');
    expect(conv?.entry.aiTitle).toBe('UnstablePvP coin audit');

    // Never clobbers an existing AI title, and skips a blank update.
    expect(await manager.setEntryAiTitle('entry-ai', 'something else')).toBe(false);
    expect(manager.getEntries()[0]?.aiTitle).toBe('UnstablePvP coin audit');
  });

  it('backfills missing AI titles for eligible entries only', async () => {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const mk = (over: Record<string, unknown>): Record<string, unknown> => ({
      createdAt: 1,
      endedAt: 2,
      workingDirectory: '/tmp/b',
      messageCount: 1,
      status: 'completed',
      parentId: null,
      lastUserMessage: 'x',
      ...over,
    });
    const entries = [
      mk({ id: 'e-needs', displayName: 'd', firstUserMessage: 'Please harden the coin accounting flow', originalInstanceId: 'i1', sessionId: 's1' }),
      mk({ id: 'e-has', displayName: 'd', aiTitle: 'Existing AI', firstUserMessage: 'something long enough here', originalInstanceId: 'i2', sessionId: 's2' }),
      mk({ id: 'e-renamed', displayName: 'mine', isRenamed: true, firstUserMessage: 'something long enough here', originalInstanceId: 'i3', sessionId: 's3' }),
      mk({ id: 'e-short', displayName: 'd', firstUserMessage: 'hi', originalInstanceId: 'i4', sessionId: 's4' }),
    ];
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, lastUpdated: Date.now(), entries }, null, 2)
    );

    const { HistoryManager } = await import('./history-manager');
    const manager = track(new HistoryManager());

    const seen: string[] = [];
    const generate = vi.fn(async (text: string) => {
      seen.push(text);
      return 'Generated title';
    });

    await manager.backfillMissingAiTitles(manager.getEntries(), generate);

    // Only the eligible entry (no AI title, not renamed, long-enough message).
    expect(generate).toHaveBeenCalledTimes(1);
    expect(seen[0]).toBe('Please harden the coin accounting flow');

    const byId = Object.fromEntries(manager.getEntries().map((e) => [e.id, e.aiTitle]));
    expect(byId['e-needs']).toBe('Generated title');
    expect(byId['e-has']).toBe('Existing AI');
    expect(byId['e-renamed']).toBeUndefined();
    expect(byId['e-short']).toBeUndefined();
  });
});
