import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { embedderEmbed, load, resolveDir } = vi.hoisted(() => {
  const embedderEmbed = vi.fn(async (texts: readonly string[]) => (
    texts.map((text) => Float32Array.from([text.length, 1]))
  ));
  return {
    embedderEmbed,
    load: vi.fn(async () => ({ embed: embedderEmbed })),
    resolveDir: vi.fn<() => string | null>(() => '/models/bge'),
  };
});

vi.mock('./embedding/onnx-text-embedder', () => ({
  OnnxTextEmbedder: { load },
}));

vi.mock('./embedding/embedding-model', async (importOriginal) => ({
  ...await importOriginal<typeof import('./embedding/embedding-model')>(),
  resolveEmbeddingModelDir: resolveDir,
}));

import { EmbeddingService, getEmbeddingService } from './embedding-service';
import { HASH_EMBEDDING_MODEL, LOCAL_EMBEDDING_MODEL } from './embedding/embedding-model';

describe('EmbeddingService', () => {
  beforeEach(() => {
    EmbeddingService._resetForTesting();
    embedderEmbed.mockClear();
    load.mockClear();
    load.mockImplementation(async () => ({ embed: embedderEmbed }));
    resolveDir.mockReturnValue('/models/bge');
  });

  afterEach(() => {
    EmbeddingService._resetForTesting();
  });

  describe('with the model installed', () => {
    it('reports the model on results and as the active model', async () => {
      const service = getEmbeddingService();

      const result = await service.embed('hello');

      expect(result).toEqual(expect.objectContaining({ model: LOCAL_EMBEDDING_MODEL.id, provider: 'onnx', cached: false }));
      await expect(service.activeModelId()).resolves.toBe(LOCAL_EMBEDDING_MODEL.id);
    });

    it('adds the search instruction to queries and never to stored text', async () => {
      const service = getEmbeddingService();

      await service.embed('stored text', 'document');
      await service.embed('a question', 'query');

      expect(embedderEmbed).toHaveBeenNthCalledWith(1, ['stored text']);
      expect(embedderEmbed).toHaveBeenNthCalledWith(2, [`${LOCAL_EMBEDDING_MODEL.queryInstruction}a question`]);
    });

    it('treats text as stored text unless told otherwise', async () => {
      await getEmbeddingService().embed('plain');

      expect(embedderEmbed).toHaveBeenCalledWith(['plain']);
    });

    it('loads the model once for concurrent first calls', async () => {
      const service = getEmbeddingService();

      await Promise.all([service.embed('a'), service.embed('b'), service.activeModelId()]);

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('uses the model floor for each use', async () => {
      await expect(getEmbeddingService().similarityFloor('skill-match'))
        .resolves.toBe(LOCAL_EMBEDDING_MODEL.similarityFloors['skill-match']);
    });
  });

  describe('without the model', () => {
    beforeEach(() => resolveDir.mockReturnValue(null));

    it('falls back to the word hash, under its own id', async () => {
      const service = getEmbeddingService();

      const result = await service.embed('hello world');

      expect(result.model).toBe(HASH_EMBEDDING_MODEL.id);
      expect(result.provider).toBe('local');
      expect(result.embedding).toHaveLength(384);
      expect(load).not.toHaveBeenCalled();
    });

    it('keeps the hash floors, which sit on a different scale', async () => {
      await expect(getEmbeddingService().similarityFloor('context-search')).resolves.toBe(0.5);
      await expect(getEmbeddingService().similarityFloor('skill-match')).resolves.toBe(0.65);
    });

    it('is deterministic, so stored hash vectors stay comparable', async () => {
      const first = await getEmbeddingService().embed('session token refresh');
      EmbeddingService._resetForTesting();
      const second = await getEmbeddingService().embed('session token refresh');

      expect(second.embedding).toEqual(first.embedding);
    });
  });

  it('settles on the hash for the whole process when the model cannot load', async () => {
    load.mockRejectedValue(new Error('no binary for this platform'));
    const service = getEmbeddingService();

    const first = await service.embed('one');
    const second = await service.embed('two');

    expect([first.model, second.model]).toEqual([HASH_EMBEDDING_MODEL.id, HASH_EMBEDDING_MODEL.id]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  describe('cache', () => {
    it('reuses a repeated embedding', async () => {
      const service = getEmbeddingService();

      await service.embed('same text');
      const second = await service.embed('same text');

      expect(embedderEmbed).toHaveBeenCalledTimes(1);
      expect(second).toEqual(expect.objectContaining({ cached: true, provider: 'cache', model: LOCAL_EMBEDDING_MODEL.id }));
    });

    it('keeps a query and stored text with the same words apart', async () => {
      const service = getEmbeddingService();

      await service.embed('same words', 'document');
      const query = await service.embed('same words', 'query');

      expect(query.cached).toBe(false);
      expect(embedderEmbed).toHaveBeenCalledTimes(2);
    });
  });

  describe('embedBatch', () => {
    it('sends only uncached texts to the model and keeps the order', async () => {
      const service = getEmbeddingService();
      await service.embed('bb');
      embedderEmbed.mockClear();

      const results = await service.embedBatch(['a', 'bb', 'ccc']);

      expect(embedderEmbed).toHaveBeenCalledWith(['a', 'ccc']);
      expect(results.map((result) => result.embedding[0])).toEqual([1, 2, 3]);
      expect(results.map((result) => result.cached)).toEqual([false, true, false]);
    });

    it('does nothing for an empty batch', async () => {
      await expect(getEmbeddingService().embedBatch([])).resolves.toEqual([]);
      expect(embedderEmbed).not.toHaveBeenCalled();
    });
  });

  describe('comparison', () => {
    it('refuses to compare vectors of different lengths', () => {
      expect(() => getEmbeddingService().cosineSimilarity([1, 0], [1, 0, 0])).toThrow('Dimension mismatch');
    });

    it('filters by the given floor and ranks best first', () => {
      const candidates = [
        { id: 'weak', embedding: [1, 1] },
        { id: 'exact', embedding: [1, 0] },
        { id: 'opposite', embedding: [-1, 0] },
      ];

      expect(getEmbeddingService().findSimilar([1, 0], candidates, 5, 0.5).map((match) => match.id))
        .toEqual(['exact', 'weak']);
    });
  });
});
