/**
 * RLM Search Module
 *
 * Search index operations.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';
import type { SearchIndexEntry, SearchResultRow, SearchResult, ContextSectionRow } from '../rlm-database.types';
import { getSections, getSectionContent } from './rlm-sections';

/**
 * Index a section for search.
 */
export function indexSection(
  db: SqliteDriver,
  storeId: string,
  sectionId: string,
  content: string
): void {
  // Clear existing index entries for this section
  const clearStmt = db.prepare(`
    DELETE FROM search_index WHERE section_id = ?
  `);
  clearStmt.run(sectionId);

  // Tokenize and index
  const lines = content.split('\n');
  const insertStmt = db.prepare(`
    INSERT INTO search_index (store_id, term, section_id, line_number, position, snippet)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((entries: SearchIndexEntry[]) => {
    for (const entry of entries) {
      insertStmt.run(
        entry.storeId,
        entry.term,
        entry.sectionId,
        entry.lineNumber,
        entry.position,
        entry.snippet
      );
    }
  });

  const entries: SearchIndexEntry[] = [];
  let position = 0;
  const seenTermsInLine = new Set<string>();

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum];
    const words = line.toLowerCase().match(/\b\w{3,}\b/g) || [];
    seenTermsInLine.clear();

    for (const word of words) {
      // Dedupe within same line to avoid index bloat
      if (seenTermsInLine.has(word)) continue;
      seenTermsInLine.add(word);

      entries.push({
        storeId,
        term: word,
        sectionId,
        lineNumber: lineNum + 1,
        position,
        snippet: line.substring(0, 200),
      });
    }
    position += line.length + 1;
  }

  // Batch insert for performance
  insertMany(entries);
}

/**
 * Search the index for a pattern.
 */
export function searchIndex(
  db: SqliteDriver,
  storeId: string,
  pattern: string,
  options?: {
    limit?: number;
    caseSensitive?: boolean;
  }
): SearchResult[] {
  const limit = options?.limit || 100;
  const terms = pattern.toLowerCase().match(/\b\w{3,}\b/g) || [pattern.toLowerCase()];

  // Find sections containing all terms
  const placeholders = terms.map(() => '?').join(',');
  const stmt = db.prepare(`
    SELECT
      si.section_id,
      si.line_number,
      si.position,
      si.snippet,
      cs.type as section_type,
      cs.name as section_name,
      cs.source as section_source,
      COUNT(DISTINCT si.term) as term_matches
    FROM search_index si
    JOIN context_sections cs ON si.section_id = cs.id
    WHERE si.store_id = ?
      AND si.term IN (${placeholders})
    GROUP BY si.section_id, si.line_number
    HAVING term_matches >= ?
    ORDER BY term_matches DESC, si.line_number ASC
    LIMIT ?
  `);

  const minMatches = Math.max(1, Math.ceil(terms.length * 0.5)); // At least 50% of terms
  const results = stmt.all(storeId, ...terms, minMatches, limit) as SearchResultRow[];

  return results.map(r => ({
    sectionId: r.section_id,
    lineNumber: r.line_number,
    position: r.position,
    snippet: r.snippet,
    sectionType: r.section_type,
    sectionName: r.section_name,
    sectionSource: r.section_source,
    relevance: r.term_matches / terms.length,
  }));
}

/**
 * Rebuild the search index for a store.
 */
export function rebuildIndex(
  db: SqliteDriver,
  contentDir: string,
  storeId: string
): number {
  const sections = getSections(db, storeId, { maxDepth: 0 }); // Only original content

  for (const section of sections) {
    const content = getSectionContent(contentDir, section);
    indexSection(db, storeId, section.id, content);
  }

  return sections.length;
}
