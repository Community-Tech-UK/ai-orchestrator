/**
 * RLM Sections Module
 *
 * Section CRUD operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { ContextSectionRow } from '../rlm-database.types';
import { saveContent, loadContent, deleteContent, shouldStoreInline } from './rlm-content';
import { updateStoreStatsForSection } from './rlm-stores';

/**
 * Add a section to a store.
 */
export function addSection(
  db: SqliteDriver,
  contentDir: string,
  section: {
    id: string;
    storeId: string;
    type: string;
    name: string;
    source?: string;
    startOffset: number;
    endOffset: number;
    tokens: number;
    checksum?: string;
    depth?: number;
    summarizes?: string[];
    parentSummaryId?: string;
    filePath?: string;
    language?: string;
    sourceUrl?: string;
    content: string;
  }
): void {
  const isInline = shouldStoreInline(section.content);
  let contentFile: string | null = null;
  let contentInline: string | null = null;

  if (isInline) {
    contentInline = section.content;
  } else {
    contentFile = saveContent(contentDir, section.id, section.content);
  }

  const stmt = db.prepare(`
    INSERT INTO context_sections
      (id, store_id, type, name, source, start_offset, end_offset, tokens,
       checksum, depth, summarizes_json, parent_summary_id, file_path, language,
       source_url, created_at, content_file, content_inline)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    section.id,
    section.storeId,
    section.type,
    section.name,
    section.source || null,
    section.startOffset,
    section.endOffset,
    section.tokens,
    section.checksum || null,
    section.depth || 0,
    section.summarizes ? JSON.stringify(section.summarizes) : null,
    section.parentSummaryId || null,
    section.filePath || null,
    section.language || null,
    section.sourceUrl || null,
    Date.now(),
    contentFile,
    contentInline
  );

  // Update store stats
  updateStoreStatsForSection(db, section.storeId, section.tokens, section.content.length, 'add');
}

/**
 * Get a section by ID.
 */
export function getSection(db: SqliteDriver, sectionId: string): ContextSectionRow | null {
  const stmt = db.prepare(`
    SELECT * FROM context_sections WHERE id = ?
  `);
  return stmt.get(sectionId) as ContextSectionRow | null;
}

/**
 * Get section content.
 */
export function getSectionContent(
  contentDir: string,
  section: ContextSectionRow
): string {
  if (section.content_inline) {
    return section.content_inline;
  }
  if (section.content_file) {
    return loadContent(contentDir, section.id) || '';
  }
  return '';
}

/**
 * Get sections for a store with optional filtering.
 */
export function getSections(
  db: SqliteDriver,
  storeId: string,
  options?: {
    type?: string;
    minDepth?: number;
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }
): ContextSectionRow[] {
  let query = `SELECT * FROM context_sections WHERE store_id = ?`;
  const params: (string | number)[] = [storeId];

  if (options?.type) {
    query += ` AND type = ?`;
    params.push(options.type);
  }
  if (options?.minDepth !== undefined) {
    query += ` AND depth >= ?`;
    params.push(options.minDepth);
  }
  if (options?.maxDepth !== undefined) {
    query += ` AND depth <= ?`;
    params.push(options.maxDepth);
  }

  query += ` ORDER BY start_offset ASC`;

  if (options?.limit) {
    query += ` LIMIT ?`;
    params.push(options.limit);
    if (options?.offset) {
      query += ` OFFSET ?`;
      params.push(options.offset);
    }
  }

  const stmt = db.prepare(query);
  return stmt.all(...params) as ContextSectionRow[];
}

/**
 * Remove a section.
 */
export function removeSection(
  db: SqliteDriver,
  contentDir: string,
  sectionId: string
): void {
  const section = getSection(db, sectionId);
  if (!section) return;

  // Delete content file if exists
  if (section.content_file) {
    deleteContent(contentDir, sectionId);
  }

  // Update store stats
  const content = getSectionContent(contentDir, section);
  updateStoreStatsForSection(
    db,
    section.store_id,
    section.tokens,
    content.length,
    'remove'
  );

  // Delete section (CASCADE deletes search_index entries)
  const stmt = db.prepare(`DELETE FROM context_sections WHERE id = ?`);
  stmt.run(sectionId);
}
