/**
 * BM25 Full-Text Search
 *
 * Keyword-based search using SQLite FTS5 with BM25 ranking.
 * Provides fast, accurate text search with snippet generation.
 *
 * Note: This file uses better-sqlite3's db.exec() method for SQL execution,
 * not child_process.exec(). This is safe database SQL execution.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  BM25SearchOptions,
  BM25SearchResult,
} from '../../shared/types/codebase.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('Bm25Search');

// ============================================================================
// BM25Search Class
// ============================================================================

export class BM25Search {
  private db: SqliteDriver;

  constructor(db: SqliteDriver) {
    this.db = db;
  }

  /**
   * Search the FTS5 index using BM25 ranking.
   */
  search(options: BM25SearchOptions): BM25SearchResult[] {
    const {
      query,
      storeId,
      limit = 50,
      offset = 0,
      filePatterns,
      boostSymbols = true,
    } = options;

    if (!query.trim()) {
      return [];
    }

    const ftsQuery = this.buildFTSQuery(query);
    const params: unknown[] = [storeId, ftsQuery];

    let sql = `
      SELECT
        section_id,
        file_path,
        content,
        bm25(code_fts, ${boostSymbols ? '1.0, 0.5, 1.0, 2.0' : '1.0, 1.0, 1.0, 1.0'}) as score,
        snippet(code_fts, 3, '<mark>', '</mark>', '...', 64) as snippet
      FROM code_fts
      WHERE store_id = ? AND code_fts MATCH ?
    `;

    if (filePatterns && filePatterns.length > 0) {
      const patterns = filePatterns.map(() => 'file_path GLOB ?').join(' OR ');
      sql += ` AND (${patterns})`;
      params.push(...filePatterns);
    }

    sql += ` ORDER BY score LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Array<{
        section_id: string;
        file_path: string;
        content: string;
        score: number;
        snippet: string;
      }>;

      const queryTerms = this.extractTerms(query);

      return rows.map((row) => ({
        sectionId: row.section_id,
        filePath: row.file_path,
        content: row.content,
        score: Math.abs(row.score),
        matchedTerms: this.findMatchedTerms(row.content, queryTerms),
        snippet: row.snippet,
      }));
    } catch (error) {
      logger.error('BM25 search error', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Add a document to the FTS5 index.
   */
  addDocument(options: {
    storeId: string;
    sectionId: string;
    filePath: string;
    content: string;
    symbols?: string[];
  }): void {
    const { storeId, sectionId, filePath, content, symbols = [] } = options;

    const sql = `
      INSERT INTO code_fts (store_id, section_id, file_path, content, symbols)
      VALUES (?, ?, ?, ?, ?)
    `;

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(storeId, sectionId, filePath, content, symbols.join(' '));
    } catch (error) {
      logger.error('Failed to add document to FTS index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Remove a document from the FTS5 index.
   */
  removeDocument(sectionId: string): void {
    const sql = `DELETE FROM code_fts WHERE section_id = ?`;

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(sectionId);
    } catch (error) {
      logger.error('Failed to remove document from FTS index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Remove all documents for a store from the FTS5 index.
   */
  clearStore(storeId: string): void {
    const sql = `DELETE FROM code_fts WHERE store_id = ?`;

    try {
      const stmt = this.db.prepare(sql);
      stmt.run(storeId);
    } catch (error) {
      logger.error('Failed to clear store from FTS index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Rebuild the FTS5 index for a store.
   * Uses better-sqlite3 database exec, not child process exec.
   */
  rebuildIndex(): void {
    try {
      const stmt = this.db.prepare(`INSERT INTO code_fts(code_fts) VALUES('optimize')`);
      stmt.run();
    } catch (error) {
      logger.error('Failed to rebuild FTS index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Get FTS5 index statistics.
   */
  getStats(storeId: string): { documentCount: number; uniqueTerms: number } {
    try {
      const countStmt = this.db.prepare(
        `SELECT COUNT(DISTINCT section_id) as count FROM code_fts WHERE store_id = ?`
      );
      const countResult = countStmt.get(storeId) as { count: number } | undefined;

      return {
        documentCount: countResult?.count || 0,
        uniqueTerms: 0,
      };
    } catch (error) {
      return { documentCount: 0, uniqueTerms: 0 };
    }
  }

  private buildFTSQuery(query: string): string {
    const terms = this.extractTerms(query);

    if (terms.length === 0) {
      return '*';
    }

    const queryParts = terms.map((term) => {
      const escaped = this.escapeFTSToken(term);
      if (term.length >= 3) {
        return `"${escaped}"*`;
      }
      return `"${escaped}"`;
    });

    return queryParts.join(' OR ');
  }

  private extractTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\w]/g, ''))
      .filter((t) => t.length > 1);
  }

  private escapeFTSToken(token: string): string {
    return token.replace(/["'\\]/g, '');
  }

  private findMatchedTerms(content: string, queryTerms: string[]): string[] {
    const lowerContent = content.toLowerCase();
    return queryTerms.filter((term) => lowerContent.includes(term));
  }
}

let bm25SearchInstance: BM25Search | null = null;

export function getBM25Search(db: SqliteDriver): BM25Search {
  if (!bm25SearchInstance) {
    bm25SearchInstance = new BM25Search(db);
  }
  return bm25SearchInstance;
}

export function resetBM25Search(): void {
  bm25SearchInstance = null;
}
