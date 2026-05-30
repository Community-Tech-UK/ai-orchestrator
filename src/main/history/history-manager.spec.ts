import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

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

describe('HistoryManager', () => {
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
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

  afterEach(() => {
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
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();
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
    const manager = new HistoryManager();

    await expect(manager.archiveEntry(entry.id)).resolves.toBe(true);

    const index = JSON.parse(
      fs.readFileSync(path.join(storageDir, 'index.json'), 'utf-8')
    ) as { entries: { archivedAt?: number | null }[] };

    expect(index.entries[0]?.archivedAt).toEqual(expect.any(Number));
    expect(fs.existsSync(path.join(storageDir, `${entry.id}.json.gz`))).toBe(true);
  });

  it('upserts history by stable thread identity when a restored session falls back to a new CLI session', async () => {
    const { HistoryManager } = await import('./history-manager');
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();

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

  it('deduplicates legacy history entries by session identity on load', async () => {
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

    const { HistoryManager } = await import('./history-manager');
    const manager = new HistoryManager();

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe('entry-newest');
    expect(entries[0]?.sessionId).toBe('session-central-auth');
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
    const manager = new HistoryManager();

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
    const manager = new HistoryManager();

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
