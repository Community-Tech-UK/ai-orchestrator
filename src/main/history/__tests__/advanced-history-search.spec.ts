import { describe, expect, it, vi } from 'vitest';

import {
  AdvancedHistorySearchService,
} from '../advanced-history-search';
import type { ConversationHistoryEntry } from '../../../shared/types/history.types';
import type { SessionRecallResult } from '../../../shared/types/session-recall.types';

function entry(id: string): ConversationHistoryEntry {
  return {
    id,
    displayName: `Entry ${id}`,
    createdAt: 100,
    endedAt: 200,
    workingDirectory: '/repo',
    messageCount: 1,
    firstUserMessage: 'auth failed',
    lastUserMessage: 'auth fixed',
    status: 'completed',
    originalInstanceId: `inst-${id}`,
    parentId: null,
    sessionId: `session-${id}`,
    snippets: [{ position: 0, excerpt: 'auth bug fixed', score: 1 }],
  };
}

describe('AdvancedHistorySearchService', () => {
  it('uses only HistoryManager for history-transcript-only searches', async () => {
    const history = {
      getEntries: vi.fn(() => [entry('a')]),
      countEntries: vi.fn(() => 1),
    };
    const recall = {
      search: vi.fn(async () => {
        throw new Error('recall should not be called');
      }),
    };
    const service = new AdvancedHistorySearchService(history, recall);

    const result = await service.search({
      snippetQuery: 'auth',
      source: 'history-transcript',
    });

    expect(result.entries.map(item => item.id)).toEqual(['a']);
    expect(result.recallResults).toEqual([]);
    expect(recall.search).not.toHaveBeenCalled();
  });

  it('delegates mixed non-history sources to SessionRecallService with transcripts disabled', async () => {
    const recallResult: SessionRecallResult = {
      source: 'child_result',
      id: 'result-1',
      title: 'Child result',
      summary: 'auth fix',
      score: 1,
      timestamp: 300,
    };
    const history = {
      getEntries: vi.fn(() => [entry('a')]),
      countEntries: vi.fn(() => 1),
    };
    const recall = {
      search: vi.fn(async () => [recallResult]),
    };
    const service = new AdvancedHistorySearchService(history, recall);

    const result = await service.search({
      searchQuery: 'auth',
      source: ['child_result', 'history-transcript'],
    });

    expect(result.recallResults).toEqual([recallResult]);
    expect(recall.search).toHaveBeenCalledWith(expect.objectContaining({
      includeHistoryTranscripts: false,
      sources: ['child_result'],
      query: 'auth',
    }));
  });

  it('returns total count separately from the page slice', async () => {
    const history = {
      getEntries: vi.fn(() => [entry('a')]),
      countEntries: vi.fn(() => 25),
    };
    const service = new AdvancedHistorySearchService(history, {
      search: vi.fn(async () => []),
    });

    const result = await service.search({ page: { pageSize: 10, pageNumber: 1 } });

    expect(result.page).toEqual({
      pageNumber: 1,
      pageSize: 10,
      totalCount: 25,
      totalPages: 3,
    });
  });

  it('deduplicates recall results that point at an already-returned history entry', async () => {
    const history = {
      getEntries: vi.fn(() => [entry('a')]),
      countEntries: vi.fn(() => 1),
    };
    const recall = {
      search: vi.fn(async () => [
        {
          source: 'child_result',
          id: 'result-1',
          title: 'Child result',
          summary: 'same thread',
          score: 1,
          timestamp: 300,
          metadata: { entryId: 'a' },
        } satisfies SessionRecallResult,
        {
          source: 'child_result',
          id: 'result-2',
          title: 'Other child result',
          summary: 'other thread',
          score: 1,
          timestamp: 301,
        } satisfies SessionRecallResult,
      ]),
    };
    const service = new AdvancedHistorySearchService(history, recall);

    const result = await service.search({
      snippetQuery: 'auth',
      source: ['history-transcript', 'child_result'],
    });

    expect(result.recallResults.map(item => item.id)).toEqual(['result-2']);
  });
});
