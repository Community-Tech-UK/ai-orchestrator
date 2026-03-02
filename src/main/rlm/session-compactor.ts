/**
 * RLM Session Compactor
 *
 * Implements rolling window archival for long-running sessions.
 * After N turns or K tokens, summarizes oldest queries/responses,
 * archives raw turns to database, and replaces with summary in active prompt.
 *
 * This prevents context rot during long sessions by keeping the
 * active context window fresh while preserving full history.
 */

import { EventEmitter } from 'events';
import { RLMSession, ContextQueryResult } from '../../shared/types/rlm.types';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { LLMService, getLLMService } from './llm-service';
import { getTokenCounter, TokenCounter } from './token-counter';
import { getLogger } from '../logging/logger';

const logger = getLogger('SessionCompactor');

// Database interface for raw SQL access
interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    all(...params: unknown[]): unknown[];
  };
}

interface RLMDatabaseWithRaw {
  db: SQLiteDatabase;
}

interface ArchivedTurnRow {
  id: string;
  session_id: string;
  turn_index: number;
  query_json: string;
  archived_at: number;
  summary_id: string | null;
}

interface CompactionSummaryRow {
  id: string;
  session_id: string;
  turns_archived_json: string;
  summary: string;
  tokens: number;
  created_at: number;
}

export interface SessionCompactorConfig {
  /** Maximum number of turns before compaction (default: 20) */
  maxTurns: number;
  /** Maximum tokens before compaction (default: 30000) */
  maxTokens: number;
  /** Number of recent turns to keep uncompacted (default: 5) */
  keepRecentTurns: number;
  /** Target token count for archived turn summaries (default: 500) */
  summaryTargetTokens: number;
  /** Enable automatic compaction (default: true) */
  autoCompact: boolean;
  /** Minimum turns to archive at once (default: 5) */
  minArchiveBatch: number;
}

export interface ArchivedTurn {
  id: string;
  sessionId: string;
  turnIndex: number;
  query: ContextQueryResult;
  archivedAt: number;
  summaryId?: string;
}

export interface CompactionSummary {
  id: string;
  sessionId: string;
  turnsArchived: number[];
  summary: string;
  tokens: number;
  createdAt: number;
}

export interface CompactionResult {
  success: boolean;
  turnsArchived: number;
  tokensFreed: number;
  summaryTokens: number;
  error?: string;
}

export interface CompactorStats {
  totalCompactions: number;
  turnsArchived: number;
  tokensFreed: number;
  summaryTokensUsed: number;
  lastCompactionAt: number | null;
}

const DEFAULT_CONFIG: SessionCompactorConfig = {
  maxTurns: 20,
  maxTokens: 30000,
  keepRecentTurns: 5,
  summaryTargetTokens: 500,
  autoCompact: true,
  minArchiveBatch: 5
};

export class SessionCompactor extends EventEmitter {
  private config: SessionCompactorConfig;
  private db: RLMDatabase | null = null;
  private llmService: LLMService | null = null;
  private tokenCounter: TokenCounter;
  private stats: CompactorStats = {
    totalCompactions: 0,
    turnsArchived: 0,
    tokensFreed: 0,
    summaryTokensUsed: 0,
    lastCompactionAt: null
  };

  // Track compaction summaries per session
  private sessionSummaries = new Map<string, CompactionSummary[]>();
  private archivedTurns = new Map<string, ArchivedTurn[]>();

  constructor(config: Partial<SessionCompactorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = getTokenCounter();
  }

  /**
   * Initialize with database and LLM service
   */
  initialize(): void {
    try {
      this.db = getRLMDatabase();
      this.llmService = getLLMService();
      this.ensureArchiveTables();
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize', error instanceof Error ? error : undefined);
      this.emit('error', { phase: 'initialization', error });
    }
  }

