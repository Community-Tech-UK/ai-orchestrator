import { describe, expect, it } from 'vitest';
import type { ContextStore } from '../../../shared/types/rlm.types';
import { executeGrep, executeSemanticSearch } from './context-search';
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