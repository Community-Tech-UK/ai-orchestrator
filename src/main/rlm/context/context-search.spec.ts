import { describe, expect, it } from 'vitest';
import type { ContextStore } from '../../../shared/types/rlm.types';
import { executeGrep } from './context-search';

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
