/**
 * RLM Sections Module
 *
 * Section CRUD operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type {
  ContextSectionMetadataRow,
  ContextSectionFilterMetadataRow,
  ContextSectionRow,
  ContextSectionTypeStatsRow,
  ContextStoreSectionCountRow,
  UnindexedRootSectionRow,
} from '../rlm-database.types';
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
 * Read section metadata for a residency-admitted store without materializing
 * inline payloads. The byte estimate is verified against the actual content
 * by the residency controller before retaining any hydrated content.
 */
export function getSectionMetadata(
  db: SqliteDriver,
  storeId: string,
  options: { limit?: number; offset?: number } = {},
): ContextSectionMetadataRow[] {
  let query = `
    SELECT
      id, store_id, type, name, source, start_offset, end_offset, tokens,
      checksum, depth, summarizes_json, parent_summary_id, file_path, language,
      source_url, created_at, content_file,
      -- Inline values are measured as UTF-8 bytes. File-backed values use the
      -- stored offset span as an estimate; admission verifies actual bytes.
      COALESCE(length(CAST(content_inline AS BLOB)), MAX(end_offset - start_offset, 0))
        AS content_size_bytes
    FROM context_sections
    WHERE store_id = ?
    ORDER BY start_offset ASC
  `;
  const parameters: number[] = [];

  if (options.limit !== undefined) {
    query += ' LIMIT ?';
    parameters.push(options.limit);
    if (options.offset !== undefined) {
      query += ' OFFSET ?';
      parameters.push(options.offset);
    }
  } else if (options.offset !== undefined) {
    query += ' LIMIT -1 OFFSET ?';
    parameters.push(options.offset);
  }

  const stmt = db.prepareCached(query);
  return stmt.all(storeId, ...parameters) as ContextSectionMetadataRow[];
}

/** Read one bounded page of fields needed by codebase indexing filters. */
export function getSectionFilterMetadata(
  db: SqliteDriver,
  storeId: string,
  options: { limit: number; offset: number },
): ContextSectionFilterMetadataRow[] {
  return db.prepareCached(`
    SELECT type, file_path
    FROM context_sections
    WHERE store_id = ?
    ORDER BY start_offset ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(storeId, options.limit, options.offset) as ContextSectionFilterMetadataRow[];
}

/**
 * Return authoritative totals for every persisted store without loading any
 * section row or content payload.
 */
export function getSectionCountsByStore(db: SqliteDriver): ContextStoreSectionCountRow[] {
  const stmt = db.prepareCached(`
    SELECT store_id, COUNT(*) AS section_count
    FROM context_sections
    GROUP BY store_id
  `);
  return stmt.all() as ContextStoreSectionCountRow[];
}

/**
 * Return one row per section type for storage analytics. This projection is
 * independent of the number of stores and never selects inline content.
 */
export function getSectionStatsByType(db: SqliteDriver): ContextSectionTypeStatsRow[] {
  const stmt = db.prepareCached(`
    SELECT
      type,
      COUNT(*) AS section_count,
      COALESCE(SUM(tokens), 0) AS total_tokens
    FROM context_sections
    GROUP BY type
    ORDER BY type ASC
  `);
  return stmt.all() as ContextSectionTypeStatsRow[];
}

/**
 * List root sections whose durable semantic checkpoint is absent.
 *
 * This projection deliberately returns only identifiers and content-location
 * metadata. Repair reads the payload for each returned id separately, so an
 * unchanged store never materializes `content_inline` values.
 */
export function listUnindexedRootSections(
  db: SqliteDriver,
  storeId: string,
  options: { limit?: number } = {},
): UnindexedRootSectionRow[] {
  let query = `
    SELECT
      sections.id,
      sections.store_id,
      sections.type,
      sections.name,
      sections.file_path,
      sections.language,
      sections.content_file,
      CASE WHEN sections.content_inline IS NULL THEN 0 ELSE 1 END AS content_is_inline
    FROM context_sections AS sections
    LEFT JOIN vectors ON vectors.section_id = sections.id
    WHERE sections.store_id = ?
      AND sections.depth = 0
      AND vectors.section_id IS NULL
    ORDER BY sections.start_offset ASC, sections.id ASC
  `;
  const parameters: number[] = [];
  if (options.limit !== undefined) {
    query += ' LIMIT ?';
    parameters.push(options.limit);
  }

  return db.prepareCached(query).all(storeId, ...parameters) as UnindexedRootSectionRow[];
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

  // Delete section and dependent records.
  const stmt = db.prepare(`DELETE FROM context_sections WHERE id = ?`);
  stmt.run(sectionId);
}
