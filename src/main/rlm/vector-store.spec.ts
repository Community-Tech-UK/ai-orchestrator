import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression cover for the main-process heap fix.
 *
 * The store used to load every vector of every store into a
 * process-lifetime Map at construction (~1.1-1.3 GB on a real profile), keeping
 * boxed doubles plus preview text and parsed metadata that ranking never reads.
 */

const listStores = vi.fn(() => [] as { id: string }[]);
const getVectors = vi.fn((_storeId: string, _model: string) => [] as Record<string, unknown>[]);
const listStaleVectors = vi.fn((_storeId: string, _model: string, _limit: number) => [] as Record<string, unknown>[]);
const deleteStoreVectors = vi.fn();
const addVectorForExistingSection = vi.fn();
const getSection = vi.fn();
const getSectionContent = vi.fn();
const embedBatch = vi.fn();
const similarityFloor = vi.fn(async (_use: string) => 0.5);
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
    listStaleVectors,
    deleteStoreVectors,
    addVectorForExistingSection,
    getSection,
    getSectionContent,
    getVectorBySectionId,
    deleteVector,
    addVector,
    ensureStore,
    ensureSection,
    bufferToEmbedding,
  }),
  RLMDatabase: class {},
}));

const embed = vi.fn(async (_text: string, _purpose?: string) => ({
  embedding: [1, 0, 0],
  model: 'test',
  tokens: 0,
  cached: false,
  provider: 'test',
}));

