/**
 * Token Stats Service
 *
 * Lightweight service for tracking where context tokens go across instances.
 * Enables measuring the impact of token-efficient tool use and identifying
 * optimization opportunities.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('TokenStats');

// ============================================
// Types
// ============================================

export type ToolType =
  | 'file_read'
  | 'file_write'
  | 'grep'
  | 'glob'
  | 'bash'
  | 'child_transcript'
  | 'user_message'
  | 'assistant_response'
  | 'context_injection'
  | 'other';

export interface TokenStatsEntry {
  instanceId: string;
  sessionId?: string;
  toolType: ToolType;
  tokenCount: number;
  charCount: number;
  truncated?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TokenStatsByType {
  count: number;
  tokens: number;
  avgTokens: number;
  maxTokens: number;
}

export interface TokenStatsSummary {
  totalTokens: number;
  totalMessages: number;
  byToolType: Record<string, TokenStatsByType>;
  largestMessages: { toolType: ToolType; tokens: number; timestamp: number }[];
  timeRange: { start: number; end: number };
}

interface TokenStatsRow {
  id: number;
  timestamp: number;
  instance_id: string;
  session_id: string | null;
  tool_type: string;
  token_count: number;
  char_count: number;
  truncated: number;
  metadata: string | null;
}

// ============================================
// Tool type classification
// ============================================

const FILE_READ_TOOLS = new Set([
  'Read', 'read_file', 'view', 'cat', 'read',
  'str_replace_based_edit', 'file_read'
]);

const FILE_WRITE_TOOLS = new Set([
  'Write', 'write_file', 'create_file', 'Edit', 'edit',
  'str_replace_editor', 'file_write', 'write'
]);

const GREP_TOOLS = new Set([
  'Grep', 'grep', 'search_files', 'ripgrep', 'find_in_file'
]);

const GLOB_TOOLS = new Set([
  'Glob', 'glob', 'list_files', 'find_files', 'ls'
]);

const BASH_TOOLS = new Set([
  'Bash', 'bash', 'shell', 'run_command', 'execute', 'terminal', 'exec'
]);

/**
 * Classify a message into a ToolType based on its type and metadata.
 */
export function classifyToolType(message: OutputMessage): ToolType {
  const type = message.type;

  if (type === 'user') {
    return 'user_message';
  }

  if (type === 'assistant') {
    return 'assistant_response';
  }

  if (type === 'system') {
    return 'context_injection';
  }

  if (type === 'tool_use' || type === 'tool_result') {
    const metadata = message.metadata as Record<string, unknown> | undefined;
    const toolName = (metadata?.['name'] as string) || (metadata?.['toolName'] as string) || '';

    if (FILE_READ_TOOLS.has(toolName)) return 'file_read';
    if (FILE_WRITE_TOOLS.has(toolName)) return 'file_write';
    if (GREP_TOOLS.has(toolName)) return 'grep';
    if (GLOB_TOOLS.has(toolName)) return 'glob';
    if (BASH_TOOLS.has(toolName)) return 'bash';

    // Check for child transcript patterns
    const content = typeof message.content === 'string' ? message.content : '';
    if (content.includes('child_output') || content.includes('transcript') || toolName.includes('child')) {
      return 'child_transcript';
    }

    return 'other';
  }

  return 'other';
}

// ============================================
// Service
// ============================================

export class TokenStatsService {
  private static instance: TokenStatsService | null = null;
  private db: SqliteDriver | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private insertStmt: any | null = null;
  private ready = false;

  private constructor(db: SqliteDriver | null) {
    if (db) {
      this.initWithDb(db);
    }
  }

