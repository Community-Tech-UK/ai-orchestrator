/**
 * Search Analytics Service
 *
 * Tracks search events using the search_events table for:
 * - Query patterns analysis
 * - Click-through tracking
 * - Search quality metrics
 * - Usage statistics
 *
 * Note: This file uses better-sqlite3's db.run() method for SQL operations,
 * which is safe database SQL insertion. No shell commands are used.
 */

import type Database from 'better-sqlite3';
import type {
  SearchEvent,
  SearchMetrics,
  QueryPattern,
} from '../../shared/types/codebase.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('SearchAnalytics');

// ============================================================================
// Types
// ============================================================================

export interface LogSearchOptions {
  query: string;
  storeId: string;
  resultsCount: number;
  topResultScore: number;
  searchDurationMs: number;
  hydeUsed: boolean;
  rerankUsed: boolean;
}

interface SearchEventRow {
  id: string;
  query: string;
  store_id: string;
  timestamp: number;
  results_count: number;
  top_result_score: number;
  clicked_indices: string;
  search_duration_ms: number;
  hyde_used: number;
  rerank_used: number;
}

interface AggregateRow {
  total: number;
  avg_score: number;
  avg_duration: number;
  zero_results: number;
}

// ============================================================================
// SearchAnalytics Class
// ============================================================================

