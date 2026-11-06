/**
 * Moves a store's older vectors onto the active embedding model, in the background.
 *
 * Vectors from different models cannot be compared, so a store's older vectors
 * are invisible to search until they are converted. Searching must never wait
 * for that, because a store can hold tens of thousands of sections, and a search
 * meanwhile simply sees fewer vectors. A store converts the first time it is
 * searched, so the many old sessions nobody returns to cost nothing.
 */

import type { RLMDatabase } from '../persistence/rlm-database';
import type { VectorRow } from '../persistence/rlm-database.types';
import { getLogger } from '../logging/logger';
import type { EmbeddingResult } from './embedding-service';
import { HASH_EMBEDDING_MODEL } from './embedding/embedding-model';

const logger = getLogger('VectorReembedder');

/**
 * Conversion shares the model with searches, so a search can only ever wait
 * behind one of these batches. Keeping them small protects the send deadline.
 */
const BATCH_SIZE = 4;
const PAUSE_MS = 200;

export interface ConvertedVector {
  id: string;
  sectionId: string;
  storeId: string;
  embedding: Float32Array;
}

export interface VectorReembedderDeps {
  db: RLMDatabase;
  embedDocuments: (texts: string[]) => Promise<EmbeddingResult[]>;
  /** Lets a store that is already in memory see a converted vector straight away. */
  onConverted: (vector: ConvertedVector) => void;
}

/** A damaged row must not stop its whole store converting. */
function parseMetadata(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export class VectorReembedder {
  /** Stores this process has finished converting. */
  private readonly finished = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly cancelled = new Set<string>();
  /** One store converts at a time, or several would queue ahead of searches. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VectorReembedderDeps) {}

  /** Convert a store if it may hold older vectors. Returns at once. */
  schedule(storeId: string, model: string): void {
    // The hash is only a fallback, so it never replaces vectors from a real model.
    if (model === HASH_EMBEDDING_MODEL.id || this.finished.has(storeId) || this.pending.has(storeId)) {
      return;
    }
    this.pending.add(storeId);
    this.queue = this.queue
      .then(() => this.convertStore(storeId, model))
      .then(() => {
        if (!this.cancelled.has(storeId)) this.finished.add(storeId);
      })
      .catch((error: unknown) => {
        logger.warn('Re-embedding stopped; it will resume on the next search of this store', {
          storeId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.pending.delete(storeId);
        this.cancelled.delete(storeId);
      });
  }

  /** Stop converting a store whose vectors are being cleared, so none come back. */
  cancel(storeId: string): void {
    if (this.pending.has(storeId)) this.cancelled.add(storeId);
  }

  private async convertStore(storeId: string, model: string): Promise<void> {
    const { db } = this.deps;
    let converted = 0;
    while (!this.cancelled.has(storeId)) {
      const rows = db.listStaleVectors(storeId, model, BATCH_SIZE);
      if (rows.length === 0) break;

      const results = await this.deps.embedDocuments(rows.map((row) => this.sectionText(row)));
      if (this.cancelled.has(storeId)) break;
      rows.forEach((row, index) => {
        if (this.persist(row, results[index])) converted += 1;
      });
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
    if (converted > 0) {
      logger.info('Re-embedded store on the active model', { storeId, converted, model });
    }
  }

  private persist(row: VectorRow, result: EmbeddingResult): boolean {
    const embedding = Float32Array.from(result.embedding);
    const persisted = this.deps.db.addVectorForExistingSection({
      id: row.id,
      storeId: row.store_id,
      sectionId: row.section_id,
      embedding,
      contentPreview: row.content_preview ?? undefined,
      metadata: { ...parseMetadata(row.metadata_json), model: result.model, provider: result.provider },
    });
    if (!persisted) {
      // Its section has gone, so it can never convert. Left in place it would loop forever.
      this.deps.db.deleteVector(row.section_id);
      return false;
    }
    this.deps.onConverted({ id: row.id, sectionId: row.section_id, storeId: row.store_id, embedding });
    return true;
  }

  /** The text behind an old vector. Falls back to its preview if the section can't be read. */
  private sectionText(row: VectorRow): string {
    try {
      const section = this.deps.db.getSection(row.section_id);
      if (section) return this.deps.db.getSectionContent(section) || row.content_preview || '';
    } catch (error) {
      logger.debug('Using the stored preview to re-embed a section', {
        sectionId: row.section_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return row.content_preview ?? '';
  }
}