  static getInstance(db?: SqliteDriver | null): TokenStatsService {
    if (!this.instance) {
      this.instance = new TokenStatsService(db ?? null);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private initWithDb(db: SqliteDriver): void {
    this.db = db;
    try {
      // The table is created via migration; prepare insert statement
      this.insertStmt = db.prepare(`
        INSERT INTO token_stats
          (timestamp, instance_id, session_id, tool_type, token_count, char_count, truncated, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.ready = true;
      logger.info('TokenStatsService initialized');
    } catch (err) {
      logger.warn('TokenStatsService could not prepare statements — stats will be skipped', { error: String(err) });
      this.ready = false;
    }
  }

  /**
   * Provide (or replace) the database connection.
   * Call this once the RLM database is available.
   */
  setDatabase(db: SqliteDriver): void {
    this.initWithDb(db);
  }

  /**
   * Classify a message into a ToolType.
   * Exposed as an instance method so callers using the service instance don't
   * need to import the standalone function separately.
   */
  classifyToolType(message: OutputMessage): ToolType {
    return classifyToolType(message);
  }

  /**
   * Record a token stats entry. Synchronous — SQLite writes are fast and
   * non-blocking in WAL mode. Stats are best-effort; errors are swallowed.
   */
  record(entry: TokenStatsEntry): void {
    if (!this.ready || !this.insertStmt) {
      return;
    }

    try {
      this.insertStmt.run(
        Date.now(),
        entry.instanceId,
        entry.sessionId ?? null,
        entry.toolType,
        entry.tokenCount,
        entry.charCount,
        entry.truncated ? 1 : 0,
        entry.metadata ? JSON.stringify(entry.metadata) : null
      );
    } catch (err) {
      // Stats are best-effort — never propagate errors
      logger.warn('Failed to record token stat', { error: String(err) });
    }
  }

  /**
   * Execute a dynamically-built query with optional parameters.
   * Uses `any` to avoid TypeScript arity issues with better-sqlite3's
   * variadic spread when params length is not statically known.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryGet(sql: string, params: (string | number)[]): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db!.prepare(sql) as any).get(...params);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queryAll(sql: string, params: (string | number)[]): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this.db!.prepare(sql) as any).all(...params);
  }

  /**
   * Get a summary of token usage across all instances or a specific instance.
   */
  getSummary(options?: { instanceId?: string; since?: number; until?: number }): TokenStatsSummary | null {
    if (!this.ready || !this.db) return null;

    try {
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options?.instanceId) {
        conditions.push('instance_id = ?');
        params.push(options.instanceId);
      }
      if (options?.since) {
        conditions.push('timestamp >= ?');
        params.push(options.since);
      }
      if (options?.until) {
        conditions.push('timestamp <= ?');
        params.push(options.until);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const totalsRow = this.queryGet(`
        SELECT
          COUNT(*) as total_messages,
          COALESCE(SUM(token_count), 0) as total_tokens,
          COALESCE(MIN(timestamp), 0) as time_start,
          COALESCE(MAX(timestamp), 0) as time_end
        FROM token_stats ${where}
      `, params) as { total_messages: number; total_tokens: number; time_start: number; time_end: number } | undefined;

      if (!totalsRow) {
        return null;
      }

      const byTypeRows = this.queryAll(`
        SELECT
          tool_type,
          COUNT(*) as count,
          SUM(token_count) as tokens,
          AVG(token_count) as avg_tokens,
          MAX(token_count) as max_tokens
        FROM token_stats ${where}
        GROUP BY tool_type
      `, params) as {
        tool_type: string;
        count: number;
        tokens: number;
        avg_tokens: number;
        max_tokens: number;
      }[];

      const largestRows = this.queryAll(`
        SELECT tool_type, token_count, timestamp
        FROM token_stats ${where}
        ORDER BY token_count DESC
        LIMIT 10
      `, params) as { tool_type: string; token_count: number; timestamp: number }[];

      const byToolType: Record<string, TokenStatsByType> = {};
      for (const row of byTypeRows) {
        byToolType[row.tool_type] = {
          count: row.count,
          tokens: row.tokens,
          avgTokens: Math.round(row.avg_tokens),
          maxTokens: row.max_tokens,
        };
      }

      return {
        totalTokens: totalsRow.total_tokens,
        totalMessages: totalsRow.total_messages,
        byToolType,
        largestMessages: largestRows.map(r => ({
          toolType: r.tool_type as ToolType,
          tokens: r.token_count,
          timestamp: r.timestamp,
        })),
        timeRange: {
          start: totalsRow.time_start,
          end: totalsRow.time_end,
        },
      };
    } catch (err) {
      logger.warn('getSummary failed', { error: String(err) });
      return null;
    }
  }

  /**
   * Get the N most recent token stats entries.
   */
  getRecent(options?: { instanceId?: string; limit?: number }): TokenStatsRow[] {
    if (!this.ready || !this.db) return [];

    try {
      const limit = options?.limit ?? 100;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options?.instanceId) {
        conditions.push('instance_id = ?');
        params.push(options.instanceId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      return this.queryAll(`
        SELECT * FROM token_stats ${where}
        ORDER BY timestamp DESC
        LIMIT ?
      `, [...params, limit]) as TokenStatsRow[];
    } catch (err) {
      logger.warn('getRecent failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Get the N largest messages by token count.
   */
  getLargest(options?: { instanceId?: string; limit?: number }): TokenStatsRow[] {
    if (!this.ready || !this.db) return [];

    try {
      const limit = options?.limit ?? 20;
      const conditions: string[] = [];
      const params: (string | number)[] = [];

      if (options?.instanceId) {
        conditions.push('instance_id = ?');
        params.push(options.instanceId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      return this.queryAll(`
        SELECT * FROM token_stats ${where}
        ORDER BY token_count DESC
        LIMIT ?
      `, [...params, limit]) as TokenStatsRow[];
    } catch (err) {
      logger.warn('getLargest failed', { error: String(err) });
      return [];
    }
  }

  /**
   * Delete token stats older than `olderThanMs` milliseconds.
   * Returns the number of rows deleted.
   */
  cleanup(olderThanMs: number): number {
    if (!this.ready || !this.db) return 0;

    try {
      const cutoff = Date.now() - olderThanMs;
      const result = this.db.prepare(
        'DELETE FROM token_stats WHERE timestamp < ?'
      ).run(cutoff);
      const deleted = result.changes;
      logger.info('TokenStats cleanup complete', { deleted, cutoffMs: cutoff });
      return deleted;
    } catch (err) {
      logger.warn('cleanup failed', { error: String(err) });
      return 0;
    }
  }
}

// ============================================
// Singleton getter
// ============================================

export function getTokenStatsService(db?: SqliteDriver | null): TokenStatsService {
  return TokenStatsService.getInstance(db);
}
