import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../../../shared/types/rlm.types';

const { loggerInfo, loggerError } = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: loggerInfo,
    warn: vi.fn(),
    debug: vi.fn(),
    error: loggerError,
  }),
}));

import {
  executeGrep,
  executeSemanticSearch,
  executeSlice,
  getSection,
  searchStoreOptimized,
} from './context-search';
import {
  getRecallTraceStore,
  _resetRecallTraceStoreForTesting,
} from '../../memory/retrieval-eval/recall-trace-store';
import { beforeEach } from 'vitest';

describe('executeGrep', () => {
  it('returns lexical matches from the in-memory section content', () => {
    const result = executeGrep(storeWithContent('the retirement keeps lexical retrieval working'), {
      pattern: 'lexical',
      maxResults: 1,
    }, 30);

    expect(result.sectionsAccessed).toEqual(['section-1']);
    expect(result.result).toContain('lexical retrieval');
  });
});

describe('lexical queries without the retired term index', () => {
  it('preserves grep, optimized search, slice, and section retrieval while lazily building Bloom', () => {
    const store: ContextStore = {
      id: 'store-lexical',
      instanceId: 'instance-lexical',
      sections: [
        {
          id: 'section-retry',
          type: 'file',
          name: 'retry.ts',
          content: 'retry policy retries failed requests',
          tokens: 6,
          startOffset: 0,
          endOffset: 36,
          checksum: 'retry-checksum',
          depth: 0,
        },
        {
          id: 'section-summary',
          type: 'summary',
          name: 'retry-summary',
          content: 'retry appears only in this summary',
          tokens: 6,
          startOffset: 36,
          endOffset: 70,
          checksum: 'summary-checksum',
          depth: 1,
        },
      ],
      totalTokens: 12,
      totalSize: 70,
      createdAt: 1,
      lastAccessed: 1,
      accessCount: 0,
    };

    expect(store).not.toHaveProperty('searchIndex');
    expect(executeGrep(store, { pattern: 'retry', maxResults: 10 }, 20)).toEqual({
      result: '[Match 1] retry.ts (file):\n...retry policy retries fail...',
      sectionsAccessed: ['section-retry'],
    });
    expect(store.bloomFilter).toBeUndefined();
    expect(searchStoreOptimized(store, ['retry'], 10, 20)).toEqual({
      result: '[Match 1] retry.ts (file):\n...retry policy retries fail...',
      sectionsAccessed: ['section-retry'],
    });
    expect(store.bloomFilter).toBeDefined();
    expect(searchStoreOptimized(store, ['retr.*'], 10, 20)).toEqual({
      result: '[Match 1] retry.ts (file):\n...retry policy retries failed requests...',
      sectionsAccessed: ['section-retry'],
    });
    expect(searchStoreOptimized(store, ['re'], 1, 20)).toEqual({
      result: '[Match 1] retry.ts (file):\n...retry policy retries f...',
      sectionsAccessed: ['section-retry'],
    });
    expect(searchStoreOptimized(store, ['retr'], 1, 20)).toEqual({
      result: '[Match 1] retry.ts (file):\n...retry policy retries fai...',
      sectionsAccessed: ['section-retry'],
    });
    expect(executeSlice(store, { start: 6, end: 18 })).toEqual({
      result: 'policy retri',
      sectionsAccessed: ['section-retry'],
    });
    expect(getSection(store, 'section-retry')).toEqual({
      result: '[retry.ts] (6 tokens)\n\nretry policy retries failed requests',
      sectionsAccessed: ['section-retry'],
    });
  });
});

function storeWithContent(content: string): ContextStore {
  return {
    id: 'store-1',
    instanceId: 'instance-1',
    sections: [{
      id: 'section-1',
      type: 'file',
      name: 'example.ts',
      content,
      tokens: 8,
      startOffset: 0,
      endOffset: content.length,
      checksum: 'checksum',
      depth: 0,
    }],
    totalTokens: 8,
    totalSize: content.length,
    createdAt: 1,
    lastAccessed: 1,
    accessCount: 0,
  };
}

