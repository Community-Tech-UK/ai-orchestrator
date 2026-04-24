import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CodexSessionScanner } from './session-scanner';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('CodexSessionScanner', () => {
  let scanner: CodexSessionScanner;
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-scanner-test-'));
    sessionsDir = join(tempDir, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    scanner = new CodexSessionScanner(sessionsDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createRolloutFile(datePath: string, filename: string, entries: object[]): string {
    const dir = join(sessionsDir, datePath);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    const content = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(filePath, content);
    return filePath;
  }

  it('should find a session matching workspace path', async () => {
    createRolloutFile('2026/04/09', 'rollout-abc123.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_abc123' },
    ]);
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe('thread_abc123');
    expect(result!.workspacePath).toBe('/projects/my-app');
    expect(result!.model).toBe('gpt-5.5');
  });

  it('should return null when no session matches', async () => {
    createRolloutFile('2026/04/09', 'rollout-abc123.jsonl', [
      { type: 'session_meta', cwd: '/projects/other-app' },
    ]);
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });

  it('should return the newest matching session when multiple exist', async () => {
    const oldPath = createRolloutFile('2026/04/08', 'rollout-old.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.3' },
      { type: 'event_msg', threadId: 'thread_old' },
    ]);
    const newPath = createRolloutFile('2026/04/09', 'rollout-new.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_new' },
    ]);
    // Pin mtimes explicitly. Linux tmpfs / ext4 can give both files identical
    // mtimeMs when they're written back-to-back, making the "newest" sort order
    // nondeterministic. Give the files a guaranteed 60s gap.
    const now = Date.now() / 1000;
    utimesSync(oldPath, now - 60, now - 60);
    utimesSync(newPath, now, now);
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).not.toBeNull();
    expect(result!.threadId).toBe('thread_new');
  });

  it('should handle corrupt/empty JSONL files gracefully', async () => {
    const dir = join(sessionsDir, '2026/04/09');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rollout-bad.jsonl'), 'not json\n{broken\n');
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });

  it('should extract token usage from event_msg entries', async () => {
    createRolloutFile('2026/04/09', 'rollout-tokens.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_tok', subtype: 'token_count', input_tokens: 1500, output_tokens: 500, cached_tokens: 200, reasoning_tokens: 100 },
    ]);
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).not.toBeNull();
    expect(result!.tokenUsage).toEqual({ input: 1500, output: 500, cached: 200, reasoning: 100 });
  });

  it('should cache results and return cached on second call', async () => {
    createRolloutFile('2026/04/09', 'rollout-cached.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_cached' },
    ]);
    const result1 = await scanner.findSessionForWorkspace('/projects/my-app');
    const result2 = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result1).toEqual(result2);
  });

  it('should return null after cache invalidation', async () => {
    createRolloutFile('2026/04/09', 'rollout-inv.jsonl', [
      { type: 'session_meta', cwd: '/projects/my-app', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_inv' },
    ]);
    await scanner.findSessionForWorkspace('/projects/my-app');
    scanner.invalidateCache('/projects/my-app');
    rmSync(join(sessionsDir, '2026/04/09/rollout-inv.jsonl'));
    const result = await scanner.findSessionForWorkspace('/projects/my-app');
    expect(result).toBeNull();
  });

  it('matches Windows workspace paths across separator and case differences', async () => {
    createRolloutFile('2026/04/09', 'rollout-win.jsonl', [
      { type: 'session_meta', cwd: 'C:\\Users\\Alice\\Work\\My-App', model: 'gpt-5.5' },
      { type: 'event_msg', threadId: 'thread_windows' },
    ]);

    const result = await scanner.findSessionForWorkspace('c:/users/alice/work/my-app/');

    expect(result).not.toBeNull();
    expect(result!.threadId).toBe('thread_windows');
  });
});