  /**
   * Ensure archive tables exist in database
   */
  private ensureArchiveTables(): void {
    if (!this.db) return;

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;

      // Table for archived turns
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_archived_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turn_index INTEGER NOT NULL,
          query_json TEXT NOT NULL,
          archived_at INTEGER NOT NULL,
          summary_id TEXT,
          FOREIGN KEY (session_id) REFERENCES rlm_sessions(id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_archived_turns_session 
          ON session_archived_turns(session_id);
      `);

      // Table for compaction summaries
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_compaction_summaries (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          turns_archived_json TEXT NOT NULL,
          summary TEXT NOT NULL,
          tokens INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES rlm_sessions(id) ON DELETE CASCADE
        );
        
        CREATE INDEX IF NOT EXISTS idx_compaction_summaries_session 
          ON session_compaction_summaries(session_id);
      `);

      logger.info('Archive tables ensured');
    } catch (error) {
      logger.warn('Could not create archive tables', { error });
    }
  }

  /**
   * Check if a session needs compaction
   */
  needsCompaction(session: RLMSession): boolean {
    const turnCount = session.queries.length;
    const totalTokens = session.totalRootTokens + session.totalSubQueryTokens;

    return (
      turnCount > this.config.maxTurns || totalTokens > this.config.maxTokens
    );
  }

  /**
   * Compact a session if needed
   */
  async compactIfNeeded(session: RLMSession): Promise<CompactionResult | null> {
    if (!this.config.autoCompact) return null;
    if (!this.needsCompaction(session)) return null;

    return this.compact(session);
  }

  /**
   * Compact a session by archiving old turns and creating a summary
   */
  async compact(session: RLMSession): Promise<CompactionResult> {
    if (!this.llmService || !this.db) {
      return {
        success: false,
        turnsArchived: 0,
        tokensFreed: 0,
        summaryTokens: 0,
        error: 'Services not initialized'
      };
    }

    const totalTurns = session.queries.length;
    const turnsToKeep = this.config.keepRecentTurns;
    const turnsToArchive = Math.max(0, totalTurns - turnsToKeep);

    if (turnsToArchive < this.config.minArchiveBatch) {
      return {
        success: false,
        turnsArchived: 0,
        tokensFreed: 0,
        summaryTokens: 0,
        error: `Not enough turns to archive (${turnsToArchive} < ${this.config.minArchiveBatch})`
      };
    }

    logger.info('Compacting session', { sessionId: session.id, turnsToArchive });
    this.emit('compaction:started', { sessionId: session.id, turnsToArchive });

    try {
      // Extract turns to archive
      const turnsForArchival = session.queries.slice(0, turnsToArchive);
      const turnIndices = turnsForArchival.map((_, i) => i);

      // Calculate tokens in archived turns
      const tokensInArchived = turnsForArchival.reduce(
        (sum, turn) => sum + turn.tokensUsed,
        0
      );

      // Generate summary of archived turns
      const summaryContent =
        await this.generateArchiveSummary(turnsForArchival);
      const summaryTokens = this.tokenCounter.countTokens(summaryContent);

      // Store archived turns in database
      await this.archiveTurns(session.id, turnsForArchival);

      // Create and store compaction summary
      const compactionSummary = await this.storeCompactionSummary(
        session.id,
        turnIndices,
        summaryContent,
        summaryTokens
      );

      // Update session: remove archived queries and update token counts
      session.queries = session.queries.slice(turnsToArchive);
      session.totalRootTokens -= tokensInArchived;
      // Add summary to session's context via a synthetic query result
      const syntheticResult: ContextQueryResult = {
        query: { type: 'summarize', params: { archived: true } },
        result: `[Archived ${turnsToArchive} earlier turns]\n\n${summaryContent}`,
        tokensUsed: summaryTokens,
        sectionsAccessed: [],
        duration: 0,
        depth: 0
      };
      session.queries.unshift(syntheticResult);
      session.totalRootTokens += summaryTokens;

      // Update stats
      this.stats.totalCompactions++;
      this.stats.turnsArchived += turnsToArchive;
      this.stats.tokensFreed += tokensInArchived - summaryTokens;
      this.stats.summaryTokensUsed += summaryTokens;
      this.stats.lastCompactionAt = Date.now();

      const result: CompactionResult = {
        success: true,
        turnsArchived: turnsToArchive,
        tokensFreed: tokensInArchived - summaryTokens,
        summaryTokens
      };

      this.emit('compaction:completed', {
        sessionId: session.id,
        result,
        summaryId: compactionSummary.id
      });

      return result;
    } catch (error) {
      logger.error('Compaction failed', error instanceof Error ? error : undefined);
      this.emit('compaction:failed', { sessionId: session.id, error });

      return {
        success: false,
        turnsArchived: 0,
        tokensFreed: 0,
        summaryTokens: 0,
        error: (error as Error).message
      };
    }
  }

  /**
   * Generate a summary of archived turns
   */
  private async generateArchiveSummary(
    turns: ContextQueryResult[]
  ): Promise<string> {
    if (!this.llmService) throw new Error('LLM service not initialized');

    // Build content from turns
    const turnContent = turns
      .map((turn, i) => {
        const queryType = turn.query.type;
        const queryParams = JSON.stringify(turn.query.params).slice(0, 100);
        const resultPreview = turn.result.slice(0, 500);
        return `Turn ${i + 1} (${queryType}): ${queryParams}\nResult: ${resultPreview}...`;
      })
      .join('\n\n---\n\n');

    const summary = await this.llmService.summarize({
      requestId: `compact-${Date.now()}`,
      content: `The following is a conversation history from a coding assistant session. 
Summarize the key activities, decisions, and outcomes. Focus on:
1. What tasks were attempted
2. Key code changes or discoveries
3. Any problems encountered and how they were resolved
4. Important context that should be remembered

CONVERSATION HISTORY:
${turnContent}`,
      targetTokens: this.config.summaryTargetTokens,
      preserveKeyPoints: true
    });

    return summary;
  }

  /**
   * Archive turns to database
   */
  private async archiveTurns(
    sessionId: string,
    turns: ContextQueryResult[]
  ): Promise<void> {
    if (!this.db) return;

    const db = (this.db as unknown as RLMDatabaseWithRaw).db;
    const stmt = db.prepare(`
      INSERT INTO session_archived_turns (id, session_id, turn_index, query_json, archived_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    const timestamp = Date.now();
    const archived: ArchivedTurn[] = [];

    for (let i = 0; i < turns.length; i++) {
      const id = `arch-${sessionId}-${i}-${Date.now()}`;
      stmt.run(id, sessionId, i, JSON.stringify(turns[i]), timestamp);

      archived.push({
        id,
        sessionId,
        turnIndex: i,
        query: turns[i],
        archivedAt: timestamp
      });
    }

    // Update in-memory cache
    const existing = this.archivedTurns.get(sessionId) || [];
    this.archivedTurns.set(sessionId, [...existing, ...archived]);
  }

  /**
   * Store compaction summary in database
   */
  private async storeCompactionSummary(
    sessionId: string,
    turnIndices: number[],
    summary: string,
    tokens: number
  ): Promise<CompactionSummary> {
    const id = `csum-${sessionId}-${Date.now()}`;
    const timestamp = Date.now();

    if (this.db) {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      db.prepare(
        `
        INSERT INTO session_compaction_summaries 
        (id, session_id, turns_archived_json, summary, tokens, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `
      ).run(
        id,
        sessionId,
        JSON.stringify(turnIndices),
        summary,
        tokens,
        timestamp
      );

      // Update archived turns with summary reference
      db.prepare(
        `
        UPDATE session_archived_turns 
        SET summary_id = ? 
        WHERE session_id = ? AND summary_id IS NULL
      `
      ).run(id, sessionId);
    }

    const compactionSummary: CompactionSummary = {
      id,
      sessionId,
      turnsArchived: turnIndices,
      summary,
      tokens,
      createdAt: timestamp
    };

    // Update in-memory cache
    const existing = this.sessionSummaries.get(sessionId) || [];
    this.sessionSummaries.set(sessionId, [...existing, compactionSummary]);

    return compactionSummary;
  }

  /**
   * Get archived turns for a session
   */
  getArchivedTurns(sessionId: string): ArchivedTurn[] {
    // Check in-memory cache first
    if (this.archivedTurns.has(sessionId)) {
      return this.archivedTurns.get(sessionId)!;
    }

    // Load from database
    if (!this.db) return [];

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      const rows = db
        .prepare(
          `
        SELECT id, session_id, turn_index, query_json, archived_at, summary_id
        FROM session_archived_turns
        WHERE session_id = ?
        ORDER BY turn_index ASC
      `
        )
        .all(sessionId) as ArchivedTurnRow[];

      const archived = rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        turnIndex: row.turn_index,
        query: JSON.parse(row.query_json),
        archivedAt: row.archived_at,
        summaryId: row.summary_id ?? undefined
      }));

      this.archivedTurns.set(sessionId, archived);
      return archived;
    } catch (error) {
      logger.error('Failed to load archived turns', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get compaction summaries for a session
   */
  getCompactionSummaries(sessionId: string): CompactionSummary[] {
    // Check in-memory cache first
    if (this.sessionSummaries.has(sessionId)) {
      return this.sessionSummaries.get(sessionId)!;
    }

    // Load from database
    if (!this.db) return [];

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      const rows = db
        .prepare(
          `
        SELECT id, session_id, turns_archived_json, summary, tokens, created_at
        FROM session_compaction_summaries
        WHERE session_id = ?
        ORDER BY created_at ASC
      `
        )
        .all(sessionId) as CompactionSummaryRow[];

      const summaries = rows.map((row) => ({
        id: row.id,
        sessionId: row.session_id,
        turnsArchived: JSON.parse(row.turns_archived_json),
        summary: row.summary,
        tokens: row.tokens,
        createdAt: row.created_at
      }));

      this.sessionSummaries.set(sessionId, summaries);
      return summaries;
    } catch (error) {
      logger.error('Failed to load compaction summaries', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Restore full session history (including archived turns)
   */
  restoreFullHistory(session: RLMSession): ContextQueryResult[] {
    const archived = this.getArchivedTurns(session.id);
    const archivedQueries = archived.map((a) => a.query);

    // Filter out the synthetic summary query if present
    const currentQueries = session.queries.filter(
      (q) => !(q.query.type === 'summarize' && q.query.params['archived'])
    );

    return [...archivedQueries, ...currentQueries];
  }

  /**
   * Get compactor stats
   */
  getStats(): CompactorStats & { config: SessionCompactorConfig } {
    return {
      ...this.stats,
      config: { ...this.config }
    };
  }

  /**
   * Configure the compactor
   */
  configure(config: Partial<SessionCompactorConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', { config: this.config });
  }

  /**
   * Clear session caches (for cleanup)
   */
  clearSessionCache(sessionId: string): void {
    this.archivedTurns.delete(sessionId);
    this.sessionSummaries.delete(sessionId);
  }
}

// Factory function
export function createSessionCompactor(
  config?: Partial<SessionCompactorConfig>
): SessionCompactor {
  const compactor = new SessionCompactor(config);
  compactor.initialize();
  return compactor;
}
