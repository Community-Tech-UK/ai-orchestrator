/**
 * LT-055 regression cover: RLM's own-process context stores
 * (`rlmCreateStore`/`rlmAddSection`) must get lazily, deterministically
 * indexed for `semantic_search` on first query — not silently degrade to
 * keyword matching with zero vectors and no signal.
 *
 * Uses the same real-`RLMDatabase`-via-tmp-dir pattern as
 * `rlm-storage-maintenance.integration.spec.ts` (native SQLite, isolated per
 * test) plus a deterministic mocked embedding service (same pattern as
 * `vector-store.spec.ts`) so `VectorStore`/`RLMContextManager` run their real
 * code, with no network calls.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embed = vi.fn(async (text: string) => ({
  embedding: [text.length % 7, (text.length * 2) % 7, (text.length * 3) % 7],
  model: 'test-embed',
  tokens: Math.ceil(text.length / 4),
  cached: false,
  provider: 'test',
}));

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map((t) => embed(t))),
    findSimilar: (
      _query: ArrayLike<number>,
      candidates: { id: string; embedding: ArrayLike<number> }[],
      topK = 10,
    ) => candidates.slice(0, topK).map((c) => ({ id: c.id, similarity: 0.9 })),
  }),
  EmbeddingService: class {},
}));

import { RLMDatabase } from '../persistence/rlm-database';
import { VectorStore } from './vector-store';
import { RLMContextManager } from './context-manager';

describe('RLMContextManager — LT-055 lazy semantic-search indexing', () => {
  let root: string;
  let manager: RLMContextManager;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rlm-semantic-'));
    RLMDatabase._resetForTesting();
    RLMDatabase.getInstance({
      dbPath: path.join(root, 'rlm.db'),
      contentDir: path.join(root, 'content'),
    });
    VectorStore._resetForTesting();
    RLMContextManager._resetForTesting();
    manager = RLMContextManager.getInstance();
  });

  afterEach(() => {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Create a store + one real section + a session, ready for a query. */
  async function seedStoreWithSection(content: string): Promise<{ storeId: string; sessionId: string }> {
    const store = manager.createStore('inst-1');
    manager.addSection(store.id, 'external', 'note-1', content, undefined);
    const session = await manager.startSession(store.id, 'inst-1');
    return { storeId: store.id, sessionId: session.id };
  }

  it('indexes the store before the first semantic_search query runs (blocking, not silently degraded)', async () => {
    const { storeId, sessionId } = await seedStoreWithSection('backoff notes about retry jitter');

    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    const result = await manager.executeQuery(sessionId, {
      type: 'semantic_search',
      params: { query: 'retry jitter', useHyDE: false },
    });

    expect(indexSpy).toHaveBeenCalledTimes(1);
    expect(indexSpy).toHaveBeenCalledWith(storeId);
    // Real vectors now exist for this store (proves this isn't a silent
    // keyword fallback): the mocked embedder/findSimilar returned the
    // store's one real section as a scored match, not a grep hit.
    const stats = manager.getVectorStoreStats();
    expect(stats?.storeStats.find((s) => s.storeId === storeId)?.vectorCount).toBe(1);
    expect(result.sectionsAccessed).toHaveLength(1);
    expect(result.result).toContain('Similarity');
    expect(result.result).toContain('note-1');
  });

  it('rechecks the durable delta on each query without re-embedding unchanged section content', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'retry', useHyDE: false } });
    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'jitter', useHyDE: false } });
    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'backoff', useHyDE: false } });

    expect(indexSpy).toHaveBeenCalledTimes(3);
    expect(embed.mock.calls.filter(([text]) => text === 'backoff notes about retry jitter'))
      .toHaveLength(1);
  });

  it('two concurrent semantic_search queries share one in-flight repair (no double-index race)', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    const [first, second] = await Promise.all([
      manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'retry', useHyDE: false } }),
      manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'jitter', useHyDE: false } }),
    ]);

    expect(indexSpy).toHaveBeenCalledTimes(2);
    expect(embed.mock.calls.filter(([text]) => text === 'backoff notes about retry jitter'))
      .toHaveLength(1);
    expect(first.result).toContain('note-1');
    expect(second.result).toContain('note-1');
  });

  it('does not index for a non-semantic query type (grep stays cheap)', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    await manager.executeQuery(sessionId, { type: 'grep', params: { pattern: 'retry' } });

    expect(indexSpy).not.toHaveBeenCalled();
  });

  it('rebuilds optimized lexical Bloom after lazily hydrating section content', () => {
    const store = manager.createStore('inst-hydration');
    const section = manager.addSection(
      store.id,
      'external',
      'lazy-note',
      'hydrated lexical content',
      undefined,
    );
    section.content = '';

    manager.searchStoreOptimized(store.id, ['hydrated']);
    expect(manager.getSectionContentLazy(store.id, section.id)).toBe('hydrated lexical content');

    expect(manager.searchStoreOptimized(store.id, ['hydrated'])).toMatchObject({
      sectionsAccessed: [section.id],
    });
  });

  it('a store that fails to index once is retried on the next semantic_search rather than permanently stuck', async () => {
    const { storeId, sessionId } = await seedStoreWithSection('backoff notes about retry jitter');

    const indexSpy = vi
      .spyOn(manager, 'indexStoreForSemanticSearch')
      .mockRejectedValueOnce(new Error('embedding provider unavailable'));

    // First query: indexing fails, but the query itself must not throw —
    // it falls through to keyword search for this turn.
    const first = await manager.executeQuery(sessionId, {
      type: 'semantic_search',
      params: { query: 'retry', useHyDE: false },
    });
    expect(first.result).toContain('note-1');

    // Second query: the failed attempt was evicted, so a real (unmocked)
    // indexing attempt runs this time.
    indexSpy.mockRestore();
    const reindexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');
    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'jitter', useHyDE: false } });
    expect(reindexSpy).toHaveBeenCalledWith(storeId);
  });

  it('rechecks durable vectors without content hydration after reload', async () => {
    const { storeId, sessionId } = await seedStoreWithSection('persisted semantic retry content');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    await manager.executeQuery(sessionId, {
      type: 'semantic_search',
      params: { query: 'semantic retry', useHyDE: false },
    });
    expect(indexSpy).toHaveBeenCalledTimes(1);

    manager.reloadFromPersistence();
    expect(manager.getStoreHydrationState(storeId)).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
    });

    const afterReload = await manager.executeQuery(sessionId, {
      type: 'semantic_search',
      params: { query: 'semantic retry', useHyDE: false },
    });
    expect(indexSpy).toHaveBeenCalledTimes(2);
    expect(afterReload.result).toContain('note-1');
    expect(manager.getStoreHydrationState(storeId)).toMatchObject({
      metadata: 'resident',
      content: 'deferred',
    });
  });

  it('executes an unchanged persisted semantic query after singleton reset without content hydration or section embedding', async () => {
    const db = RLMDatabase.getInstance();
    db.createStore({ id: 'restart-store', instanceId: 'restart-instance' });
    db.addSection({
      id: 'restart-section', storeId: 'restart-store', type: 'external',
      name: 'restart-note', startOffset: 0, endOffset: 26, tokens: 5,
      content: 'durable semantic checkpoint',
    });
    db.addVector({
      id: 'vec-restart-store-restart-section',
      storeId: 'restart-store',
      sectionId: 'restart-section',
      embedding: new Float32Array([1, 2, 3]),
      contentPreview: 'durable semantic checkpoint',
    });
    db.createSession({
      id: 'restart-session',
      storeId: 'restart-store',
      instanceId: 'restart-instance',
      estimatedDirectTokens: 20,
    });
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    manager = RLMContextManager.getInstance();
    const contentRead = vi.spyOn(db, 'getSectionContent');
    const vectorStore = VectorStore.getInstance();
    const sectionEmbedding = vi.spyOn(vectorStore, 'addSection');
    embed.mockClear();

    const result = await manager.executeQuery('restart-session', {
      type: 'semantic_search',
      params: { query: 'semantic checkpoint', useHyDE: false },
    });

    expect(contentRead).not.toHaveBeenCalled();
    expect(sectionEmbedding).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith('semantic checkpoint');
    expect(result.sectionsAccessed).toEqual(['restart-section']);
    expect(result.result).toContain('restart-note');
    expect(manager.getStoreHydrationState('restart-store')).toMatchObject({
      metadata: 'resident',
      content: 'deferred',
    });
  });

  it('loads durable vectors for the default HyDE path after reset without hydrating section content', async () => {
    const db = RLMDatabase.getInstance();
    db.createStore({ id: 'hyde-restart-store', instanceId: 'hyde-restart-instance' });
    db.addSection({
      id: 'hyde-restart-section', storeId: 'hyde-restart-store', type: 'external',
      name: 'hyde-restart-note', startOffset: 0, endOffset: 24, tokens: 5,
      content: 'durable hyde checkpoint',
    });
    db.addVector({
      id: 'vec-hyde-restart-store-hyde-restart-section',
      storeId: 'hyde-restart-store',
      sectionId: 'hyde-restart-section',
      embedding: new Float32Array([1, 2, 3]),
      contentPreview: 'durable hyde checkpoint',
    });
    db.createSession({
      id: 'hyde-restart-session',
      storeId: 'hyde-restart-store',
      instanceId: 'hyde-restart-instance',
      estimatedDirectTokens: 20,
    });
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    manager = RLMContextManager.getInstance();
    const hydeEmbed = vi.fn(async (query: string) => ({
      embedding: [1, 2, 3],
      hypotheticalDocuments: ['hypothetical durable checkpoint'],
      hydeUsed: true,
      generationTimeMs: 1,
      cached: false,
      query,
    }));
    (manager as unknown as { hydeService: { embed: typeof hydeEmbed } }).hydeService = {
      embed: hydeEmbed,
    };
    const contentRead = vi.spyOn(db, 'getSectionContent');
    const sectionEmbedding = vi.spyOn(VectorStore.getInstance(), 'addSection');
    embed.mockClear();

    const result = await manager.executeQuery('hyde-restart-session', {
      type: 'semantic_search',
      params: { query: 'semantic checkpoint' },
    });

    expect(hydeEmbed).toHaveBeenCalledOnce();
    expect(contentRead).not.toHaveBeenCalled();
    expect(sectionEmbedding).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(result.sectionsAccessed).toEqual(['hyde-restart-section']);
    expect(result.result).toContain('hyde-restart-note');
    expect(result.result).toContain('[HyDE]');
    expect(manager.getStoreHydrationState('hyde-restart-store')).toMatchObject({
      metadata: 'resident',
      content: 'deferred',
    });
  });

  it('fences pending semantic indexing across reload before starting replacement-state repair', async () => {
    const db = RLMDatabase.getInstance();
    db.createStore({ id: 'fenced-store', instanceId: 'fenced-instance' });
    db.addSection({
      id: 'fenced-section', storeId: 'fenced-store', type: 'external',
      name: 'fenced.txt', startOffset: 0, endOffset: 18, tokens: 4,
      content: 'generation-fenced semantic content',
    });
    manager.reloadFromPersistence();
    let resolveFirst!: (value: Awaited<ReturnType<typeof embed>>) => void;
    const firstEmbedding = new Promise<Awaited<ReturnType<typeof embed>>>((resolve) => {
      resolveFirst = resolve;
    });
    embed.mockImplementationOnce(async () => firstEmbedding);

    const oldWork = manager.indexStoreForSemanticSearch('fenced-store');
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    manager.reloadFromPersistence();
    const replacementWork = manager.indexStoreForSemanticSearch('fenced-store');

    await Promise.resolve();
    expect(embed).toHaveBeenCalledTimes(1);
    resolveFirst({
      embedding: [1, 2, 3], model: 'test-embed', tokens: 4,
      cached: false, provider: 'test',
    });
    await oldWork;
    await replacementWork;
    expect(embed).toHaveBeenCalledTimes(2);
  });

  it('removes vectors produced by a stale generation before replacement indexing begins', async () => {
    const db = RLMDatabase.getInstance();
    db.createStore({ id: 'generation-store', instanceId: 'generation-instance' });
    db.addSection({
      id: 'generation-section',
      storeId: 'generation-store',
      type: 'external',
      name: 'generation.txt',
      startOffset: 0,
      endOffset: 18,
      tokens: 4,
      content: 'generation content',
    });
    manager.reloadFromPersistence();
    let resolveOld!: (value: Awaited<ReturnType<typeof embed>>) => void;
    let resolveReplacement!: (value: Awaited<ReturnType<typeof embed>>) => void;
    const oldEmbedding = new Promise<Awaited<ReturnType<typeof embed>>>((resolve) => {
      resolveOld = resolve;
    });
    const replacementEmbedding = new Promise<Awaited<ReturnType<typeof embed>>>((resolve) => {
      resolveReplacement = resolve;
    });
    embed
      .mockImplementationOnce(async () => oldEmbedding)
      .mockImplementationOnce(async () => replacementEmbedding);
    const privateManager = manager as unknown as {
      ensureStoreIndexedForSemanticSearch(
        id: string,
      ): Promise<{
        missing: number; indexed: number; skipped: number; failed: number; retried: number;
      }> | null;
    };
    const embedding = {
      embedding: [1, 2, 3], model: 'test-embed', tokens: 4, cached: false, provider: 'test',
    };

    const stale = privateManager.ensureStoreIndexedForSemanticSearch.call(
      manager, 'generation-store',
    )!;
    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(1));
    manager.reloadFromPersistence();
    const replacement = privateManager.ensureStoreIndexedForSemanticSearch.call(
      manager, 'generation-store',
    )!;
    resolveOld(embedding);

    await vi.waitFor(() => expect(embed).toHaveBeenCalledTimes(2));
    expect(manager.getVectorStoreStats()?.totalVectors).toBe(0);
    resolveReplacement(embedding);
    await stale;
    await replacement;
    expect(manager.getVectorStoreStats()?.storeStats).toEqual([
      expect.objectContaining({ storeId: 'generation-store', vectorCount: 1 }),
    ]);
  });
});
