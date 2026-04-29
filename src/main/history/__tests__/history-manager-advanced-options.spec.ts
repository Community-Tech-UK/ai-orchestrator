import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConversationHistoryEntry } from '../../../shared/types/history.types';

function entry(overrides: Partial<ConversationHistoryEntry>): ConversationHistoryEntry {
  return {
    id: overrides.id ?? 'entry',
    displayName: overrides.displayName ?? 'Entry',
    createdAt: overrides.createdAt ?? 1,
    endedAt: overrides.endedAt ?? 2,
    workingDirectory: overrides.workingDirectory ?? '/tmp/project',
    messageCount: overrides.messageCount ?? 1,
    firstUserMessage: overrides.firstUserMessage ?? 'first',
    lastUserMessage: overrides.lastUserMessage ?? 'last',
    status: overrides.status ?? 'completed',
    originalInstanceId: overrides.originalInstanceId ?? `instance-${overrides.id ?? 'entry'}`,
    parentId: overrides.parentId ?? null,
    sessionId: overrides.sessionId ?? `session-${overrides.id ?? 'entry'}`,
    ...overrides,
  };
}

function seedIndex(userDataDir: string, entries: ConversationHistoryEntry[]): void {
  const storageDir = path.join(userDataDir, 'conversation-history');
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(
    path.join(storageDir, 'index.json'),
    JSON.stringify({ version: 1, lastUpdated: Date.now(), entries }, null, 2),
  );
}

describe('HistoryManager.getEntries advanced options', () => {
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-manager-advanced-'));
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

  it('paginates with a clamped page request', async () => {
    seedIndex(
      userDataDir,
      Array.from({ length: 25 }, (_, index) => entry({
        id: `entry-${index}`,
        endedAt: 1000 - index,
      })),
    );
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    const page1 = manager.getEntries({ page: { pageSize: 10, pageNumber: 1 } });
    const page2 = manager.getEntries({ page: { pageSize: 10, pageNumber: 2 } });

    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    expect(page1[0]?.id).not.toBe(page2[0]?.id);
  });

  it('counts filtered entries without pagination', async () => {
    seedIndex(
      userDataDir,
      Array.from({ length: 12 }, (_, index) => entry({
        id: `entry-${index}`,
        workingDirectory: index < 8 ? '/tmp/a' : '/tmp/b',
      })),
    );
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.countEntries({
      workingDirectory: '/tmp/a',
      page: { pageSize: 2, pageNumber: 1 },
    })).toBe(8);
  });

  it('filters by timeRange', async () => {
    seedIndex(userDataDir, [
      entry({ id: 'old', endedAt: 1000 }),
      entry({ id: 'recent', endedAt: 9_000_000 }),
    ]);
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.getEntries({ timeRange: { from: 5000 } }).map(item => item.id))
      .toEqual(['recent']);
  });

  it('filters by projectScope=current when workingDirectory is provided', async () => {
    seedIndex(userDataDir, [
      entry({ id: 'a', workingDirectory: '/tmp/a' }),
      entry({ id: 'b', workingDirectory: '/tmp/b' }),
    ]);
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.getEntries({ workingDirectory: '/tmp/a', projectScope: 'current' }).map(item => item.id))
      .toEqual(['a']);
  });

  it('projectScope=all ignores the workingDirectory filter', async () => {
    seedIndex(userDataDir, [
      entry({ id: 'a', workingDirectory: '/tmp/a' }),
      entry({ id: 'b', workingDirectory: '/tmp/b' }),
    ]);
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.getEntries({ workingDirectory: '/tmp/a', projectScope: 'all' }))
      .toHaveLength(2);
  });

  it('snippetQuery matches precomputed snippets', async () => {
    seedIndex(userDataDir, [
      entry({ id: 'a', snippets: [{ position: 1, excerpt: 'auth bug fixed', score: 0.9 }] }),
      entry({ id: 'b', snippets: [{ position: 0, excerpt: 'layout tweaks', score: 0.5 }] }),
    ]);
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.getEntries({ snippetQuery: 'auth' }).map(item => item.id))
      .toEqual(['a']);
  });

  it('returns no history entries when source excludes history-backed sources', async () => {
    seedIndex(userDataDir, [
      entry({ id: 'a', snippets: [{ position: 1, excerpt: 'auth bug fixed', score: 0.9 }] }),
    ]);
    const { HistoryManager } = await import('../history-manager');
    const manager = new HistoryManager();

    expect(manager.getEntries({ source: 'child_result' })).toEqual([]);
  });
});
