import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const embeddingResult = {
  embedding: [1, 2, 3],
  model: 'test-embed',
  tokens: 1,
  cached: false,
  provider: 'test',
};
const embed = vi.fn(async (_text: string) => embeddingResult);

vi.mock('./embedding-service', () => ({
  getEmbeddingService: () => ({
    embed,
    embedBatch: async (texts: string[]) => Promise.all(texts.map((text) => embed(text))),
    findSimilar: vi.fn(() => []),
  }),
  EmbeddingService: class {},
}));

import { RLMDatabase } from '../persistence/rlm-database';
import { RLMContextManager } from './context-manager';
import { VectorStore } from './vector-store';

describe('durable semantic-vector delta indexing', () => {
  let root: string;
  let db: RLMDatabase;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-vector-delta-'));
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    db = RLMDatabase.getInstance({
      dbPath: path.join(root, 'rlm.db'),
      contentDir: path.join(root, 'content'),
    });
  });

  afterEach(() => {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    RLMDatabase._resetForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('uses durable vector rows after singleton reset without reading or embedding unchanged sections', async () => {
    seedSection('store-1', 'section-1', 'already indexed content');
    seedVector('store-1', 'section-1');
    const manager = freshManager();
    const contentRead = vi.spyOn(db, 'getSectionContent');

    const result = await manager.indexStoreForSemanticSearch('store-1');

    expect(result).toEqual({ missing: 0, indexed: 0, skipped: 0, failed: 0, retried: 0 });
    expect(contentRead).not.toHaveBeenCalled();
    expect(embed).not.toHaveBeenCalled();
    expect(manager.getStoreHydrationState('store-1')).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
    });
  });

  it('reads and embeds exactly one newly missing section while leaving the store deferred', async () => {
    seedSection('store-1', 'section-indexed', 'existing vector content');
    seedSection('store-1', 'section-new', 'new delta content');
    seedVector('store-1', 'section-indexed');
    const manager = freshManager();
    const contentRead = vi.spyOn(db, 'getSectionContent');

    const result = await manager.indexStoreForSemanticSearch('store-1');

    expect(result).toEqual({ missing: 1, indexed: 1, skipped: 0, failed: 0, retried: 0 });
    expect(contentRead).toHaveBeenCalledOnce();
    expect(contentRead.mock.calls[0]?.[0].id).toBe('section-new');
    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith('new delta content');
    expect(db.getVectorBySectionId('section-new')).not.toBeNull();
    expect(manager.getStoreHydrationState('store-1')).toMatchObject({
      metadata: 'deferred',
      content: 'deferred',
    });
  });

  it('leaves an embedding failure without a vector row and retries it on the next repair', async () => {
    seedSection('store-1', 'section-retry', 'retryable delta content');
    const manager = freshManager();
    embed.mockRejectedValueOnce(new Error('embedding unavailable'));

    await expect(manager.indexStoreForSemanticSearch('store-1'))
      .resolves.toEqual({ missing: 1, indexed: 0, skipped: 0, failed: 1, retried: 0 });
    expect(db.getVectorBySectionId('section-retry')).toBeFalsy();

    await expect(manager.indexStoreForSemanticSearch('store-1'))
      .resolves.toEqual({ missing: 1, indexed: 1, skipped: 0, failed: 0, retried: 1 });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(db.getVectorBySectionId('section-retry')).not.toBeNull();
  });

  it('deduplicates concurrent repair, bounds each query batch, and yields between batches', async () => {
    seedSection('store-1', 'section-first', 'first delta');
    seedSection('store-1', 'section-second', 'second delta');
    const manager = freshManager();
    VectorStore.getInstance().configure({ indexBatchSize: 1 });
    const listMissing = vi.spyOn(db, 'listUnindexedRootSections');
    let releaseFirst!: (result: typeof embeddingResult) => void;
    const firstEmbedding = new Promise<typeof embeddingResult>((resolve) => {
      releaseFirst = resolve;
    });
    embed.mockImplementationOnce(async () => firstEmbedding);

    const firstRepair = manager.indexStoreForSemanticSearch('store-1');
    const concurrentRepair = manager.indexStoreForSemanticSearch('store-1');
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    releaseFirst(embeddingResult);
    await Promise.resolve();
    await Promise.resolve();
    expect(embed).toHaveBeenCalledOnce();

    await new Promise<void>((resolve) => setImmediate(resolve));
    const [firstResult, concurrentResult] = await Promise.all([firstRepair, concurrentRepair]);

    expect(firstResult).toEqual({ missing: 2, indexed: 2, skipped: 0, failed: 0, retried: 0 });
    expect(concurrentResult).toEqual(firstResult);
    expect(embed).toHaveBeenCalledTimes(2);
    expect(listMissing.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(listMissing.mock.calls.every(([, options]) => options?.limit === 1)).toBe(true);
  });

  it('does not recreate a section removed while its embedding is pending', async () => {
    seedSection('store-1', 'section-removed', 'content removed during embed');
    const manager = freshManager();
    let releaseEmbedding!: (result: typeof embeddingResult) => void;
    const pendingEmbedding = new Promise<typeof embeddingResult>((resolve) => {
      releaseEmbedding = resolve;
    });
    embed.mockImplementationOnce(async () => pendingEmbedding);

    const repair = manager.indexStoreForSemanticSearch('store-1');
    await vi.waitFor(() => expect(embed).toHaveBeenCalledOnce());
    expect(manager.removeSection('store-1', 'section-removed')).toBe(true);
    releaseEmbedding(embeddingResult);

    await expect(repair).resolves.toEqual({
      missing: 1, indexed: 0, skipped: 0, failed: 1, retried: 0,
    });
    expect(db.getSection('section-removed')).toBeFalsy();
    expect(db.getVectorBySectionId('section-removed')).toBeFalsy();
  });

  function freshManager(): RLMContextManager {
    RLMContextManager._resetForTesting();
    VectorStore._resetForTesting();
    embed.mockClear();
    return RLMContextManager.getInstance();
  }

  function seedSection(storeId: string, sectionId: string, content: string): void {
    if (!db.getStore(storeId)) {
      db.createStore({ id: storeId, instanceId: `instance-${storeId}` });
    }
    db.addSection({
      id: sectionId,
      storeId,
      type: 'external',
      name: `${sectionId}.txt`,
      startOffset: db.getSections(storeId).length * 100,
      endOffset: db.getSections(storeId).length * 100 + content.length,
      tokens: 3,
      depth: 0,
      content,
    });
  }

  function seedVector(storeId: string, sectionId: string): void {
    db.getRawDb().prepare(`
      INSERT INTO vectors (
        id, store_id, section_id, embedding, dimensions, content_preview,
        metadata_json, created_at
      ) VALUES (?, ?, ?, zeroblob(12), 3, 'seed preview', NULL, 1)
    `).run(`vec-${storeId}-${sectionId}`, storeId, sectionId);
  }
});
