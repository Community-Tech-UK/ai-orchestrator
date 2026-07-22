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

/**
 * A cached vector.
 *
 * `embedding` is a `Float32Array`, not `number[]` — boxed doubles cost twice the
 * heap for identical maths.
 *
 * `contentPreview` and `metadata` are NOT cached. They are dead weight during
 * ranking (only `embedding` is read) and together accounted for ~300–500 MB
 * across a 238k-vector corpus, so they are hydrated from SQLite for the top-K
 * results only. See {@link VectorStore.hydrate}.
 */
export interface VectorEntry {
  id: string;
  sectionId: string;
  storeId: string;
  embedding: Float32Array;
  contentPreview: string;
  metadata?: Record<string, unknown>;
}

/** The slim shape actually retained in the hot cache. */
interface CachedVector {
  id: string;
  sectionId: string;
  storeId: string;
  embedding: Float32Array;
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
  /**
   * How many stores may be resident at once. Stores load on first use and the
   * least-recently-used are evicted past this cap, so a long-lived process
   * holds the working set rather than every store ever created (1,306 of them
   * on a real profile).
   */
  maxResidentStores: number;
}

const DEFAULT_CONFIG: VectorStoreConfig = {
  autoIndex: true,
  minSimilarity: 0.5,
  defaultTopK: 10,
  indexBatchSize: 50,
  maxResidentStores: 24,
};

export class VectorStore extends EventEmitter {
  private static instance: VectorStore | null = null;
  private db: RLMDatabase;
  private embeddingService: EmbeddingService;
  private config: VectorStoreConfig;

  // In-memory cache for fast similarity search. Populated per store on demand.
  private vectorCache = new Map<string, CachedVector>();
  private storeVectorIds = new Map<string, Set<string>>();
  /** Resident store ids in least-recently-used order (front = coldest). */
  private residentStores: string[] = [];

  private constructor(config: Partial<VectorStoreConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = getRLMDatabase();
    this.embeddingService = getEmbeddingService();
    // Deliberately NOT loading every store here. The eager load pulled all
    // 238k vectors of all 1,306 stores into the main-process heap at boot
    // (~1.1-1.3 GB) and was the single largest retainer in the process.
  }

