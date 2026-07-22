import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for the main-process heap fix.
 *
 * The store used to load every vector of every store into a
 * process-lifetime Map at construction (~1.1-1.3 GB on a real profile), keeping
 * boxed doubles plus preview text and parsed metadata that ranking never reads.
 */

const listStores = vi.fn(() => [] as { id: string }[]);
const getVectors = vi.fn((_storeId: string) => [] as Record<string, unknown>[]);
const getVectorBySectionId = vi.fn((_sectionId: string) => null as Record<string, unknown> | null);
const deleteVector = vi.fn();
const addVector = vi.fn();
const ensureStore = vi.fn();
const ensureSection = vi.fn();
const bufferToEmbedding = vi.fn((buf: Buffer) =>
  new Float32Array(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)),
);

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    listStores,
    getVectors,
    getVectorBySectionId,
    deleteVector,
    addVector,
    ensureStore,
    ensureSection,
    bufferToEmbedding,
  }),
  RLMDatabase: class {},
}));

const embed = vi.fn(async (_text: string) => ({
  embedding: [1, 0, 0],
  model: 'test',
  tokens: 0,
  cached: false,
  provider: 'test',
}));

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    findSimilar: (
      _q: ArrayLike<number>,
      candidates: { id: string; embedding: ArrayLike<number> }[],
      topK = 10,
    ) => candidates.slice(0, topK).map((c) => ({ id: c.id, similarity: 0.9 })),
  }),
  EmbeddingService: class {},
}));

import { VectorStore, getVectorStore } from './vector-store';

/** Build a fake DB row for a store's vector. */
function row(storeId: string, n: number) {
  return {
    id: `vec-${storeId}-sec${n}`,
    store_id: storeId,
    section_id: `sec${n}`,
    embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer),
    content_preview: `preview-${storeId}-${n}`,
    metadata_json: JSON.stringify({ heavy: 'x'.repeat(64) }),
  };
}

describe('VectorStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    VectorStore._resetForTesting();
    getVectors.mockImplementation((storeId: string) => [row(storeId, 1), row(storeId, 2)]);
    getVectorBySectionId.mockImplementation((sectionId: string) => ({
      id: `vec-s1-${sectionId}`,
      store_id: 's1',
      section_id: sectionId,
      embedding: Buffer.from(new Float32Array([1, 0, 0]).buffer),
      content_preview: `preview-${sectionId}`,
      metadata_json: JSON.stringify({ from: 'db' }),
    }));
  });

  it('loads nothing at construction', () => {
    getVectorStore();

    // The regression: constructing must not walk the corpus.
    expect(listStores).not.toHaveBeenCalled();
    expect(getVectors).not.toHaveBeenCalled();
  });

  it('loads only the searched store, and only once', async () => {
    const store = getVectorStore();

    await store.search('s1', 'query');
    await store.search('s1', 'query again');

    expect(getVectors).toHaveBeenCalledTimes(1);
    expect(getVectors).toHaveBeenCalledWith('s1');
  });

  it('keeps embeddings as Float32Array and drops preview/metadata from the cache', async () => {
    const store = getVectorStore();
    await store.search('s1', 'query');

    const cache = (store as unknown as { vectorCache: Map<string, Record<string, unknown>> }).vectorCache;
    const cached = [...cache.values()][0];

    expect(cached['embedding']).toBeInstanceOf(Float32Array);
    expect(cached).not.toHaveProperty('contentPreview');
    expect(cached).not.toHaveProperty('metadata');
  });

  it('hydrates preview and metadata from the database for ranked results', async () => {
    const store = getVectorStore();

    const results = await store.search('s1', 'query', { topK: 1 });

    expect(results).toHaveLength(1);
    expect(results[0].entry.contentPreview).toBe('preview-sec1');
    expect(results[0].entry.metadata).toEqual({ from: 'db' });
  });

  it('evicts the least-recently-used store past the residency cap', async () => {
    const store = getVectorStore({ maxResidentStores: 2 });

    await store.search('s1', 'q');
    await store.search('s2', 'q');
    await store.search('s3', 'q');

    const stats = store.getStats();
    expect(stats.residentStores).toBe(2);
    expect(stats.storeStats.map((s) => s.storeId).sort()).toEqual(['s2', 's3']);
  });

  it('keeps a store resident when it is used again', async () => {
    const store = getVectorStore({ maxResidentStores: 2 });

    await store.search('s1', 'q');
    await store.search('s2', 'q');
    await store.search('s1', 'q'); // s1 becomes most-recent, s2 the coldest
    await store.search('s3', 'q');

    expect(store.getStats().storeStats.map((s) => s.storeId).sort()).toEqual(['s1', 's3']);
  });

  it('does not strand a store as half-resident when adding to it', async () => {
    const store = getVectorStore();

    // Adding to a cold store must pull in its existing vectors, otherwise the
    // store looks resident while holding only the new id and the next search
    // silently ranks against that one vector.
    await store.addSection('s1', 'sec-new', 'content');

    expect(getVectors).toHaveBeenCalledWith('s1');

    const results = await store.search('s1', 'query', { topK: 10 });
    expect(results.length).toBeGreaterThan(1);
  });

  it('answers isIndexed from the database when the store is not resident', () => {
    const store = getVectorStore();

    // Nothing loaded, so a cache miss must not be reported as "not indexed".
    expect(store.isIndexed('s1', 'sec1')).toBe(true);
    expect(getVectorBySectionId).toHaveBeenCalledWith('sec1');
  });

  it('deletes from the database even when the owning store is not resident', () => {
    const store = getVectorStore();

    store.removeSection('sec1');

    expect(deleteVector).toHaveBeenCalledWith('sec1');
  });

  it('loads the store before clearing so removal is not a silent no-op', () => {
    const store = getVectorStore();

    store.clearStore('s1');

    expect(getVectors).toHaveBeenCalledWith('s1');
    expect(deleteVector).toHaveBeenCalledTimes(2);
  });
});
