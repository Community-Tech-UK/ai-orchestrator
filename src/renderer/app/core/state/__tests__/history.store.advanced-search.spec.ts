import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdvancedHistorySearchResult,
  ConversationHistoryEntry,
  HistorySnippet,
} from '../../../../../shared/types/history.types';
import { HistoryIpcService } from '../../services/ipc/history-ipc.service';
import { HistoryStore } from '../history.store';

function entry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: 'entry-1',
    displayName: 'Auth thread',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/repo',
    messageCount: 2,
    firstUserMessage: 'Review auth',
    lastUserMessage: 'Fix auth',
    status: 'completed',
    originalInstanceId: 'old-1',
    parentId: null,
    sessionId: 'session-1',
    ...overrides,
  };
}

class MockHistoryIpcService {
  searchHistoryAdvanced = vi.fn(async () => ({
    success: true,
    data: {
      entries: [entry({ provider: 'codex' })],
      recallResults: [],
      page: { pageNumber: 1, pageSize: 10, totalCount: 1, totalPages: 1 },
    } satisfies AdvancedHistorySearchResult,
  }));
  expandHistorySnippets = vi.fn(async () => ({
    success: true,
    data: [{ position: 3, excerpt: 'auth bug', score: 1 }] satisfies HistorySnippet[],
  }));
}

describe('HistoryStore advanced search', () => {
  let ipc: MockHistoryIpcService;

  beforeEach(() => {
    ipc = new MockHistoryIpcService();
    TestBed.configureTestingModule({
      providers: [
        HistoryStore,
        { provide: HistoryIpcService, useValue: ipc },
      ],
    });
  });

  it('stores normalized advanced search results and page state', async () => {
    const store = TestBed.inject(HistoryStore);

    const result = await store.searchAdvanced({
      searchQuery: 'auth',
      source: 'history-transcript',
      page: { pageNumber: 1, pageSize: 10 },
    });

    expect(result?.entries[0]?.provider).toBe('codex');
    expect(store.advancedSearchResult()?.page.totalCount).toBe(1);
    expect(store.advancedSearchLoading()).toBe(false);
    expect(ipc.searchHistoryAdvanced).toHaveBeenCalledWith({
      searchQuery: 'auth',
      source: 'history-transcript',
      page: { pageNumber: 1, pageSize: 10 },
    });
  });

  it('stores expanded snippets by entry id', async () => {
    const store = TestBed.inject(HistoryStore);

    const snippets = await store.expandSnippets('entry-1', 'auth');

    expect(snippets).toEqual([{ position: 3, excerpt: 'auth bug', score: 1 }]);
    expect(store.expandedSnippets()['entry-1']).toEqual(snippets);
    expect(ipc.expandHistorySnippets).toHaveBeenCalledWith('entry-1', 'auth');
  });
});