describe('executeSemanticSearch RLM recall trace (WS16)', () => {
  beforeEach(() => _resetRecallTraceStoreForTesting());

  function twoSectionStore(): ContextStore {
    const base = storeWithContent('alpha section content');
    return {
      ...base,
      sections: [
        { ...base.sections[0], id: 'sec-a', name: 'a.ts' },
        { ...base.sections[0], id: 'sec-b', name: 'b.ts' },
      ],
    };
  }

  it('records a rlm trace with scored section hits from the vector store', async () => {
    const store = twoSectionStore();
    const vectorStore = {
      search: async () => [
        { entry: { sectionId: 'sec-a', contentPreview: 'a' }, similarity: 0.91 },
        { entry: { sectionId: 'sec-b', contentPreview: 'b' }, similarity: 0.72 },
        { entry: { sectionId: 'ghost', contentPreview: 'x' }, similarity: 0.6 },
      ],
    };
    await executeSemanticSearch(
      store,
      { query: 'find alpha', topK: 5, minSimilarity: 0.5, useHyDE: false },
      { vectorStore: vectorStore as never, hydeService: null, searchWindowSize: 30 },
    );

    const traces = getRecallTraceStore().bySurface('rlm');
    expect(traces).toHaveLength(1);
    // Ghost section (not in store) is filtered out of the trace.
    expect(traces[0].returned).toEqual([
      { id: 'sec-a', score: 0.91 },
      { id: 'sec-b', score: 0.72 },
    ]);
  });

  it('does not record a trace when the vector store is unavailable (grep fallback)', async () => {
    await executeSemanticSearch(
      storeWithContent('alpha lexical fallback content'),
      { query: 'alpha lexical', topK: 3, minSimilarity: 0.5, useHyDE: false },
      { vectorStore: null, hydeService: null, searchWindowSize: 30 },
    );
    expect(getRecallTraceStore().bySurface('rlm')).toHaveLength(0);
  });
});

// LT-055: a `semantic_search` that degrades to keyword matching used to do so
// with NO signal at all — a caller had no way to tell "genuinely no semantic
// hits" apart from "vector search never ran for this store". Both fallback
// paths must now log observably.
describe('executeSemanticSearch — LT-055 degradation is observable', () => {
  beforeEach(() => {
    loggerInfo.mockClear();
    loggerError.mockClear();
  });

  it('logs when there is no vector store attached at all', async () => {
    await executeSemanticSearch(
      storeWithContent('alpha lexical fallback content'),
      { query: 'alpha lexical', topK: 3, minSimilarity: 0.5, useHyDE: false },
      { vectorStore: null, hydeService: null, searchWindowSize: 30 },
    );

    expect(loggerInfo).toHaveBeenCalledWith(
      'No vector store attached; semantic_search running as keyword search',
      expect.objectContaining({ storeId: 'store-1' }),
    );
  });

  it('logs when a vector store is attached but genuinely returns zero matches', async () => {
    const vectorStore = { search: async () => [] };

    await executeSemanticSearch(
      storeWithContent('alpha lexical fallback content'),
      { query: 'alpha lexical', topK: 3, minSimilarity: 0.5, useHyDE: false },
      { vectorStore: vectorStore as never, hydeService: null, searchWindowSize: 30 },
    );

    expect(loggerInfo).toHaveBeenCalledWith(
      'Semantic search returned no vector matches; falling back to keyword search',
      expect.objectContaining({ storeId: 'store-1' }),
    );
  });

  it('does not log the zero-matches degradation line when real matches are found', async () => {
    const vectorStore = {
      search: async () => [{ entry: { sectionId: 'section-1', contentPreview: 'a' }, similarity: 0.9 }],
    };

    await executeSemanticSearch(
      storeWithContent('alpha lexical fallback content'),
      { query: 'alpha lexical', topK: 3, minSimilarity: 0.5, useHyDE: false },
      { vectorStore: vectorStore as never, hydeService: null, searchWindowSize: 30 },
    );

    expect(loggerInfo).not.toHaveBeenCalledWith(
      'Semantic search returned no vector matches; falling back to keyword search',
      expect.anything(),
    );
  });
});