vi.mock('./embedding/embedding-model', () => ({ HASH_EMBEDDING_MODEL: { id: 'hash-model' } }));

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    embedBatch,
    activeModelId: async () => 'test',
    similarityFloor,
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
    expect(getVectors).toHaveBeenCalledWith('s1', 'test');
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

  it('embeds as a query unless told it is comparing stored text', async () => {
    const store = getVectorStore();
    embed.mockClear();

    await store.search('s1', 'a question');
    await store.search('s1', 'stored text', { embedAs: 'document' });

    expect(embed).toHaveBeenNthCalledWith(1, 'a question', 'query');
    expect(embed).toHaveBeenNthCalledWith(2, 'stored text', 'document');
  });

  it('does not strand a store as half-resident when adding to it', async () => {
    const store = getVectorStore();

    // Adding to a cold store must pull in its existing vectors, otherwise the
    // store looks resident while holding only the new id and the next search
    // silently ranks against that one vector.
    await store.addSection('s1', 'sec-new', 'content');

    expect(getVectors).toHaveBeenCalledWith('s1', 'test');

    const results = await store.search('s1', 'query', { topK: 10 });
    expect(results.length).toBeGreaterThan(1);
  });

  it('surfaces durable persistence failure without caching or emitting index success', async () => {
    const store = getVectorStore();
    const indexed = vi.fn();
    store.on('section:indexed', indexed);
    addVector.mockImplementationOnce(() => {
      throw new Error('disk write failed');
    });

    await expect(store.addSection('s1', 'sec-new', 'content'))
      .rejects.toThrow('disk write failed');

    expect(store.getStats().storeStats.find((entry) => entry.storeId === 's1')?.vectorCount)
      .toBe(2);
    expect(indexed).not.toHaveBeenCalled();
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

  it('only ever loads vectors from the model doing the search', async () => {
    await getVectorStore().search('s1', 'query');

    expect(getVectors).toHaveBeenCalledWith('s1', 'test');
  });

  it('uses the model floor for the search use unless given a fixed threshold', async () => {
    const floors: string[] = [];
    similarityFloor.mockImplementation(async (use: string) => {
      floors.push(use);
      return 0.5;
    });
    const store = getVectorStore();

    await store.search('s1', 'query');
    await store.search('s1', 'query', { use: 'reflection-search' });
    await store.search('s1', 'query', { minSimilarity: 0.9 });

    expect(floors).toEqual(['context-search', 'reflection-search']);
  });

  describe('moving older vectors onto the active model', () => {
    const stale = (n: number, overrides: Record<string, unknown> = {}) => ({
      id: `vec-s1-old${n}`,
      section_id: `old${n}`,
      store_id: 's1',
      content_preview: `preview ${n}`,
      metadata_json: JSON.stringify({ model: 'local-tfidf', kept: true }),
      ...overrides,
    });
    const flush = () => vi.waitFor(() => expect(listStaleVectors.mock.calls.length).toBeGreaterThan(1));

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      addVectorForExistingSection.mockReturnValue(true);
      getSection.mockImplementation((id: string) => ({ id }));
      getSectionContent.mockImplementation((section: { id: string }) => `full text of ${section.id}`);
      embedBatch.mockImplementation(async (texts: string[]) => texts.map(() => ({
        embedding: [0, 1, 0], model: 'test', tokens: 0, cached: false, provider: 'test',
      })));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function runToCompletion(): Promise<void> {
      await flush();
      await vi.advanceTimersByTimeAsync(1_000);
    }

    it('re-embeds from the full section text and keeps the metadata', async () => {
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);

      await getVectorStore().search('s1', 'query');
      await vi.waitFor(() => expect(addVectorForExistingSection).toHaveBeenCalled());

      expect(embedBatch).toHaveBeenCalledWith(['full text of old1'], 'document');
      expect(addVectorForExistingSection).toHaveBeenCalledWith(expect.objectContaining({
        id: 'vec-s1-old1',
        sectionId: 'old1',
        metadata: expect.objectContaining({ model: 'test', kept: true }),
      }));
    });

    it('never makes a search wait for the conversion', async () => {
      let finishEmbedding: () => void = () => undefined;
      embedBatch.mockImplementation(() => new Promise((resolve) => {
        finishEmbedding = () => resolve([{ embedding: [0, 1, 0], model: 'test', tokens: 0, cached: false, provider: 'test' }]);
      }));
      listStaleVectors.mockReturnValue([stale(1)]);

      const results = await getVectorStore().search('s1', 'query');

      expect(results).toHaveLength(2);
      expect(addVectorForExistingSection).not.toHaveBeenCalled();
      listStaleVectors.mockReturnValue([]);
      finishEmbedding();
    });

    it('does not bring vectors back when a store is cleared while converting', async () => {
      let finishEmbedding: () => void = () => undefined;
      embedBatch.mockImplementation(() => new Promise((resolve) => {
        finishEmbedding = () => resolve([{ embedding: [0, 1, 0], model: 'test', tokens: 0, cached: false, provider: 'test' }]);
      }));
      listStaleVectors.mockReturnValue([stale(1)]);
      const store = getVectorStore();
      await store.search('s1', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));

      store.clearStore('s1');
      finishEmbedding();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(addVectorForExistingSection).not.toHaveBeenCalled();
      expect(embedBatch).toHaveBeenCalledTimes(1);
    });

    it('can convert a store again after a clear stopped it', async () => {
      let finishEmbedding: () => void = () => undefined;
      embedBatch.mockImplementationOnce(() => new Promise((resolve) => {
        finishEmbedding = () => resolve([{ embedding: [0, 1, 0], model: 'test', tokens: 0, cached: false, provider: 'test' }]);
      }));
      listStaleVectors.mockReturnValueOnce([stale(1)]);
      const store = getVectorStore();
      await store.search('s1', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));
      store.clearStore('s1');
      finishEmbedding();
      await vi.advanceTimersByTimeAsync(1_000);

      listStaleVectors.mockReturnValueOnce([stale(2)]).mockReturnValue([]);
      await store.search('s1', 'query');
      await vi.waitFor(() => expect(addVectorForExistingSection).toHaveBeenCalledTimes(1));
    });

    it('makes a converted vector searchable straight away in a resident store', async () => {
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);
      const store = getVectorStore();

      await store.search('s1', 'query');
      await vi.waitFor(() => expect(addVectorForExistingSection).toHaveBeenCalled());
      await runToCompletion();

      expect(store.getStats().storeStats.find((entry) => entry.storeId === 's1')?.vectorCount).toBe(3);
    });

    it('runs once per store however many searches arrive', async () => {
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);
      const store = getVectorStore();

      await Promise.all([store.search('s1', 'a'), store.search('s1', 'b'), store.search('s1', 'c')]);
      await runToCompletion();

      expect(embedBatch).toHaveBeenCalledTimes(1);
    });

    it('converts one store at a time, so searches never queue behind several', async () => {
      let release: () => void = () => undefined;
      embedBatch.mockImplementation(() => new Promise((resolve) => {
        release = () => resolve([{ embedding: [0, 1, 0], model: 'test', tokens: 0, cached: false, provider: 'test' }]);
      }));
      listStaleVectors.mockImplementation((storeId: string) => (
        listStaleVectors.mock.calls.length <= 2 ? [stale(1, { store_id: storeId })] : []
      ));
      const store = getVectorStore();

      await store.search('s1', 'query');
      await store.search('s2', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_000);

      expect(embedBatch).toHaveBeenCalledTimes(1);
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(2));
      release();
    });

    it('still converts a row whose metadata is damaged', async () => {
      listStaleVectors.mockReturnValueOnce([stale(1, { metadata_json: '{broken' })]).mockReturnValue([]);

      await getVectorStore().search('s1', 'query');
      await vi.waitFor(() => expect(addVectorForExistingSection).toHaveBeenCalled());

      expect(addVectorForExistingSection).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({ model: 'test' }),
      }));
    });

    it('stops checking a store once it is fully converted', async () => {
      listStaleVectors.mockReturnValue([]);
      const store = getVectorStore();

      await store.search('s1', 'query');
      await vi.waitFor(() => expect(listStaleVectors).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1_000);
      await store.search('s1', 'query');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(listStaleVectors).toHaveBeenCalledTimes(1);
    });

    it('falls back to the stored preview when the section cannot be read', async () => {
      getSectionContent.mockImplementation(() => { throw new Error('content file missing'); });
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);

      await getVectorStore().search('s1', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalled());

      expect(embedBatch).toHaveBeenCalledWith(['preview 1'], 'document');
    });

    it('drops a vector whose section has gone, so the loop cannot spin on it', async () => {
      addVectorForExistingSection.mockReturnValue(false);
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);

      await getVectorStore().search('s1', 'query');
      await vi.waitFor(() => expect(deleteVector).toHaveBeenCalledWith('old1'));
    });

    it('picks up again on a later search after a failure', async () => {
      embedBatch.mockRejectedValueOnce(new Error('model busy'));
      listStaleVectors.mockReturnValue([stale(1)]);
      const store = getVectorStore();

      await store.search('s1', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(10);
      listStaleVectors.mockReturnValueOnce([stale(1)]).mockReturnValue([]);
      embedBatch.mockClear();

      await store.search('s1', 'query');
      await vi.waitFor(() => expect(embedBatch).toHaveBeenCalledTimes(1));
    });

    it('never replaces real vectors with hash vectors', async () => {
      embed.mockResolvedValueOnce({ embedding: [1, 0, 0], model: 'hash-model', tokens: 0, cached: false, provider: 'local' });

      await getVectorStore().search('s1', 'query');
      await vi.advanceTimersByTimeAsync(1_000);

      expect(listStaleVectors).not.toHaveBeenCalled();
      expect(embedBatch).not.toHaveBeenCalled();
    });
  });

  it('clears a store that is not resident, so removal is not a silent no-op', () => {
    const store = getVectorStore();

    store.clearStore('s1');

    expect(deleteStoreVectors).toHaveBeenCalledWith('s1');
  });

  it('forgets cleared vectors so a later search cannot return them', async () => {
    const store = getVectorStore();
    await store.search('s1', 'query');

    store.clearStore('s1');

    expect(store.getStats().totalVectors).toBe(0);
  });
});
