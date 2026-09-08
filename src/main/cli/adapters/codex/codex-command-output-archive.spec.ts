import { mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveCodexCommandOutputNotification,
  cleanupExpiredCodexCommandOutputArchives,
  setCodexCommandOutputArchiveDirForTesting,
} from './codex-command-output-archive';

describe('codex command-output archive', () => {
  let dir: string;

  afterEach(() => {
    setCodexCommandOutputArchiveDirForTesting(null);
  });

  function useTempArchive(): string {
    dir = mkdtempSync(join(tmpdir(), 'aio-codex-cmd-archive-'));
    setCodexCommandOutputArchiveDirForTesting(dir);
    return dir;
  }

  it('write-through archives commandExecution output deltas with owner-only mode', () => {
    const archiveDir = useTempArchive();

    archiveCodexCommandOutputNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-secret',
        itemId: 'item-1',
        delta: 'first chunk\n',
      },
    });
    archiveCodexCommandOutputNotification({
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'thread-secret',
        itemId: 'item-1',
        delta: 'second chunk\n',
      },
    });

    const files = readdirSync(archiveDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('thread-secret');
    const filePath = join(archiveDir, files[0]!);
    const body = readFileSync(filePath, 'utf8');
    expect(body).toBe('first chunk\nsecond chunk\n');
    if (process.platform !== 'win32') {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  it('falls back to aggregated command output when no deltas arrived', () => {
    const archiveDir = useTempArchive();

    archiveCodexCommandOutputNotification({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        item: {
          id: 'cmd-9',
          type: 'commandExecution',
          aggregatedOutput: 'full command output',
        },
      },
    });

    const files = readdirSync(archiveDir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(archiveDir, files[0]!), 'utf8');
    expect(body).toBe('full command output');
  });

  it('does not duplicate aggregated output after deltas were archived', () => {
    const archiveDir = useTempArchive();

    archiveCodexCommandOutputNotification({
      method: 'item/commandExecution/outputDelta',
      params: { threadId: 't', itemId: 'i', delta: 'streamed' },
    });
    archiveCodexCommandOutputNotification({
      method: 'item/completed',
      params: {
        threadId: 't',
        item: { id: 'i', type: 'commandExecution', aggregatedOutput: 'streamed plus extra' },
      },
    });

    const files = readdirSync(archiveDir);
    expect(files).toHaveLength(1);
    const body = readFileSync(join(archiveDir, files[0]!), 'utf8');
    expect(body).toBe('streamed');
  });

  it('deletes archives older than the 7-day TTL', async () => {
    const archiveDir = useTempArchive();
    const stalePath = join(archiveDir, 'stale.log');
    writeFileSync(stalePath, 'old', { mode: 0o600 });
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(stalePath, eightDaysAgo, eightDaysAgo);

    const deleted = await cleanupExpiredCodexCommandOutputArchives();
    expect(deleted).toBe(1);
    expect(readdirSync(archiveDir)).toEqual([]);
  });

  it('ignores file-change deltas', () => {
    const archiveDir = useTempArchive();
    archiveCodexCommandOutputNotification({
      method: 'item/fileChange/outputDelta',
      params: { threadId: 't', itemId: 'i', delta: 'patch' },
    });
    expect(readdirSync(archiveDir)).toEqual([]);
  });
});
