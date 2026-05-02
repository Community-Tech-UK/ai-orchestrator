import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(entry.workingDirectory).toBe('/Users/me/Demo');
    expect(entry.firstUserMessage).toContain('Initial question');
    expect(entry.messageCount).toBe(2);
    expect(entry.provider).toBe('claude');
    expect(entry.status).toBe('completed');
    expect((entry as { importSource?: string }).importSource).toBe('native-claude');

    const conversation = await manager.loadConversation(entry.id);
    expect(conversation).not.toBeNull();
    expect(conversation!.messages).toHaveLength(2);
    expect(conversation!.messages[0].type).toBe('user');
    expect(conversation!.messages[1].type).toBe('assistant');
    expect(conversation!.messages[1].content).toBe('Here is the answer.');
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
