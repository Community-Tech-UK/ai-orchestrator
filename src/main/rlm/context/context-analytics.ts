/**
 * Context Analytics Module
 *
 * Handles analytics and statistics:
 * - Token savings history
 * - Query statistics
 * - Storage statistics
 * - Store statistics
 */

import type {
  ContextStore,
  ContextQueryResult,
  RLMSession,
  RLMStoreStats
} from '../../../shared/types/rlm.types';
import type { RLMDatabase } from '../../persistence/rlm-database';
import type {
  TokenSavingsEntry,
  QueryStatsEntry,
  StorageStats
} from './context.types';

/**
 * Dependencies for analytics operations
 */
export interface AnalyticsDependencies {
  db: RLMDatabase | null;
  persistenceEnabled: boolean;
}

/**
 * Get token savings history for analytics.
 *
 * @param days - Number of days to look back
 * @param sessions - In-memory sessions map
 * @param deps - Analytics dependencies
 * @returns Array of token savings entries by date
 */
export function getTokenSavingsHistory(
  days: number,
  sessions: Map<string, RLMSession>,
  deps: AnalyticsDependencies
): TokenSavingsEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const history = new Map<string, { direct: number; actual: number }>();

  const sessionRows =
    deps.db && deps.persistenceEnabled ? deps.db.listSessions() : [];

  if (sessionRows.length > 0) {
    for (const row of sessionRows) {
      if (row.started_at < cutoff) continue;
      const date = new Date(row.started_at).toISOString().split('T')[0];
      const existing = history.get(date) || { direct: 0, actual: 0 };

      existing.direct += row.estimated_direct_tokens || 0;
      existing.actual +=
        (row.total_root_tokens || 0) + (row.total_sub_query_tokens || 0);
      history.set(date, existing);
    }
  } else {
    for (const session of sessions.values()) {
      if (session.startedAt < cutoff) continue;

      const date = new Date(session.startedAt).toISOString().split('T')[0];
      const existing = history.get(date) || { direct: 0, actual: 0 };

      existing.direct += session.estimatedDirectTokens;
      existing.actual +=
        session.totalRootTokens + session.totalSubQueryTokens;
      history.set(date, existing);
    }
  }

  return Array.from(history.entries())
    .map(([date, data]) => ({
      date,
      directTokens: data.direct,
      actualTokens: data.actual,
      savingsPercent:
        data.direct > 0
          ? ((data.direct - data.actual) / data.direct) * 100
          : 0
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Get query statistics for analytics.
 *
 * @param days - Number of days to look back
 * @param sessions - In-memory sessions map
 * @param deps - Analytics dependencies
 * @returns Array of query stats by type
 */
export function getQueryStats(
  days: number,
  sessions: Map<string, RLMSession>,
  deps: AnalyticsDependencies
): QueryStatsEntry[] {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stats = new Map<
    string,
    { count: number; totalDuration: number; totalTokens: number }
  >();

  const sessionRows =
    deps.db && deps.persistenceEnabled ? deps.db.listSessions() : [];

  if (sessionRows.length > 0) {
    for (const row of sessionRows) {
      if (row.started_at < cutoff) continue;
      if (!row.queries_json) continue;
      const queries = JSON.parse(row.queries_json) as ContextQueryResult[];

      for (const queryResult of queries) {
        const queryType = queryResult.query.type;
        const existing = stats.get(queryType) || {
          count: 0,
          totalDuration: 0,
          totalTokens: 0
        };
        existing.count++;
        existing.totalDuration += queryResult.duration || 0;
        existing.totalTokens += queryResult.tokensUsed || 0;
        stats.set(queryType, existing);
      }
    }
  } else {
    for (const session of sessions.values()) {
      if (session.startedAt < cutoff) continue;

      for (const queryResult of session.queries) {
        const queryType = queryResult.query.type;
        const existing = stats.get(queryType) || {
          count: 0,
          totalDuration: 0,
          totalTokens: 0
        };
        existing.count++;
        existing.totalDuration += queryResult.duration || 0;
        existing.totalTokens += queryResult.tokensUsed || 0;
        stats.set(queryType, existing);
      }
    }
  }

  return Array.from(stats.entries())
    .map(([type, data]) => ({
      type,
      count: data.count,
      avgDuration: data.count > 0 ? data.totalDuration / data.count : 0,
      avgTokens: data.count > 0 ? data.totalTokens / data.count : 0
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get storage statistics for analytics.
 *
 * @param stores - Map of stores
 * @returns Storage statistics
 */
export function getStorageStats(stores: Map<string, ContextStore>): StorageStats {
  let totalSections = 0;
  let totalTokens = 0;
  let totalSize = 0;
  const byType = new Map<string, { count: number; tokens: number }>();

  for (const store of stores.values()) {
    for (const section of store.sections) {
      totalSections++;
      totalTokens += section.tokens;
      totalSize += section.content.length;

      const existing = byType.get(section.type) || { count: 0, tokens: 0 };
      existing.count++;
      existing.tokens += section.tokens;
      byType.set(section.type, existing);
    }
  }

  return {
    totalStores: stores.size,
    totalSections,
    totalTokens,
    totalSizeBytes: totalSize,
    byType: Array.from(byType.entries())
      .map(([type, data]) => ({ type, ...data }))
      .sort((a, b) => b.tokens - a.tokens)
  };
}

/**
 * Get statistics for a specific store.
 *
 * @param store - Store to get stats for
 * @returns Store statistics
 */
export function getStoreStats(store: ContextStore): RLMStoreStats {
  const originalSections = store.sections.filter((s) => s.depth === 0).length;
  const summaries = store.sections.filter((s) => s.depth > 0).length;
  const maxDepth = Math.max(0, ...store.sections.map((s) => s.depth));

  return {
    sections: store.sections.length,
    originalSections,
    summaries,
    totalTokens: store.totalTokens,
    summaryLevels: maxDepth + 1,
    // Deprecated compatibility field; lexical search no longer owns a term index.
    indexedTerms: 0
  };
}