  static getInstance(config?: Partial<VectorStoreConfig>): VectorStore {
    if (!this.instance) {
      this.instance = new VectorStore(config);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
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
   * Make one store's vectors resident, loading from SQLite on first use and
   * evicting the least-recently-used store once the cap is exceeded.
   *
   * Only the embedding is retained — preview and metadata are fetched later for
   * the handful of rows that actually win the ranking.
   */
  private ensureStoreLoaded(storeId: string): void {
    if (this.storeVectorIds.has(storeId)) {
      this.touchStore(storeId);
      return;
    }

    const storeVectors = new Set<string>();
    try {
      for (const row of this.db.getVectors(storeId)) {
        this.vectorCache.set(row.id, {
          id: row.id,
          sectionId: row.section_id,
          storeId: row.store_id,
          embedding: this.db.bufferToEmbedding(row.embedding),
        });
        storeVectors.add(row.id);
      }
    } catch (error) {
      logger.error('Failed to load store vectors', error instanceof Error ? error : undefined, { storeId });
      this.emit('error', { operation: 'load', error });
      return;
    }

    this.storeVectorIds.set(storeId, storeVectors);
    this.touchStore(storeId);
    this.evictColdStores();

    this.emit('store:loaded', { storeId, vectors: storeVectors.size });
  }

  /** Mark a store as most-recently-used. */
  private touchStore(storeId: string): void {
    const at = this.residentStores.indexOf(storeId);
    if (at >= 0) this.residentStores.splice(at, 1);
    this.residentStores.push(storeId);
  }

  /** Drop least-recently-used stores until within `maxResidentStores`. */
  private evictColdStores(): void {
    const cap = Math.max(1, this.config.maxResidentStores);
    while (this.residentStores.length > cap) {
      const coldest = this.residentStores.shift();
      if (coldest === undefined) break;
      this.evictStore(coldest);
    }
  }

  /** Release a store's vectors from memory. Persistence is untouched. */
  private evictStore(storeId: string): void {
    const ids = this.storeVectorIds.get(storeId);
    if (!ids) return;
    for (const id of ids) this.vectorCache.delete(id);
    this.storeVectorIds.delete(storeId);
    this.emit('store:evicted', { storeId, vectors: ids.size });
  }

  /**
   * Attach preview/metadata to ranked matches by reading the rows back from
   * SQLite. Called for the top-K only, which is why those fields need not sit
   * in the hot cache.
   */
  private hydrate(matches: { id: string; similarity: number }[]): VectorSearchResult[] {
    const results: VectorSearchResult[] = [];

    for (const match of matches) {
      const cached = this.vectorCache.get(match.id);
      if (!cached) continue;

      let contentPreview = '';
      let metadata: Record<string, unknown> | undefined;
      try {
        const row = this.db.getVectorBySectionId(cached.sectionId);
        if (row) {
          contentPreview = row.content_preview || '';
          metadata = row.metadata_json ? JSON.parse(row.metadata_json) : undefined;
        }
      } catch (error) {
        logger.warn('Failed to hydrate vector row', {
          sectionId: cached.sectionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      results.push({
        entry: { ...cached, contentPreview, metadata },
        similarity: match.similarity,
      });
    }

    return results;
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
      embedding: Float32Array.from(embeddingResult.embedding),
      contentPreview: content.substring(0, 500),
      metadata: {
        ...metadata,
        model: embeddingResult.model,
        provider: embeddingResult.provider,
      },
    };

    // Load the store's existing vectors FIRST. Without this, adding to a
    // non-resident store would register a residency entry holding only the new
    // id — the store would then look loaded, and the next search would rank
    // against that single vector instead of the whole store.
    this.ensureStoreLoaded(storeId);

    // Cache the slim projection only; preview/metadata live in SQLite.
    this.vectorCache.set(entry.id, {
      id: entry.id,
      sectionId: entry.sectionId,
      storeId: entry.storeId,
      embedding: entry.embedding,
    });

    // Track by store
    if (!this.storeVectorIds.has(storeId)) {
      this.storeVectorIds.set(storeId, new Set());
    }
    this.storeVectorIds.get(storeId)!.add(entry.id);
    this.touchStore(storeId);

    // Persist to database — ensure FK parents exist first
    try {
      this.ensureStoreExists(storeId);
      this.ensureSectionExists(storeId, sectionId, content);

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
    // Drop from the cache if this section's store happens to be resident.
    for (const [id, entry] of this.vectorCache) {
      if (entry.sectionId === sectionId) {
        this.vectorCache.delete(id);
        this.storeVectorIds.get(entry.storeId)?.delete(id);
        break;
      }
    }

    // Delete from the database unconditionally. Residency is a caching detail;
    // a removal must not become a no-op just because the store is not loaded.
    try {
      this.db.deleteVector(sectionId);
    } catch (error) {
      logger.error('Failed to delete vector', error instanceof Error ? error : undefined);
    }

    this.emit('section:removed', { sectionId });
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

    // Make this store resident (no-op when already loaded).
    this.ensureStoreLoaded(storeId);

    const storeVectors = this.storeVectorIds.get(storeId);
    if (!storeVectors || storeVectors.size === 0) {
      return [];
    }

    // Calculate similarities
    const candidates: { id: string; embedding: ArrayLike<number> }[] = [];
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

    const results = this.hydrate(similar);

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

    // Explicit stores are loaded on demand; without them this searches only
    // what is already resident. Sweeping every store would re-create the
    // load-the-whole-corpus behaviour this cache exists to avoid.
    //
    // Caveat: asking for more stores than `maxResidentStores` evicts the
    // earliest ones before ranking, so results cover only the last N requested.
    // Left as-is because nothing in production calls this; raise the cap for
    // the call if that ever changes.
    if (options?.storeIds) {
      for (const storeId of options.storeIds) this.ensureStoreLoaded(storeId);
    }

    const candidates: { id: string; embedding: ArrayLike<number> }[] = [];

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

    return this.hydrate(similar);
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

    // Without this the store may not be resident, every section would look
    // un-indexed, and the whole store would be needlessly re-embedded.
    this.ensureStoreLoaded(storeId);
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
    // Load first: an unloaded store still has rows on disk, and clearing must
    // delete those rather than silently no-op because nothing is resident.
    this.ensureStoreLoaded(storeId);
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
    const at = this.residentStores.indexOf(storeId);
    if (at >= 0) this.residentStores.splice(at, 1);
    this.emit('store:cleared', { storeId });
  }

  /**
   * Get vector store statistics
   */
  /**
   * Cache occupancy. These are **resident** counts, not corpus totals — with
   * per-store residency the cache holds the working set, not everything on disk.
   */
  getStats(): {
    totalVectors: number;
    storeCount: number;
    storeStats: { storeId: string; vectorCount: number }[];
    residentStores: number;
    maxResidentStores: number;
  } {
    const storeStats: { storeId: string; vectorCount: number }[] = [];

    for (const [storeId, vectors] of this.storeVectorIds) {
      storeStats.push({ storeId, vectorCount: vectors.size });
    }

    return {
      totalVectors: this.vectorCache.size,
      storeCount: this.storeVectorIds.size,
      storeStats,
      residentStores: this.residentStores.length,
      maxResidentStores: this.config.maxResidentStores,
    };
  }

  /**
   * Get entry by section ID
   */
  getEntry(sectionId: string): VectorEntry | undefined {
    // Answer from the database rather than the cache: with per-store residency
    // a cache miss means "not loaded", not "not indexed".
    try {
      const row = this.db.getVectorBySectionId(sectionId);
      if (!row) return undefined;
      return {
        id: row.id,
        sectionId: row.section_id,
        storeId: row.store_id,
        embedding: this.db.bufferToEmbedding(row.embedding),
        contentPreview: row.content_preview || '',
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      };
    } catch (error) {
      logger.warn('Failed to read vector entry', {
        sectionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Check if a section is indexed.
   * Resident stores answer from memory; otherwise fall through to the database.
   */
  isIndexed(storeId: string, sectionId: string): boolean {
    const vectorId = `vec-${storeId}-${sectionId}`;
    if (this.vectorCache.has(vectorId)) return true;
    if (this.storeVectorIds.has(storeId)) return false;

    try {
      return this.db.getVectorBySectionId(sectionId) !== null;
    } catch {
      return false;
    }
  }

  // ============================================
  // Private Helpers — FK parent row creation
  // ============================================

  /** Tracked store IDs we've already ensured exist (avoids repeated DB checks) */
  private ensuredStores = new Set<string>();
  private ensuredSections = new Set<string>();

  /**
   * Ensure a context_stores row exists for the given storeId.
   * Some callers (e.g. ObservationStore) use standalone store IDs
   * that are not tied to a real instance — create a placeholder row
   * so the FK constraint on the vectors table is satisfied.
   */
  private ensureStoreExists(storeId: string): void {
    if (this.ensuredStores.has(storeId)) return;
    try {
      this.db.ensureStore({ id: storeId, instanceId: storeId });
      this.ensuredStores.add(storeId);
    } catch (error) {
      logger.warn('Failed to ensure store exists', { storeId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private ensureSectionExists(storeId: string, sectionId: string, content: string): void {
    if (this.ensuredSections.has(sectionId)) return;
    try {
      this.db.ensureSection({
        id: sectionId,
        storeId,
        type: 'vector-placeholder',
        name: sectionId,
        content,
      });
      this.ensuredSections.add(sectionId);
    } catch (error) {
      logger.warn('Failed to ensure section exists', { sectionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// Export singleton getter
export function getVectorStore(config?: Partial<VectorStoreConfig>): VectorStore {
  return VectorStore.getInstance(config);
}
