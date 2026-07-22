/**
 * RLM Vectors Module
 *
 * Vector operations for semantic search.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { VectorRow } from '../rlm-database.types';

/**
 * An embedding in either representation. Storage and the in-memory cache use
 * `Float32Array` (half the heap of boxed doubles); callers that build embeddings
 * by hand may still pass `number[]`.
 */
export type EmbeddingVector = Float32Array | number[];

/**
 * Add a vector embedding.
 */
export function addVector(
  db: SqliteDriver,
  vector: {
    id: string;
    storeId: string;
    sectionId: string;
    embedding: EmbeddingVector;
    contentPreview?: string;
    metadata?: Record<string, unknown>;
  }
): void {
  const embeddingBuffer = Buffer.from(new Float32Array(vector.embedding).buffer);
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO vectors
      (id, store_id, section_id, embedding, dimensions, content_preview, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    vector.id,
    vector.storeId,
    vector.sectionId,
    embeddingBuffer,
    vector.embedding.length,
    vector.contentPreview || null,
    vector.metadata ? JSON.stringify(vector.metadata) : null,
    Date.now()
  );
}

/**
 * Get all vectors for a store.
 */
export function getVectors(db: SqliteDriver, storeId: string): VectorRow[] {
  const stmt = db.prepare(`SELECT * FROM vectors WHERE store_id = ?`);
  return stmt.all(storeId) as VectorRow[];
}

/**
 * Get a vector by section ID.
 */
export function getVectorBySectionId(db: SqliteDriver, sectionId: string): VectorRow | null {
  const stmt = db.prepare(`SELECT * FROM vectors WHERE section_id = ?`);
  return stmt.get(sectionId) as VectorRow | null;
}

/**
 * Delete a vector by section ID.
 */
export function deleteVector(db: SqliteDriver, sectionId: string): void {
  const stmt = db.prepare(`DELETE FROM vectors WHERE section_id = ?`);
  stmt.run(sectionId);
}

export interface VectorRetentionReport {
  /** Vectors older than the cutoff. */
  matched: number;
  /** Vectors actually deleted — always 0 unless `apply` was set. */
  deleted: number;
  /** Distinct stores those vectors belong to. */
  stores: number;
  /** Approximate bytes of embedding blob the deletion would reclaim. */
  embeddingBytes: number;
  /** Epoch ms cutoff used. */
  cutoff: number;
  applied: boolean;
}

/**
 * Age-based vector retention.
 *
 * Reports by default and only deletes when `apply` is explicitly true — the
 * corpus is months of accumulated memory, so the cutoff should be chosen
 * against real counts rather than guessed.
 */
export function pruneVectorsOlderThan(
  db: SqliteDriver,
  cutoff: number,
  options: { apply?: boolean } = {}
): VectorRetentionReport {
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS matched,
              COUNT(DISTINCT store_id) AS stores,
              COALESCE(SUM(LENGTH(embedding)), 0) AS embedding_bytes
         FROM vectors
        WHERE created_at < ?`
    )
    .get(cutoff) as { matched: number; stores: number; embedding_bytes: number };

  const report: VectorRetentionReport = {
    matched: summary?.matched ?? 0,
    deleted: 0,
    stores: summary?.stores ?? 0,
    embeddingBytes: summary?.embedding_bytes ?? 0,
    cutoff,
    applied: options.apply === true,
  };

  if (options.apply === true && report.matched > 0) {
    db.prepare(`DELETE FROM vectors WHERE created_at < ?`).run(cutoff);
    report.deleted = report.matched;
  }

  return report;
}

/**
 * Convert a buffer back to an embedding.
 *
 * Returns a `Float32Array`, not `number[]`: the previous `Array.from(...)`
 * expanded each 4-byte float into a boxed 8-byte double, doubling the heap cost
 * of every cached vector (~740 MB across a 238k-vector corpus).
 *
 * The result is always a **copy**. `new Float32Array(buffer.buffer, ...)` would
 * be a view onto Node's shared 8 KB allocation pool, so retaining it would pin
 * the whole slab and leak far more than it saves.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
  return new Float32Array(view);
}
