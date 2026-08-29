import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationThreadRecord } from '../../../shared/types/conversation-ledger.types';
import type { Instance } from '../../../shared/types/instance.types';
import type { InstanceManager } from '../../instance/instance-manager';

describe('HistoryManager — native Claude transcript import', () => {
  let userDataDir = '';
  let homeDir = '';
  let originalHome: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-manager-import-userdata-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-manager-import-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = homeDir;

    vi.doMock('electron', () => ({
      app: {
        getPath: vi.fn((name: string) => {
          if (name === 'userData') return userDataDir;
          throw new Error(`Unexpected path lookup: ${name}`);
        }),
      },
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.resetModules();
    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }
    if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
    if (homeDir) fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function writeJsonl(filePath: string, lines: object[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  function writeConversationFile(entry: object): void {
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });
    const entryId = (entry as { id: string }).id;
    fs.writeFileSync(
      path.join(storageDir, `${entryId}.json.gz`),
      zlib.gzipSync(JSON.stringify({ entry, messages: [] }))
    );
  }

  it('imports a native Claude .jsonl transcript into the history index on startup', async () => {
    const sessionId = '11111111-2222-3333-4444-555555555555';
    const transcriptPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-Users-me-Demo',
      `${sessionId}.jsonl`
    );
    writeJsonl(transcriptPath, [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Initial question for the import test' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is the answer.' }],
        },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.id).toBe(sessionId);
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.historyThreadId).toEqual(expect.any(String));
    expect(entry.historyThreadId).not.toBe(sessionId);
    expect(entry.workingDirectory).toBe('/Users/me/Demo');
    expect(entry.firstUserMessage).toContain('Initial question');
    expect(entry.messageCount).toBe(2);
    expect(entry.provider).toBe('claude');
    expect(entry.status).toBe('completed');
    expect((entry as { importSource?: string }).importSource).toBe('native-claude');

    const conversation = await manager.loadConversation(entry.id);
    expect(conversation).not.toBeNull();
    expect(conversation!.entry.historyThreadId).toBe(entry.historyThreadId);
    expect(conversation!.messages).toHaveLength(2);
    expect(conversation!.messages[0].type).toBe('user');
    expect(conversation!.messages[1].type).toBe('assistant');
    expect(conversation!.messages[1].content).toBe('Here is the answer.');
  });

  it('repairs an archived transcript that contains only the native transcript tail', async () => {
    const sessionId = 'tail-repair-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const entry = {
      id: 'archive-tail',
      displayName: 'Truncated archive',
      createdAt: 3_000,
      endedAt: 4_000,
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: 'Follow-up prompt',
      lastUserMessage: 'Follow-up prompt',
      status: 'completed' as const,
      originalInstanceId: 'instance-tail',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      path.join(storageDir, `${entry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({
        entry,
        messages: [
          { id: 'old-u2', timestamp: 3_000, type: 'user', content: 'Follow-up prompt' },
          { id: 'old-a2', timestamp: 4_000, type: 'assistant', content: 'Final answer' },
        ],
      })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Original prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Initial answer' }] },
      },
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-04-10T09:01:00.000Z',
        sessionId,
        message: { role: 'user', content: 'Follow-up prompt' },
      },
      {
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-04-10T09:01:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const repaired = await manager.loadConversation(entry.id);
    expect(repaired?.messages.map((message) => message.content)).toEqual([
      'Original prompt',
      'Initial answer',
      'Follow-up prompt',
      'Final answer',
    ]);
    expect(repaired?.entry.firstUserMessage).toBe('Original prompt');
    expect(repaired?.entry.messageCount).toBe(4);
    expect(fs.existsSync(path.join(storageDir, `${entry.id}.json.gz.truncated-backup`))).toBe(true);
  });

  it('preserves legacy-redacted repair behavior after repair classification is extracted', async () => {
    const sessionId = 'legacy-redacted-repair-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const entry = {
      id: 'legacy-redacted-archive',
      displayName: 'Legacy redacted archive',
      createdAt: Date.parse('2026-04-10T09:00:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:00:05.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: 'Original prompt',
      lastUserMessage: 'Original prompt',
      status: 'completed' as const,
      originalInstanceId: 'legacy-redacted-instance',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    const archivePath = path.join(storageDir, `${entry.id}.json.gz`);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(JSON.stringify({
        entry,
        messages: [
          { id: 'app-u1', timestamp: entry.createdAt, type: 'user', content: 'Original prompt' },
          { id: 'app-a1', timestamp: entry.endedAt, type: 'assistant', content: '[REDACTED TOOL OUTPUT]' },
        ],
      })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Original prompt' },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-04-10T09:00:03.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: '[REDACTED TOOL OUTPUT]' }] },
      },
      {
        type: 'assistant',
        uuid: 'native-a2',
        timestamp: '2026-04-10T09:00:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered answer' }] },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const repaired = await manager.loadConversation(entry.id);
    expect(repaired?.messages.map((message) => message.content)).toEqual([
      'Original prompt',
      'Recovered answer',
    ]);
    expect(fs.existsSync(`${archivePath}.legacy-redacted-backup`)).toBe(true);
  });

  it('repairs a non-tail app archive when it lost the native opening prompt', async () => {
    const sessionId = 'missing-opening-prompt-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const entry = {
      id: 'app-owned-archive',
      displayName: 'Bounded app archive',
      createdAt: Date.parse('2026-04-10T09:01:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:02:00.000Z'),
      workingDirectory: '/Users/me/OldDemo',
      messageCount: 3,
      firstUserMessage: 'Later quoted prompt',
      lastUserMessage: 'Later quoted prompt',
      status: 'completed' as const,
      originalInstanceId: 'instance-owned-by-app',
      historyThreadId: 'thread-owned-by-app',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    const archivePath = path.join(storageDir, `${entry.id}.json.gz`);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(JSON.stringify({
        entry,
        messages: [
          { id: 'tool-1', timestamp: entry.createdAt, type: 'tool_use', content: 'Using tool: Agent' },
          { id: 'sidechain-1', timestamp: entry.createdAt + 1, type: 'assistant', content: 'Subagent-only activity' },
          { id: 'later-user', timestamp: entry.endedAt, type: 'user', content: 'Later quoted prompt' },
        ],
      })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Original native prompt' },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Native answer' }] },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const repaired = await manager.loadConversation(entry.id);
    expect(repaired?.messages.map((message) => message.content)).toEqual([
      'Original native prompt',
      'Native answer',
    ]);
    expect(repaired?.entry).toMatchObject({
      id: entry.id,
      originalInstanceId: entry.originalInstanceId,
      historyThreadId: entry.historyThreadId,
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: 'Original native prompt',
      lastUserMessage: 'Original native prompt',
    });
    expect(fs.existsSync(`${archivePath}.missing-opening-prompt-backup`)).toBe(true);
  });

  it('repairs a provider-less legacy Claude archive after an explicit non-Claude collision', async () => {
    const sessionId = 'non-claude-session-collision';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const nonClaudeEntry = {
      id: 'codex-owned-archive',
      displayName: 'Codex archive',
      createdAt: Date.parse('2026-04-10T09:01:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:02:00.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 1,
      firstUserMessage: 'Codex-owned prompt',
      lastUserMessage: 'Codex-owned prompt',
      status: 'completed' as const,
      originalInstanceId: 'codex-instance',
      parentId: null,
      sessionId,
      provider: 'codex' as const,
    };
    const claudeEntry = {
      ...nonClaudeEntry,
      id: 'legacy-owned-archive',
      displayName: 'Legacy archive',
      firstUserMessage: 'Later Claude prompt',
      lastUserMessage: 'Later Claude prompt',
      originalInstanceId: 'claude-instance',
      provider: undefined,
    };
    const nonClaudeArchivePath = path.join(storageDir, `${nonClaudeEntry.id}.json.gz`);
    const claudeArchivePath = path.join(storageDir, `${claudeEntry.id}.json.gz`);
    const nonClaudeMessages = [
      {
        id: 'codex-u1',
        timestamp: nonClaudeEntry.createdAt,
        type: 'user',
        content: 'Codex-owned prompt',
      },
    ];
    const claudeMessages = [
      {
        id: 'claude-u2',
        timestamp: claudeEntry.createdAt,
        type: 'user',
        content: 'Later Claude prompt',
      },
    ];
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [nonClaudeEntry, claudeEntry], lastUpdated: 0 }),
    );
    const nonClaudeArchiveBytes = zlib.gzipSync(JSON.stringify({
      entry: nonClaudeEntry,
      messages: nonClaudeMessages,
    }));
    fs.writeFileSync(nonClaudeArchivePath, nonClaudeArchiveBytes);
    fs.writeFileSync(
      claudeArchivePath,
      zlib.gzipSync(JSON.stringify({ entry: claudeEntry, messages: claudeMessages })),
    );

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    const stableNonClaudeArchiveBytes = fs.readFileSync(nonClaudeArchivePath);

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Claude opening prompt' },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Claude answer' }] },
      },
    ]);

    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const preserved = await manager.loadConversation(nonClaudeEntry.id);
    expect(preserved?.messages).toEqual(nonClaudeMessages);
    expect(preserved?.entry).toMatchObject(nonClaudeEntry);
    expect(fs.readFileSync(nonClaudeArchivePath)).toEqual(stableNonClaudeArchiveBytes);
    expect(fs.existsSync(`${nonClaudeArchivePath}.missing-opening-prompt-backup`)).toBe(false);

    const repaired = await manager.loadConversation(claudeEntry.id);
    expect(repaired?.messages.map((message) => message.content)).toEqual([
      'Claude opening prompt',
      'Claude answer',
    ]);
    expect(repaired?.entry).toMatchObject({
      id: claudeEntry.id,
      originalInstanceId: claudeEntry.originalInstanceId,
      firstUserMessage: 'Claude opening prompt',
      messageCount: 2,
    });
    expect(fs.existsSync(`${claudeArchivePath}.missing-opening-prompt-backup`)).toBe(true);
  });

  it('leaves a non-tail app archive untouched when it still contains the native opening prompt', async () => {
    const sessionId = 'healthy-app-archive-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const entry = {
      id: 'healthy-app-archive',
      displayName: 'Healthy app archive',
      createdAt: Date.parse('2026-04-10T09:00:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:02:00.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 3,
      firstUserMessage: 'Original native prompt',
      lastUserMessage: 'Follow-up kept by app',
      status: 'completed' as const,
      originalInstanceId: 'healthy-instance',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    const archivePath = path.join(storageDir, `${entry.id}.json.gz`);
    const originalMessages = [
      { id: 'app-u1', timestamp: entry.createdAt, type: 'user', content: '  Original   native prompt  ' },
      { id: 'app-sidechain', timestamp: entry.createdAt + 1, type: 'assistant', content: 'Subagent-only activity' },
      { id: 'app-u2', timestamp: entry.endedAt, type: 'user', content: 'Follow-up kept by app' },
    ];
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(JSON.stringify({ entry, messages: originalMessages })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Original native prompt' },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Native answer' }] },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const preserved = await manager.loadConversation(entry.id);
    expect(preserved?.messages).toEqual(originalMessages);
    expect(preserved?.entry).toMatchObject(entry);
    expect(fs.existsSync(`${archivePath}.missing-opening-prompt-backup`)).toBe(false);
  });

  it('does not misclassify an indexed-context wrapper as a missing opening prompt', async () => {
    const sessionId = 'indexed-context-healthy-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const authoredPrompt = 'Fix session titles using the first authored message.';
    const entry = {
      id: 'indexed-context-healthy-archive',
      displayName: 'Existing title',
      createdAt: Date.parse('2026-08-28T09:00:00.000Z'),
      endedAt: Date.parse('2026-08-28T09:01:00.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: authoredPrompt,
      lastUserMessage: authoredPrompt,
      status: 'completed' as const,
      originalInstanceId: 'indexed-context-instance',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    const originalMessages = [
      { id: 'app-u1', timestamp: entry.createdAt, type: 'user', content: authoredPrompt },
      { id: 'app-a1', timestamp: entry.endedAt, type: 'assistant', content: 'Finished.' },
    ];
    const archivePath = path.join(storageDir, `${entry.id}.json.gz`);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(JSON.stringify({ entry, messages: originalMessages })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-08-28T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: {
          role: 'user',
          content: [
            '[Indexed Codebase Context]',
            'Source: Harness indexed codebase search',
            '- src/main/history/history-manager.ts:1',
            '[End Indexed Codebase Context]',
            '',
            authoredPrompt,
          ].join('\n'),
        },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-08-28T09:01:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'assistant', content: 'Finished.' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const preserved = await manager.loadConversation(entry.id);
    expect(preserved?.messages).toEqual(originalMessages);
    expect(preserved?.entry.firstUserMessage).toBe(authoredPrompt);
    expect(fs.existsSync(`${archivePath}.missing-opening-prompt-backup`)).toBe(false);
  });

  it('restores a false missing-opening repair from backup and retains its newer tail', async () => {
    const sessionId = 'indexed-context-recovery-session';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const authoredPrompt = 'Restore the authored opening prompt safely.';
    const contextWrappedPrompt = [
      '[Indexed Codebase Context]',
      'Source: Harness indexed codebase search',
      '- src/main/history/history-manager.ts:1',
      '[End Indexed Codebase Context]',
      '',
      authoredPrompt,
    ].join('\n');
    const backupEndedAt = Date.parse('2026-08-28T09:01:00.000Z');
    const entry = {
      id: 'indexed-context-recovery-archive',
      displayName: 'Existing title',
      aiTitle: 'Local title generated after repair',
      createdAt: Date.parse('2026-08-28T09:00:00.000Z'),
      endedAt: Date.parse('2026-08-28T09:02:00.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 3,
      firstUserMessage: contextWrappedPrompt,
      lastUserMessage: 'Newer follow-up',
      status: 'completed' as const,
      originalInstanceId: 'indexed-context-recovery-instance',
      parentId: null,
      sessionId,
      provider: 'claude' as const,
    };
    const currentMessages = [
      { id: 'native-u1', timestamp: entry.createdAt, type: 'user', content: contextWrappedPrompt },
      { id: 'native-a1', timestamp: backupEndedAt, type: 'assistant', content: 'Native answer.' },
      { id: 'native-u2', timestamp: entry.endedAt, type: 'user', content: 'Newer follow-up' },
    ];
    const backupEntry = {
      ...entry,
      aiTitle: undefined,
      endedAt: backupEndedAt,
      messageCount: 2,
      firstUserMessage: authoredPrompt,
      lastUserMessage: authoredPrompt,
    };
    const backupMessages = [
      { id: 'app-u1', timestamp: entry.createdAt, type: 'user', content: authoredPrompt },
      { id: 'app-a1', timestamp: backupEndedAt, type: 'assistant', content: 'App-owned answer.' },
    ];
    const archivePath = path.join(storageDir, `${entry.id}.json.gz`);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [entry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      archivePath,
      zlib.gzipSync(JSON.stringify({ entry, messages: currentMessages })),
    );
    fs.writeFileSync(
      `${archivePath}.missing-opening-prompt-backup`,
      zlib.gzipSync(JSON.stringify({ entry: backupEntry, messages: backupMessages })),
    );

    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${sessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'native-u1',
        timestamp: '2026-08-28T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: contextWrappedPrompt },
      },
      {
        type: 'assistant',
        uuid: 'native-a1',
        timestamp: '2026-08-28T09:01:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'assistant', content: 'Native answer.' },
      },
      {
        type: 'user',
        uuid: 'native-u2',
        timestamp: '2026-08-28T09:02:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'Newer follow-up' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const recovered = await manager.loadConversation(entry.id);
    expect(recovered?.messages).toEqual([
      ...backupMessages,
      currentMessages[2],
    ]);
    expect(recovered?.entry).toMatchObject({
      firstUserMessage: authoredPrompt,
      lastUserMessage: 'Newer follow-up',
      messageCount: 3,
      aiTitle: 'Local title generated after repair',
    });
  });

  it('keeps a native provider ID collision out of ownership across import and repeated restore', async () => {
    const providerSessionId = 'provider-native-collision';
    const projectsDir = path.join(homeDir, '.claude', 'projects');
    writeJsonl(path.join(projectsDir, '-Users-me-Demo', `${providerSessionId}.jsonl`), [
      {
        type: 'user',
        uuid: 'u-collision',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId: providerSessionId,
        message: { role: 'user', content: 'Verify canonical ownership' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const { HistoryRestoreCoordinator } = await import('../history-restore-coordinator');
    const { EvidenceConversationResolver } = await import('../../context-evidence/evidence-conversation-resolver');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(projectsDir);

    const imported = manager.getEntries()[0];
    expect(imported.historyThreadId).not.toBe(providerSessionId);
    const importedConversation = await manager.loadConversation(imported.id);
    expect(importedConversation).not.toBeNull();

    // Reproduce the persisted shape created by the old instance factories:
    // a nonblank historyThreadId copied directly from the provider session.
    const legacyEntry = { ...imported, historyThreadId: providerSessionId };
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [legacyEntry], lastUpdated: 0 }),
    );
    fs.writeFileSync(
      path.join(storageDir, `${legacyEntry.id}.json.gz`),
      zlib.gzipSync(JSON.stringify({ ...importedConversation, entry: legacyEntry })),
    );

    const migratedManager = new HistoryManager();
    await migratedManager.startupTasks;
    const migrated = migratedManager.getEntries()[0];
    expect(migrated.historyThreadId).not.toBe(providerSessionId);
    const createdInstances: Instance[] = [];
    const instanceManager = {
      createInstance: vi.fn(async (config: { historyThreadId?: string; initialOutputBuffer?: Instance['outputBuffer'] }) => {
        const instance = {
          id: `restored-${createdInstances.length + 1}`,
          historyThreadId: config.historyThreadId,
          sessionId: providerSessionId,
          providerSessionId,
          provider: 'claude',
          workingDirectory: '/Users/me/Demo',
          outputBuffer: config.initialOutputBuffer ?? [],
          status: 'idle',
          readyPromise: Promise.resolve(),
        } as Instance;
        createdInstances.push(instance);
        return instance;
      }),
      queueContinuityPreamble: vi.fn(),
    } as unknown as InstanceManager;
    const coordinator = new HistoryRestoreCoordinator({
      history: () => migratedManager,
      outputStorage: () => ({ storeMessages: vi.fn() }),
    });

    const first = await coordinator.restore(instanceManager, migrated.id, { forceFallback: true });
    const reloadedManager = new HistoryManager();
    await reloadedManager.startupTasks;
    const second = await new HistoryRestoreCoordinator({
      history: () => reloadedManager,
      outputStorage: () => ({ storeMessages: vi.fn() }),
    }).restore(instanceManager, migrated.id, { forceFallback: true });
    expect(first.historyThreadId).toBe(second.historyThreadId);
    expect(first.historyThreadId).not.toBe(providerSessionId);

    const collision = {
      id: providerSessionId,
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      metadata: { scope: 'instance', historyThreadId: providerSessionId },
    } as unknown as ConversationThreadRecord;
    const startConversation = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      ...collision,
      id: 'created-canonical',
      metadata: input.metadata,
    }));
    const resolver = new EvidenceConversationResolver({
      ledger: {
        getThread: vi.fn(async (id: string) => id === collision.id ? collision : null),
        listConversations: vi.fn(async () => [collision]),
        startConversation,
      },
    });
    const ownership = await resolver.resolve(createdInstances[0], { mode: 'enforce' });

    expect(ownership).toMatchObject({
      status: 'resolved',
      conversationId: 'created-canonical',
    });
    expect(startConversation).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ historyThreadId: first.historyThreadId }),
    }));
  });

  it('skips transcripts whose sessionId is already in the index', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const storageDir = path.join(userDataDir, 'conversation-history');
    fs.mkdirSync(storageDir, { recursive: true });

    const existingEntry = {
      id: 'orchestrator-uuid',
      displayName: 'orchestrator-archived',
      createdAt: 1,
      endedAt: 2,
      workingDirectory: '/Users/me/Demo',
      messageCount: 1,
      firstUserMessage: 'pre-existing',
      lastUserMessage: 'pre-existing',
      status: 'completed' as const,
      originalInstanceId: 'inst-1',
      sessionId,
    };
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [existingEntry], lastUpdated: 0 })
    );

    const transcriptPath = path.join(
      homeDir,
      '.claude',
      'projects',
      '-Users-me-Demo',
      `${sessionId}.jsonl`
    );
    writeJsonl(transcriptPath, [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId,
        message: { role: 'user', content: 'should NOT be imported as a duplicate' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe('orchestrator-uuid');
    expect(entries[0].firstUserMessage).toBe('pre-existing');
  });

  it('removes already imported transcripts from non-interactive Claude entrypoints', async () => {
    const sessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    const storageDir = path.join(userDataDir, 'conversation-history');
    const importedEntry = {
      id: sessionId,
      displayName: '[Demo] child helper',
      createdAt: Date.parse('2026-04-10T09:00:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:00:05.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: 'child helper prompt',
      lastUserMessage: 'child helper prompt',
      status: 'completed' as const,
      originalInstanceId: `imported-${sessionId}`,
      parentId: null,
      sessionId,
      provider: 'claude' as const,
      importSource: 'native-claude' as const,
    };
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [importedEntry], lastUpdated: 0 })
    );
    writeConversationFile(importedEntry);

    writeJsonl(
      path.join(homeDir, '.claude', 'projects', '-Users-me-Demo', `${sessionId}.jsonl`),
      [
        {
          type: 'user',
          uuid: 'u1',
          entrypoint: 'sdk-cli',
          timestamp: '2026-04-10T09:00:00.000Z',
          cwd: '/Users/me/Demo',
          sessionId,
          message: { role: 'user', content: 'child helper prompt' },
        },
        {
          type: 'assistant',
          uuid: 'a1',
          entrypoint: 'sdk-cli',
          timestamp: '2026-04-10T09:00:05.000Z',
          cwd: '/Users/me/Demo',
          sessionId,
          message: { role: 'assistant', content: [{ type: 'text', text: 'helper reply' }] },
        },
      ]
    );

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    expect(manager.getEntries()).toHaveLength(0);
    expect(fs.existsSync(path.join(storageDir, `${sessionId}.json.gz`))).toBe(false);
  });

  it('imports only the latest native transcript when older session files are prefixes', async () => {
    const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-me-Demo');
    const olderSessionId = '10000000-0000-0000-0000-000000000000';
    const latestSessionId = '20000000-0000-0000-0000-000000000000';
    const sharedPrefix = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId: olderSessionId,
        message: { role: 'user', content: 'Fix the duplicated rail sessions' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        cwd: '/Users/me/Demo',
        sessionId: olderSessionId,
        message: { role: 'assistant', content: 'I can inspect that.' },
      },
    ];

    writeJsonl(path.join(projectDir, `${olderSessionId}.jsonl`), sharedPrefix);
    writeJsonl(path.join(projectDir, `${latestSessionId}.jsonl`), [
      ...sharedPrefix.map((line) => ({ ...line, sessionId: latestSessionId })),
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-04-10T09:01:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId: latestSessionId,
        message: { role: 'user', content: 'Keep going.' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(latestSessionId);
    expect(entries[0].messageCount).toBe(3);
  });

  it('removes already imported native transcript prefixes from the history index', async () => {
    const projectDir = path.join(homeDir, '.claude', 'projects', '-Users-me-Demo');
    const storageDir = path.join(userDataDir, 'conversation-history');
    const olderSessionId = '30000000-0000-0000-0000-000000000000';
    const latestSessionId = '40000000-0000-0000-0000-000000000000';
    const olderEntry = {
      id: olderSessionId,
      displayName: '[Demo] Fix duplicates',
      createdAt: Date.parse('2026-04-10T09:00:00.000Z'),
      endedAt: Date.parse('2026-04-10T09:00:05.000Z'),
      workingDirectory: '/Users/me/Demo',
      messageCount: 2,
      firstUserMessage: 'Fix duplicates',
      lastUserMessage: 'Fix duplicates',
      status: 'completed' as const,
      originalInstanceId: `imported-${olderSessionId}`,
      parentId: null,
      sessionId: olderSessionId,
      provider: 'claude' as const,
    };
    const latestEntry = {
      ...olderEntry,
      id: latestSessionId,
      endedAt: Date.parse('2026-04-10T09:01:00.000Z'),
      messageCount: 3,
      originalInstanceId: `imported-${latestSessionId}`,
      sessionId: latestSessionId,
    };

    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(
      path.join(storageDir, 'index.json'),
      JSON.stringify({ version: 1, entries: [latestEntry, olderEntry], lastUpdated: 0 })
    );
    writeConversationFile(olderEntry);
    writeConversationFile(latestEntry);

    const sharedPrefix = [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-10T09:00:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId: olderSessionId,
        message: { role: 'user', content: 'Fix duplicates' },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-10T09:00:05.000Z',
        cwd: '/Users/me/Demo',
        sessionId: olderSessionId,
        message: { role: 'assistant', content: 'Working on it.' },
      },
    ];
    writeJsonl(path.join(projectDir, `${olderSessionId}.jsonl`), sharedPrefix);
    writeJsonl(path.join(projectDir, `${latestSessionId}.jsonl`), [
      ...sharedPrefix.map((line) => ({ ...line, sessionId: latestSessionId })),
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-04-10T09:01:00.000Z',
        cwd: '/Users/me/Demo',
        sessionId: latestSessionId,
        message: { role: 'user', content: 'Keep going.' },
      },
    ]);

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    const entries = manager.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe(latestSessionId);
    expect(fs.existsSync(path.join(storageDir, `${olderSessionId}.json.gz`))).toBe(false);
    expect(fs.existsSync(path.join(storageDir, `${latestSessionId}.json.gz`))).toBe(true);
  });

  it('imports multiple transcripts across multiple project subdirectories', async () => {
    const sessions = [
      { id: '11111111-1111-1111-1111-111111111111', cwd: '/Users/me/A', dir: '-Users-me-A' },
      { id: '22222222-2222-2222-2222-222222222222', cwd: '/Users/me/B', dir: '-Users-me-B' },
      { id: '33333333-3333-3333-3333-333333333333', cwd: '/Users/me/A', dir: '-Users-me-A' },
    ];

    for (const s of sessions) {
      writeJsonl(
        path.join(homeDir, '.claude', 'projects', s.dir, `${s.id}.jsonl`),
        [
          {
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-04-10T09:00:00.000Z',
            cwd: s.cwd,
            sessionId: s.id,
            message: { role: 'user', content: `prompt for ${s.id}` },
          },
        ]
      );
    }

    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();
    await manager.startupTasks;
    await (manager as unknown as {
      importNativeClaudeTranscripts: (projectsDir: string) => Promise<void>;
    }).importNativeClaudeTranscripts(path.join(homeDir, '.claude', 'projects'));

    const entries = manager.getEntries();
    expect(entries).toHaveLength(3);
    const ids = entries.map((e) => e.sessionId).sort();
    expect(ids).toEqual(sessions.map((s) => s.id).sort());
  });
});
