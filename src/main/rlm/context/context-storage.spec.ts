import { describe, expect, it, vi } from 'vitest';
import type { ContextStore } from '../../../shared/types/rlm.types';
import {
  addSection,
  addSectionsBatch,
  removeSection,
  type StorageDependencies,
} from './context-storage';
import { createBloomFilter } from './context-cache';
import { searchStoreOptimized } from './context-search';

const PRIVATE_KEY_HEADER = '-----BEGIN PRIVATE KEY----- EXAMPLE ONLY';

describe('context-storage secret egress gate', () => {
  it('redacts a secret before a context section is persisted or indexed', () => {
    const persisted: { content: string }[] = [];
    const indexed = vi.fn().mockResolvedValue(undefined);
    const store: ContextStore = {
      id: 'store-1', instanceId: 'instance-1', sections: [], totalTokens: 0, totalSize: 0,
      createdAt: 1, lastAccessed: 1, accessCount: 0,
    };
    const deps: StorageDependencies = {
      db: { addSection: (section: { content: string }) => persisted.push(section) } as never,
      vectorStore: { addSection: indexed } as never,
      persistenceEnabled: true,
      maxSectionTokens: 8_000,
      summaryThreshold: 50_000,
      tokenEstimator: (content) => content.length,
    };

    const section = addSection(
      store,
      'conversation',
      'Customer report',
      `The leaked credential marker is ${PRIVATE_KEY_HEADER}.`,
      undefined,
      deps,
    );

    expect(section.content).toContain('[REDACTED — potential secret]');
    expect(section.content).not.toContain(PRIVATE_KEY_HEADER);
    expect(persisted).toEqual([expect.objectContaining({ content: section.content })]);
    expect(indexed).toHaveBeenCalledWith('store-1', section.id, section.content, expect.any(Object));
  });
});

describe('context-storage Bloom invalidation', () => {
  it('allows a later optimized search to find content added after Bloom was first used', () => {
    const store: ContextStore = {
      id: 'store-1', instanceId: 'instance-1', sections: [], totalTokens: 0, totalSize: 0,
      createdAt: 1, lastAccessed: 1, accessCount: 0,
    };
    const deps: StorageDependencies = {
      db: null,
      vectorStore: null,
      persistenceEnabled: false,
      maxSectionTokens: 8_000,
      summaryThreshold: 50_000,
      tokenEstimator: (content) => content.length,
    };

    searchStoreOptimized(store, ['fresh'], 10, 20);
    addSection(store, 'file', 'fresh.ts', 'fresh lexical content', undefined, deps);
    expect(store.bloomFilter).toBeUndefined();

    expect(searchStoreOptimized(store, ['fresh'], 10, 20)).toEqual({
      result: '[Match 1] fresh.ts (file):\n...fresh lexical content...',
      sectionsAccessed: [store.sections[0].id],
    });
  });

  it('invalidates Bloom after successful removal but not an absent section', () => {
    const store: ContextStore = {
      id: 'store-1', instanceId: 'instance-1', totalTokens: 3, totalSize: 13,
      createdAt: 1, lastAccessed: 1, accessCount: 0,
      bloomFilter: createBloomFilter(),
      sections: [{
        id: 'section-1', type: 'file', name: 'removable.ts', content: 'remove this', tokens: 3,
        startOffset: 0, endOffset: 11, checksum: 'remove', depth: 0,
      }],
    };
    const deps: StorageDependencies = {
      db: null, vectorStore: null, persistenceEnabled: false,
      maxSectionTokens: 8_000, summaryThreshold: 50_000,
    };

    expect(removeSection(store, 'missing-section', deps)).toBeNull();
    expect(store.bloomFilter).toBeDefined();
    expect(removeSection(store, 'section-1', deps)).toMatchObject({ id: 'section-1' });
    expect(store.bloomFilter).toBeUndefined();
  });

  it('invalidates Bloom for non-empty batch and large writes only', async () => {
    const deps: StorageDependencies = {
      db: null, vectorStore: null, persistenceEnabled: false,
      maxSectionTokens: 5, summaryThreshold: 50_000,
      tokenEstimator: (content) => content.length,
    };
    const store: ContextStore = {
      id: 'store-1', instanceId: 'instance-1', sections: [], totalTokens: 0, totalSize: 0,
      createdAt: 1, lastAccessed: 1, accessCount: 0,
      bloomFilter: createBloomFilter(),
    };

    await addSectionsBatch(store, [], deps);
    expect(store.bloomFilter).toBeDefined();

    await addSectionsBatch(store, [{ type: 'file', name: 'batch.ts', content: 'batch content' }], deps);
    expect(store.bloomFilter).toBeUndefined();

    store.bloomFilter = createBloomFilter();
    addSection(store, 'file', 'large.ts', 'large section needs splitting', undefined, deps);
    expect(store.bloomFilter).toBeUndefined();
  });
});
