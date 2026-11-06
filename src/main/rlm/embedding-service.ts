/**
 * Embedding Service
 * Turns text into vectors for semantic search.
 *
 * Uses the bundled local model. If that cannot run (a checkout that has not
 * fetched it, or a platform with no runtime build) it falls back to a hashed bag
 * of words, which sees shared words but not meaning.
 *
 * The choice is made once per process and never changes, so a process can only
 * ever produce one kind of vector. Vectors from different models are not
 * comparable: callers use `model` on each result, and `similarityFloor()` for a
 * threshold, because each model has its own similarity scale.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { estimateTokens as sharedEstimateTokens } from '../../shared/utils/token-estimate';
import {
  HASH_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_MODEL,
  resolveEmbeddingModelDir,
  type EmbeddingModelSpec,
  type SimilarityUse,
} from './embedding/embedding-model';
import { OnnxTextEmbedder } from './embedding/onnx-text-embedder';

export type { SimilarityUse } from './embedding/embedding-model';

const logger = getLogger('EmbeddingService');

/** What the text is. Some models embed a search query differently from stored text. */
export type EmbeddingPurpose = 'query' | 'document';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokens: number;
  cached: boolean;
  provider: string;
}

interface CacheEntry {
  embedding: number[];
  model: string;
}

interface EmbeddingEngine {
  spec: EmbeddingModelSpec;
  provider: string;
  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

const MAX_CACHE_ENTRIES = 10_000;
const HASH_DIMENSIONS = 384;

export class EmbeddingService extends EventEmitter {
  private static instance: EmbeddingService | null = null;
  private cache = new Map<string, CacheEntry>();
  private engine: Promise<EmbeddingEngine> | null = null;

  private constructor() {
    super();
  }

  static getInstance(): EmbeddingService {
    if (!this.instance) {
      this.instance = new EmbeddingService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /** The model every vector from this process comes from. */
  async activeModelId(): Promise<string> {
    return (await this.getEngine()).spec.id;
  }

  /** The lowest score that counts as a match for a use, on the active model's scale. */
  async similarityFloor(use: SimilarityUse): Promise<number> {
    return (await this.getEngine()).spec.similarityFloors[use];
  }

  /**
   * Generate an embedding. Pass `'query'` for text being searched with and
   * leave the default for text being stored or compared with stored text.
   */
  async embed(text: string, purpose: EmbeddingPurpose = 'document'): Promise<EmbeddingResult> {
    const [result] = await this.embedBatch([text], purpose);
    return result;
  }

  /** Embed several texts in one model call, reusing any cached results. */
  async embedBatch(
    texts: readonly string[],
    purpose: EmbeddingPurpose = 'document',
  ): Promise<EmbeddingResult[]> {
    const engine = await this.getEngine();
    const results = new Array<EmbeddingResult>(texts.length);
    const missing: number[] = [];

    texts.forEach((text, index) => {
      const cached = this.cache.get(this.cacheKey(engine, purpose, text));
      if (cached) {
        results[index] = { ...cached, tokens: 0, cached: true, provider: 'cache' };
      } else {
        missing.push(index);
      }
    });

    if (missing.length > 0) {
      const vectors = await engine.embed(missing.map((index) => texts[index]), purpose);
      missing.forEach((textIndex, position) => {
        const text = texts[textIndex];
        const embedding = vectors[position];
        this.remember(this.cacheKey(engine, purpose, text), { embedding, model: engine.spec.id });
        results[textIndex] = {
          embedding,
          model: engine.spec.id,
          tokens: sharedEstimateTokens(text),
          cached: false,
          provider: engine.provider,
        };
      });
    }

    return results;
  }

  /**
   * Calculate cosine similarity between two embeddings
   */
  cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) {
      throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (normA * normB);
  }

  /**
   * Find most similar embeddings
   */
  findSimilar(
    queryEmbedding: ArrayLike<number>,
    candidates: { id: string; embedding: ArrayLike<number> }[],
    topK: number,
    minSimilarity: number,
  ): { id: string; similarity: number }[] {
    return candidates
      .map((candidate) => ({
        id: candidate.id,
        similarity: this.cosineSimilarity(queryEmbedding, candidate.embedding),
      }))
      .filter((result) => result.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  private getEngine(): Promise<EmbeddingEngine> {
    this.engine ??= this.loadEngine();
    return this.engine;
  }

  private async loadEngine(): Promise<EmbeddingEngine> {
    const modelDir = resolveEmbeddingModelDir();
    if (!modelDir) {
      logger.warn('Embedding model is not installed; semantic matching will only see shared words');
      return this.hashEngine();
    }
    try {
      const embedder = await OnnxTextEmbedder.load(modelDir, LOCAL_EMBEDDING_MODEL);
      logger.info('Embedding model loaded', { model: LOCAL_EMBEDDING_MODEL.id });
      return {
        spec: LOCAL_EMBEDDING_MODEL,
        provider: 'onnx',
        embed: async (texts, purpose) => {
          const prepared = purpose === 'query'
            ? texts.map((text) => `${LOCAL_EMBEDDING_MODEL.queryInstruction}${text}`)
            : texts;
          return (await embedder.embed(prepared)).map((vector) => Array.from(vector));
        },
      };
    } catch (error) {
      logger.error(
        'Embedding model failed to load; semantic matching will only see shared words',
        error instanceof Error ? error : undefined,
      );
      return this.hashEngine();
    }
  }

  private hashEngine(): EmbeddingEngine {
    return {
      spec: HASH_EMBEDDING_MODEL,
      provider: 'local',
      embed: async (texts) => texts.map((text) => this.hashEmbedding(text)),
    };
  }

  /**
   * Hash words, word pairs and character trigrams into a fixed-size vector.
   */
  private hashEmbedding(text: string): number[] {
    const embedding = Array.from({ length: HASH_DIMENSIONS }, () => 0);

    const normalizedText = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    const words = normalizedText.split(/\s+/).filter((word) => word.length > 2);

    const features: string[] = [...words];
    for (let i = 0; i < words.length - 1; i++) {
      features.push(`${words[i]}_${words[i + 1]}`);
    }
    for (const word of words.slice(0, 50)) {
      for (let i = 0; i < word.length - 2; i++) {
        features.push(word.substring(i, i + 3));
      }
    }

    for (const feature of features) {
      const hash = this.featureHash(feature);
      const index = Math.abs(hash) % HASH_DIMENSIONS;
      embedding[index] += (hash > 0 ? 1 : -1) * (1 / Math.sqrt(features.length));
    }

    const norm = Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0));
    return norm > 0 ? embedding.map((value) => value / norm) : embedding;
  }

  private featureHash(feature: string): number {
    let hash = 0;
    for (let i = 0; i < feature.length; i++) {
      hash = ((hash << 5) - hash) + feature.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash;
  }

  private cacheKey(engine: EmbeddingEngine, purpose: EmbeddingPurpose, text: string): string {
    return createHash('sha1').update(`${engine.spec.id}\0${purpose}\0${text}`).digest('base64');
  }

  private remember(key: string, entry: CacheEntry): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      // Drop the oldest tenth rather than clearing, so a busy session keeps its hot entries.
      const oldest = Array.from(this.cache.keys()).slice(0, Math.floor(MAX_CACHE_ENTRIES / 10));
      for (const staleKey of oldest) this.cache.delete(staleKey);
    }
    this.cache.set(key, entry);
  }
}

// Export singleton getter
export function getEmbeddingService(): EmbeddingService {
  return EmbeddingService.getInstance();
}
