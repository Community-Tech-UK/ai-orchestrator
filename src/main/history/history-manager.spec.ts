import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';

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
});
