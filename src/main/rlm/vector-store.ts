/**
 * Vector Store
 * Stores and retrieves embeddings for semantic search
 * Integrates with RLMDatabase for persistence
 */

import { EventEmitter } from 'events';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { EmbeddingService, getEmbeddingService } from './embedding-service';
import { getLogger } from '../logging/logger';

const logger = getLogger('VectorStore');

export interface VectorEntry {
  id: string;
  sectionId: string;
  storeId: string;
  embedding: number[];
  contentPreview: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  entry: VectorEntry;
  similarity: number;
}

export interface VectorStoreConfig {
  autoIndex: boolean;
  minSimilarity: number;
  defaultTopK: number;
  indexBatchSize: number;
}

const DEFAULT_CONFIG: VectorStoreConfig = {
  autoIndex: true,
  minSimilarity: 0.5,
  defaultTopK: 10,
  indexBatchSize: 50,
};

export class VectorStore extends EventEmitter {
  private static instance: VectorStore;
  private db: RLMDatabase;
  private embeddingService: EmbeddingService;
  private config: VectorStoreConfig;

  // In-memory cache for fast similarity search
  private vectorCache = new Map<string, VectorEntry>();
  private storeVectorIds = new Map<string, Set<string>>();

  private constructor(config: Partial<VectorStoreConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = getRLMDatabase();
    this.embeddingService = getEmbeddingService();
    this.loadFromPersistence();
  }

  static getInstance(config?: Partial<VectorStoreConfig>): VectorStore {
    if (!this.instance) {
      this.instance = new VectorStore(config);
    }
    return this.instance;
  }

  /**
   * Configure the vector store
   */
  configure(config: Partial<VectorStoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): VectorStoreConfig {
    return { ...this.config };
  }

  /**
   * Load vectors from database into memory cache
   */
  private loadFromPersistence(): void {
    try {
      const stores = this.db.listStores();

      for (const store of stores) {
        const vectorRows = this.db.getVectors(store.id);
        const storeVectors = new Set<string>();

        for (const row of vectorRows) {
          const entry: VectorEntry = {
            id: row.id,
            sectionId: row.section_id,
            storeId: row.store_id,
            embedding: this.db.bufferToEmbedding(row.embedding),
            contentPreview: row.content_preview || '',
            metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
          };

          this.vectorCache.set(entry.id, entry);
          storeVectors.add(entry.id);
        }

        this.storeVectorIds.set(store.id, storeVectors);
      }

      this.emit('loaded', {
        stores: stores.length,
        vectors: this.vectorCache.size,
      });
    } catch (error) {
      logger.error('Failed to load from persistence', error instanceof Error ? error : undefined);
      this.emit('error', { operation: 'load', error });
    }
  }

  /**
   * Add a section to the vector store (generates embedding)
   */
  async addSection(
    storeId: string,
    sectionId: string,
    content: string,
    metadata?: Record<string, unknown>
  ): Promise<VectorEntry> {
    // Generate embedding
    const embeddingResult = await this.embeddingService.embed(content);

    const entry: VectorEntry = {
      id: `vec-${storeId}-${sectionId}`,
      sectionId,
      storeId,
      embedding: embeddingResult.embedding,
      contentPreview: content.substring(0, 500),
      metadata: {
        ...metadata,
        model: embeddingResult.model,
        provider: embeddingResult.provider,
      },
    };

    // Add to memory cache
    this.vectorCache.set(entry.id, entry);

    // Track by store
    if (!this.storeVectorIds.has(storeId)) {
      this.storeVectorIds.set(storeId, new Set());
    }
    this.storeVectorIds.get(storeId)!.add(entry.id);

    // Persist to database
    try {
      this.db.addVector({
        id: entry.id,
        storeId,
        sectionId,
        embedding: entry.embedding,
        contentPreview: entry.contentPreview,
        metadata: entry.metadata,
      });
    } catch (error) {
      logger.error('Failed to persist vector', error instanceof Error ? error : undefined);
    }

    this.emit('section:indexed', { sectionId, storeId, dimensions: entry.embedding.length });
    return entry;
  }

  /**
   * Remove a section from the vector store
   */
  removeSection(sectionId: string): void {
    // Find the entry by sectionId
    for (const [id, entry] of this.vectorCache) {
      if (entry.sectionId === sectionId) {
        this.vectorCache.delete(id);

        // Remove from store tracking
        const storeVectors = this.storeVectorIds.get(entry.storeId);
        if (storeVectors) {
          storeVectors.delete(id);
        }

        // Remove from database
        try {
          this.db.deleteVector(sectionId);
        } catch (error) {
          logger.error('Failed to delete vector', error instanceof Error ? error : undefined);
        }

        this.emit('section:removed', { sectionId });
        return;
      }
    }
  }

