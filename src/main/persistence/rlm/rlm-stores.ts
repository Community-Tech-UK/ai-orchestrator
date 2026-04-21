/**
 * RLM Stores Module
 *
 * Store CRUD operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { ContextStoreRow, ContextSectionRow } from '../rlm-database.types';
import { deleteContent } from './rlm-content';

/**
 * Create a new context store.
 */
export function createStore(
  db: SqliteDriver,
  store: {
    id: string;
    instanceId: string;
    config?: Record<string, unknown>;
  }
): void {
  const stmt = db.prepare(`
    INSERT INTO context_stores
      (id, instance_id, created_at, last_accessed, config_json)
    VALUES (?, ?, ?, ?, ?)
  `);

  const now = Date.now();
  stmt.run(
    store.id,
    store.instanceId,
    now,
    now,
    store.config ? JSON.stringify(store.config) : null
  );
}

/**
 * Get a store by ID.
 */
export function getStore(db: SqliteDriver, storeId: string): ContextStoreRow | null {
  const stmt = db.prepare(`
    SELECT * FROM context_stores WHERE id = ?
  `);
  return stmt.get(storeId) as ContextStoreRow | null;
}

/**
 * Get a store by instance ID.
 */
export function getStoreByInstance(db: SqliteDriver, instanceId: string): ContextStoreRow | null {
  const stmt = db.prepare(`
    SELECT * FROM context_stores WHERE instance_id = ?
  `);
  return stmt.get(instanceId) as ContextStoreRow | null;
}

/**
 * List all stores.
 */
export function listStores(db: SqliteDriver): ContextStoreRow[] {
  const stmt = db.prepare(`
    SELECT * FROM context_stores ORDER BY last_accessed DESC
  `);
  return stmt.all() as ContextStoreRow[];
}

/**
 * Update store statistics.
 */
export function updateStoreStats(
  db: SqliteDriver,
  storeId: string,
  stats: {
    totalTokens?: number;
    totalSize?: number;
    accessCount?: number;
  }
): void {
  const updates: string[] = ['last_accessed = ?'];
  const params: (string | number)[] = [Date.now()];

  if (stats.totalTokens !== undefined) {
    updates.push('total_tokens = ?');
    params.push(stats.totalTokens);
  }
  if (stats.totalSize !== undefined) {
    updates.push('total_size = ?');
    params.push(stats.totalSize);
  }
  if (stats.accessCount !== undefined) {
    updates.push('access_count = ?');
    params.push(stats.accessCount);
  }

  params.push(storeId);

  const stmt = db.prepare(`
    UPDATE context_stores SET ${updates.join(', ')} WHERE id = ?
  `);
  stmt.run(...params);
}

/**
 * Delete a store and all its content files.
 */
export function deleteStore(
  db: SqliteDriver,
  contentDir: string,
  storeId: string,
  getSections: (storeId: string) => ContextSectionRow[]
): void {
  // Get all sections to delete content files
  const sections = getSections(storeId);
  for (const section of sections) {
    if (section.content_file) {
      deleteContent(contentDir, section.id);
    }
  }

  // CASCADE will delete sections, search_index, sessions
  const stmt = db.prepare(`DELETE FROM context_stores WHERE id = ?`);
  stmt.run(storeId);
}

/**
 * Update store stats for section add/remove.
 */
export function updateStoreStatsForSection(
  db: SqliteDriver,
  storeId: string,
  tokens: number,
  size: number,
  operation: 'add' | 'remove'
): void {
  const multiplier = operation === 'add' ? 1 : -1;
  const stmt = db.prepare(`
    UPDATE context_stores
    SET total_tokens = total_tokens + ?,
        total_size = total_size + ?,
        last_accessed = ?
    WHERE id = ?
  `);
  stmt.run(tokens * multiplier, size * multiplier, Date.now(), storeId);
}
