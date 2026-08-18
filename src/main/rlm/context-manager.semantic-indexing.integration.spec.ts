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

  it('indexes a store exactly once — a second semantic_search on the same store does not re-index', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'retry', useHyDE: false } });
    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'jitter', useHyDE: false } });
    await manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'backoff', useHyDE: false } });

    expect(indexSpy).toHaveBeenCalledTimes(1);
  });

  it('two concurrent semantic_search queries arriving before indexing completes only index once (no double-index race)', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    const [first, second] = await Promise.all([
      manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'retry', useHyDE: false } }),
      manager.executeQuery(sessionId, { type: 'semantic_search', params: { query: 'jitter', useHyDE: false } }),
    ]);

    expect(indexSpy).toHaveBeenCalledTimes(1);
    expect(first.result).toContain('note-1');
    expect(second.result).toContain('note-1');
  });

  it('does not index for a non-semantic query type (grep stays cheap)', async () => {
    const { sessionId } = await seedStoreWithSection('backoff notes about retry jitter');
    const indexSpy = vi.spyOn(manager, 'indexStoreForSemanticSearch');

    await manager.executeQuery(sessionId, { type: 'grep', params: { pattern: 'retry' } });

    expect(indexSpy).not.toHaveBeenCalled();
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
});