  /**
   * Search for similar sections within a store
   */
  async search(
    storeId: string,
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
    }
  ): Promise<VectorSearchResult[]> {
    const topK = options?.topK || this.config.defaultTopK;
    const minSimilarity = options?.minSimilarity || this.config.minSimilarity;

    // Generate query embedding
    const queryResult = await this.embeddingService.embed(query);

    // Get vectors for this store
    const storeVectors = this.storeVectorIds.get(storeId);
    if (!storeVectors || storeVectors.size === 0) {
      return [];
    }

    // Calculate similarities
    const candidates: { id: string; embedding: number[] }[] = [];
    for (const vectorId of storeVectors) {
      const entry = this.vectorCache.get(vectorId);
      if (entry) {
        candidates.push({ id: vectorId, embedding: entry.embedding });
      }
    }

    const similar = this.embeddingService.findSimilar(
      queryResult.embedding,
      candidates,
      topK,
      minSimilarity
    );

    // Build results with full entry data
    const results: VectorSearchResult[] = [];
    for (const match of similar) {
      const entry = this.vectorCache.get(match.id);
      if (entry) {
        results.push({
          entry,
          similarity: match.similarity,
        });
      }
    }

    this.emit('search:completed', {
      storeId,
      query: query.substring(0, 100),
      results: results.length,
    });

    return results;
  }

  /**
   * Search across all stores
   */
  async searchAll(
    query: string,
    options?: {
      topK?: number;
      minSimilarity?: number;
      storeIds?: string[];
    }
  ): Promise<VectorSearchResult[]> {
    const topK = options?.topK || this.config.defaultTopK;
    const minSimilarity = options?.minSimilarity || this.config.minSimilarity;

    // Generate query embedding
    const queryResult = await this.embeddingService.embed(query);

    // Get all candidates or filter by storeIds
    const candidates: { id: string; embedding: number[] }[] = [];

    for (const [storeId, vectorIds] of this.storeVectorIds) {
      if (options?.storeIds && !options.storeIds.includes(storeId)) {
        continue;
      }

      for (const vectorId of vectorIds) {
        const entry = this.vectorCache.get(vectorId);
        if (entry) {
          candidates.push({ id: vectorId, embedding: entry.embedding });
        }
      }
    }

    const similar = this.embeddingService.findSimilar(
      queryResult.embedding,
      candidates,
      topK,
      minSimilarity
    );

    // Build results
    const results: VectorSearchResult[] = [];
    for (const match of similar) {
      const entry = this.vectorCache.get(match.id);
      if (entry) {
        results.push({
          entry,
          similarity: match.similarity,
        });
      }
    }

    return results;
  }

  /**
   * Index all sections in a store that don't have vectors yet
   */
  async indexStore(
    storeId: string,
    sections: { id: string; content: string }[]
  ): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;

    const existing = this.storeVectorIds.get(storeId) || new Set();

    for (const section of sections) {
      const vectorId = `vec-${storeId}-${section.id}`;

      // Skip if already indexed
      if (existing.has(vectorId)) {
        skipped++;
        continue;
      }

      try {
        await this.addSection(storeId, section.id, section.content);
        indexed++;

        // Emit progress for batches
        if (indexed % this.config.indexBatchSize === 0) {
          this.emit('indexing:progress', {
            storeId,
            indexed,
            total: sections.length,
          });
        }
      } catch (error) {
        logger.error('Failed to index section', error instanceof Error ? error : undefined, { sectionId: section.id });
      }
    }

    this.emit('indexing:completed', { storeId, indexed, skipped });
    return { indexed, skipped };
  }

  /**
   * Clear all vectors for a store
   */
  clearStore(storeId: string): void {
    const storeVectors = this.storeVectorIds.get(storeId);
    if (!storeVectors) return;

    for (const vectorId of storeVectors) {
      const entry = this.vectorCache.get(vectorId);
      if (entry) {
        this.vectorCache.delete(vectorId);
        try {
          this.db.deleteVector(entry.sectionId);
        } catch (error) {
          logger.error('Failed to delete vector', error instanceof Error ? error : undefined);
        }
      }
    }

    this.storeVectorIds.delete(storeId);
    this.emit('store:cleared', { storeId });
  }

  /**
   * Get vector store statistics
   */
  getStats(): {
    totalVectors: number;
    storeCount: number;
    storeStats: { storeId: string; vectorCount: number }[];
  } {
    const storeStats: { storeId: string; vectorCount: number }[] = [];

    for (const [storeId, vectors] of this.storeVectorIds) {
      storeStats.push({ storeId, vectorCount: vectors.size });
    }

    return {
      totalVectors: this.vectorCache.size,
      storeCount: this.storeVectorIds.size,
      storeStats,
    };
  }

  /**
   * Get entry by section ID
   */
  getEntry(sectionId: string): VectorEntry | undefined {
    for (const entry of this.vectorCache.values()) {
      if (entry.sectionId === sectionId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Check if a section is indexed
   */
  isIndexed(storeId: string, sectionId: string): boolean {
    const vectorId = `vec-${storeId}-${sectionId}`;
    return this.vectorCache.has(vectorId);
  }
}

// Export singleton getter
export function getVectorStore(config?: Partial<VectorStoreConfig>): VectorStore {
  return VectorStore.getInstance(config);
}