export class SearchAnalytics {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureTable();
  }

  /**
   * Log a search event.
   */
  logSearch(options: LogSearchOptions): string {
    const id = this.generateId();

    const event: SearchEvent = {
      id,
      query: options.query,
      storeId: options.storeId,
      timestamp: Date.now(),
      resultsCount: options.resultsCount,
      topResultScore: options.topResultScore,
      clickedResults: [],
      searchDurationMs: options.searchDurationMs,
      hydeUsed: options.hydeUsed,
      rerankUsed: options.rerankUsed,
    };

    try {
      const stmt = this.db.prepare(`
        INSERT INTO search_events (
          id, query, store_id, timestamp, results_count,
          top_result_score, clicked_indices, search_duration_ms,
          hyde_used, rerank_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        event.id,
        event.query,
        event.storeId,
        event.timestamp,
        event.resultsCount,
        event.topResultScore,
        JSON.stringify(event.clickedResults),
        event.searchDurationMs,
        event.hydeUsed ? 1 : 0,
        event.rerankUsed ? 1 : 0
      );

      return id;
    } catch (error) {
      logger.error('Failed to log search event', error instanceof Error ? error : undefined);
      return id;
    }
  }

  /**
   * Record a click on a search result.
   */
  recordClick(searchId: string, resultIndex: number): void {
    try {
      // Get current clicked indices
      const stmt = this.db.prepare(`
        SELECT clicked_indices FROM search_events WHERE id = ?
      `);
      const row = stmt.get(searchId) as { clicked_indices: string } | undefined;

      if (!row) return;

      const clicked: number[] = JSON.parse(row.clicked_indices || '[]');
      if (!clicked.includes(resultIndex)) {
        clicked.push(resultIndex);
      }

      // Update the record
      const updateStmt = this.db.prepare(`
        UPDATE search_events SET clicked_indices = ? WHERE id = ?
      `);
      updateStmt.run(JSON.stringify(clicked), searchId);
    } catch (error) {
      logger.error('Failed to record click', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Get aggregate search metrics for a store.
   */
  getMetrics(storeId: string, timeRangeMs?: number): SearchMetrics {
    try {
      let sql = `
        SELECT
          COUNT(*) as total,
          AVG(top_result_score) as avg_score,
          AVG(search_duration_ms) as avg_duration,
          SUM(CASE WHEN results_count = 0 THEN 1 ELSE 0 END) as zero_results
        FROM search_events
        WHERE store_id = ?
      `;

      const params: unknown[] = [storeId];

      if (timeRangeMs) {
        sql += ` AND timestamp > ?`;
        params.push(Date.now() - timeRangeMs);
      }

      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params) as AggregateRow | undefined;

      if (!row || row.total === 0) {
        return {
          totalSearches: 0,
          avgResultScore: 0,
          avgClickDepth: 0,
          zeroResultRate: 0,
          avgSearchDuration: 0,
        };
      }

      // Calculate average click depth
      const clickDepth = this.calculateAvgClickDepth(storeId, timeRangeMs);

      return {
        totalSearches: row.total,
        avgResultScore: row.avg_score || 0,
        avgClickDepth: clickDepth,
        zeroResultRate: (row.zero_results || 0) / row.total,
        avgSearchDuration: row.avg_duration || 0,
      };
    } catch (error) {
      logger.error('Failed to get metrics', error instanceof Error ? error : undefined);
      return {
        totalSearches: 0,
        avgResultScore: 0,
        avgClickDepth: 0,
        zeroResultRate: 0,
        avgSearchDuration: 0,
      };
    }
  }

  /**
   * Get common query patterns.
   */
  getQueryPatterns(storeId: string, limit = 20): QueryPattern[] {
    try {
      // Get frequent queries with aggregated stats
      const stmt = this.db.prepare(`
        SELECT
          query,
          COUNT(*) as frequency,
          AVG(top_result_score) as avg_score,
          AVG(
            CASE
              WHEN clicked_indices != '[]' THEN (
                SELECT AVG(value)
                FROM json_each(clicked_indices)
              )
              ELSE NULL
            END
          ) as avg_click_depth,
          SUM(CASE WHEN results_count > 0 AND clicked_indices != '[]' THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as success_rate
        FROM search_events
        WHERE store_id = ?
        GROUP BY query
        HAVING COUNT(*) > 1
        ORDER BY frequency DESC
        LIMIT ?
      `);

      const rows = stmt.all(storeId, limit) as Array<{
        query: string;
        frequency: number;
        avg_score: number;
        avg_click_depth: number | null;
        success_rate: number;
      }>;

      return rows.map(row => ({
        pattern: row.query,
        frequency: row.frequency,
        avgResultScore: row.avg_score || 0,
        avgClickDepth: row.avg_click_depth || 0,
        successRate: row.success_rate || 0,
      }));
    } catch (error) {
      logger.error('Failed to get query patterns', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get recent search events.
   */
  getRecentSearches(storeId: string, limit = 50): SearchEvent[] {
    try {
      const stmt = this.db.prepare(`
        SELECT *
        FROM search_events
        WHERE store_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `);

      const rows = stmt.all(storeId, limit) as SearchEventRow[];

      return rows.map(row => ({
        id: row.id,
        query: row.query,
        storeId: row.store_id,
        timestamp: row.timestamp,
        resultsCount: row.results_count,
        topResultScore: row.top_result_score,
        clickedResults: JSON.parse(row.clicked_indices || '[]'),
        searchDurationMs: row.search_duration_ms,
        hydeUsed: row.hyde_used === 1,
        rerankUsed: row.rerank_used === 1,
      }));
    } catch (error) {
      logger.error('Failed to get recent searches', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Clear old search events.
   */
  cleanupOldEvents(retentionDays = 30): number {
    try {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

      const stmt = this.db.prepare(`
        DELETE FROM search_events WHERE timestamp < ?
      `);

      const result = stmt.run(cutoff);
      return result.changes;
    } catch (error) {
      logger.error('Failed to cleanup old events', error instanceof Error ? error : undefined);
      return 0;
    }
  }

  /**
   * Get HyDE effectiveness metrics.
   */
  getHyDEEffectiveness(storeId: string): { withHyDE: number; withoutHyDE: number } {
    try {
      const stmt = this.db.prepare(`
        SELECT
          hyde_used,
          AVG(top_result_score) as avg_score
        FROM search_events
        WHERE store_id = ? AND results_count > 0
        GROUP BY hyde_used
      `);

      const rows = stmt.all(storeId) as Array<{ hyde_used: number; avg_score: number }>;

      const result = { withHyDE: 0, withoutHyDE: 0 };

      for (const row of rows) {
        if (row.hyde_used === 1) {
          result.withHyDE = row.avg_score || 0;
        } else {
          result.withoutHyDE = row.avg_score || 0;
        }
      }

      return result;
    } catch (error) {
      logger.error('Failed to get HyDE effectiveness', error instanceof Error ? error : undefined);
      return { withHyDE: 0, withoutHyDE: 0 };
    }
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Ensure the search_events table exists.
   * Uses better-sqlite3's database methods for safe SQL table creation.
   */
  private ensureTable(): void {
    try {
      // Use prepare().run() for safe SQL table creation
      const createTableStmt = this.db.prepare(`
        CREATE TABLE IF NOT EXISTS search_events (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          store_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          results_count INTEGER NOT NULL,
          top_result_score REAL,
          clicked_indices TEXT DEFAULT '[]',
          search_duration_ms INTEGER,
          hyde_used INTEGER DEFAULT 0,
          rerank_used INTEGER DEFAULT 0
        )
      `);
      createTableStmt.run();

      const createStoreIndexStmt = this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_search_events_store
          ON search_events(store_id)
      `);
      createStoreIndexStmt.run();

      const createTimestampIndexStmt = this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_search_events_timestamp
          ON search_events(timestamp)
      `);
      createTimestampIndexStmt.run();

      const createQueryIndexStmt = this.db.prepare(`
        CREATE INDEX IF NOT EXISTS idx_search_events_query
          ON search_events(query)
      `);
      createQueryIndexStmt.run();
    } catch (error) {
      // Table might already exist
      logger.debug('Search events table setup', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private generateId(): string {
    return `search-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private calculateAvgClickDepth(storeId: string, timeRangeMs?: number): number {
    try {
      let sql = `
        SELECT clicked_indices
        FROM search_events
        WHERE store_id = ? AND clicked_indices != '[]'
      `;

      const params: unknown[] = [storeId];

      if (timeRangeMs) {
        sql += ` AND timestamp > ?`;
        params.push(Date.now() - timeRangeMs);
      }

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as Array<{ clicked_indices: string }>;

      if (rows.length === 0) return 0;

      let totalClicks = 0;
      let totalDepth = 0;

      for (const row of rows) {
        const clicked: number[] = JSON.parse(row.clicked_indices);
        if (clicked.length > 0) {
          totalClicks += clicked.length;
          totalDepth += clicked.reduce((sum, idx) => sum + idx, 0);
        }
      }

      return totalClicks > 0 ? totalDepth / totalClicks : 0;
    } catch {
      return 0;
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let searchAnalyticsInstance: SearchAnalytics | null = null;

export function getSearchAnalytics(db: Database.Database): SearchAnalytics {
  if (!searchAnalyticsInstance) {
    searchAnalyticsInstance = new SearchAnalytics(db);
  }
  return searchAnalyticsInstance;
}

export function resetSearchAnalytics(): void {
  searchAnalyticsInstance = null;
}
