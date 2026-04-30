import { describe, expect, it, vi } from 'vitest';

import type { AutomationStore } from '../../automations/automation-store';
import type { ChildResultStorage } from '../../orchestration/child-result-storage';
import type { ConversationHistoryEntry } from '../../../shared/types/history.types';
import type { AgentTreePersistence } from '../agent-tree-persistence';
import type { SessionArchiveManager } from '../session-archive';
import { SessionRecallService } from '../session-recall-service';

function makeEntry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: overrides.id ?? 'history-1',
    displayName: overrides.displayName ?? 'Auth thread',
    createdAt: overrides.createdAt ?? 100,
    endedAt: overrides.endedAt ?? 200,
    workingDirectory: overrides.workingDirectory ?? '/repo',
    messageCount: overrides.messageCount ?? 2,
    firstUserMessage: overrides.firstUserMessage ?? 'auth failed',
    lastUserMessage: overrides.lastUserMessage ?? 'fixed auth',
    status: overrides.status ?? 'completed',
    originalInstanceId: overrides.originalInstanceId ?? 'inst-1',
    parentId: overrides.parentId ?? null,
    sessionId: overrides.sessionId ?? 'session-1',
    historyThreadId: overrides.historyThreadId ?? 'thread-1',
    provider: overrides.provider ?? 'claude',
    currentModel: overrides.currentModel ?? 'opus',
    snippets: overrides.snippets ?? [
      { position: 1, excerpt: 'auth token refresh bug fixed', score: 0.9 },
    ],
    ...overrides,
  };
}

function makeService(entries: ConversationHistoryEntry[]): SessionRecallService {
  return new SessionRecallService(
    { listRuns: vi.fn(() => []) } as unknown as AutomationStore,
    { listSnapshots: vi.fn(async () => []) } as unknown as AgentTreePersistence,
    {
      getAllResults: vi.fn(async () => []),
      getResultsForParent: vi.fn(async () => []),
    } as unknown as ChildResultStorage,
    () => ({ listArchivedSessions: vi.fn(() => []) }) as unknown as SessionArchiveManager,
    () => ({
      getEntries: vi.fn(() => entries),
    }),
  );
}

describe('SessionRecallService history-transcript source', () => {
  it('does not return history-transcript results unless explicitly enabled', async () => {
    const service = makeService([makeEntry()]);

    const results = await service.search({
      query: 'auth',
      sources: ['history-transcript'],
    });

    expect(results).toEqual([]);
  });

  it('returns transcript snippet matches when enabled', async () => {
    const service = makeService([makeEntry()]);

    const results = await service.search({
      query: 'auth',
      sources: ['history-transcript'],
      includeHistoryTranscripts: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      source: 'history-transcript',
      id: 'history-1:1',
      metadata: {
        entryId: 'history-1',
        position: 1,
        excerpt: 'auth token refresh bug fixed',
      },
    });
  });

  it('caps history-transcript results', async () => {
    const entries = Array.from({ length: 20 }, (_, index) => makeEntry({
      id: `history-${index}`,
      snippets: [{ position: index, excerpt: `auth item ${index}`, score: 1 }],
    }));
    const service = makeService(entries);

    const results = await service.search({
      query: 'auth',
      sources: ['history-transcript'],
      includeHistoryTranscripts: true,
      maxHistoryTranscriptResults: 10,
      limit: 50,
    });

    expect(results).toHaveLength(10);
  });

  it('filters history transcript results with normalized repository paths', async () => {
    const service = makeService([
      makeEntry({ id: 'same', workingDirectory: '/tmp/repo' }),
      makeEntry({ id: 'other', workingDirectory: '/tmp/repo-other' }),
    ]);

    const results = await service.search({
      query: 'auth',
      repositoryPath: '/tmp/repo/',
      sources: ['history-transcript'],
      includeHistoryTranscripts: true,
      limit: 10,
    });

    expect(results.map(result => result.metadata?.['entryId'])).toEqual(['same']);
  });
});
