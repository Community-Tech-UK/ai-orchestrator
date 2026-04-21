/**
 * RLM Summarization Worker
 *
 * Background worker that scans context_sections for content that needs summarization
 * and automatically triggers LLM summarization to maintain high-level context.
 *
 * Features:
 * - Periodic scanning for pending summaries
 * - Batch processing to avoid overloading LLM
 * - Configuration for frequency and batch size
 * - Integration with RLMDatabase for persistence
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { LLMService, getLLMService } from './llm-service';
import { getTokenCounter, TokenCounter } from './token-counter';
import { getLogger } from '../logging/logger';

const logger = getLogger('SummarizationWorker');

// Database interface for raw SQL access
interface SQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): void;
    all(...params: unknown[]): unknown[];
  };
  pragma(name: string): unknown[];
}

interface RLMDatabaseWithRaw {
  db: SQLiteDatabase;
}

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SectionRow {
  id: string;
  storeId: string;
  name: string;
  tokens: number;
  type: string;
  depth: number;
  content: string;
  content_file: string | null;
}

export interface SummarizationWorkerConfig {
  /** Interval between scans in milliseconds (default: 60000 = 1 minute) */
  scanInterval: number;
  /** Maximum sections to process per batch (default: 5) */
  batchSize: number;
  /** Minimum tokens for a section to be eligible for summarization (default: 2000) */
  minTokensForSummary: number;
  /** Target compression ratio for summaries (default: 0.2 = 20% of original) */
  targetCompressionRatio: number;
  /** Maximum concurrent summarization requests (default: 2) */
  maxConcurrent: number;
  /** Enable/disable the worker (default: true) */
  enabled: boolean;
}

interface PendingSection {
  id: string;
  storeId: string;
  name: string;
  tokens: number;
  content: string;
  type: string;
  depth: number;
}

interface SummarizationStats {
  totalProcessed: number;
  totalSkipped: number;
  totalFailed: number;
  tokensOriginal: number;
  tokensSummarized: number;
  lastScanAt: number | null;
  lastProcessedAt: number | null;
}

const DEFAULT_CONFIG: SummarizationWorkerConfig = {
  scanInterval: 60000, // 1 minute
  batchSize: 5,
  minTokensForSummary: 2000,
  targetCompressionRatio: 0.2,
  maxConcurrent: 2,
  enabled: true
};

export class SummarizationWorker extends EventEmitter {
  private static instance: SummarizationWorker | null = null;
  private config: SummarizationWorkerConfig;
  private db: RLMDatabase | null = null;
  private llmService: LLMService | null = null;
  private tokenCounter: TokenCounter;
  private scanTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private stats: SummarizationStats = {
    totalProcessed: 0,
    totalSkipped: 0,
    totalFailed: 0,
    tokensOriginal: 0,
    tokensSummarized: 0,
    lastScanAt: null,
    lastProcessedAt: null
  };

  private constructor(config: Partial<SummarizationWorkerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.tokenCounter = getTokenCounter();
  }

  static getInstance(
    config?: Partial<SummarizationWorkerConfig>
  ): SummarizationWorker {
    if (!this.instance) {
      this.instance = new SummarizationWorker(config);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Initialize the worker with database and LLM service
   */
  initialize(): void {
    try {
      this.db = getRLMDatabase();
      this.llmService = getLLMService();

      // Ensure the pending_summary column exists
      this.ensureSummaryColumn();

      this.emit('initialized', { config: this.config });
    } catch (error) {
      logger.error('Failed to initialize', error instanceof Error ? error : undefined);
      this.emit('error', { phase: 'initialization', error });
    }
  }

  /**
   * Add pending_summary column if it doesn't exist (migration)
   */
  private ensureSummaryColumn(): void {
    if (!this.db) return;

    try {
      // Check if column exists by attempting a query
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      const tableInfo = db.pragma(
        `table_info(context_sections)`
      ) as TableColumn[];
      const hasPendingSummary = tableInfo.some(
        (col) => col.name === 'pending_summary'
      );

      if (!hasPendingSummary) {
        db.exec(`
          ALTER TABLE context_sections ADD COLUMN pending_summary INTEGER DEFAULT 0;
          ALTER TABLE context_sections ADD COLUMN summary_priority INTEGER DEFAULT 0;
          ALTER TABLE context_sections ADD COLUMN last_summary_attempt INTEGER;
        `);
        logger.info('Added pending_summary columns to context_sections');
      }
    } catch (error) {
      // Columns might already exist or table doesn't exist yet
      logger.warn('Could not add summary columns', { error });
    }
  }

  /**
   * Start the background worker
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Worker is disabled');
      return;
    }

    if (this.scanTimer) {
      logger.info('Worker already running');
      return;
    }

    logger.info('Starting with config', {
      scanInterval: this.config.scanInterval,
      batchSize: this.config.batchSize,
      minTokensForSummary: this.config.minTokensForSummary
    });

    // Initial scan after short delay
    setTimeout(() => this.scan(), 5000);

    // Schedule periodic scans
    this.scanTimer = setInterval(() => this.scan(), this.config.scanInterval);

    this.emit('started');
  }

  /**
   * Stop the background worker
   */
  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    this.emit('stopped');
  }

  /**
   * Scan for sections needing summarization
   */
  async scan(): Promise<void> {
    if (!this.db || !this.llmService) {
      return;
    }

    if (this.isProcessing) {
      logger.info('Scan skipped - already processing');
      return;
    }

    this.isProcessing = true;
    this.stats.lastScanAt = Date.now();
    this.emit('scan:started');

    try {
      const pendingSections = this.findPendingSections();

      if (pendingSections.length === 0) {
        this.emit('scan:complete', { processed: 0, found: 0 });
        return;
      }

      logger.info('Found sections needing summarization', { count: pendingSections.length });

      // Process in batches
      const batch = pendingSections.slice(0, this.config.batchSize);
      await this.processBatch(batch);

      this.emit('scan:complete', {
        processed: batch.length,
        found: pendingSections.length
      });
    } catch (error) {
      logger.error('Scan failed', error instanceof Error ? error : undefined);
      this.emit('error', { phase: 'scan', error });
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Find sections that need summarization
   */
  private findPendingSections(): PendingSection[] {
    if (!this.db) return [];

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;

      // Find large sections without summaries at depth 0
      // Priority: larger sections first, older sections first
      const stmt = db.prepare(`
        SELECT
          cs.id,
          cs.store_id as storeId,
          cs.name,
          cs.tokens,
          cs.type,
          cs.depth,
          COALESCE(cs.content_inline, '') as content,
          cs.content_file
        FROM context_sections cs
        WHERE cs.depth = 0
          AND cs.tokens >= ?
          AND cs.parent_summary_id IS NULL
          AND (cs.pending_summary IS NULL OR cs.pending_summary = 0)
        ORDER BY cs.tokens DESC, cs.created_at ASC
        LIMIT ?
      `);

      const rows = stmt.all(
        this.config.minTokensForSummary,
        this.config.batchSize * 2
      ) as SectionRow[];

      // Load content from files if needed
      return rows
        .map((row) => {
          let content = row.content;
          if (!content && row.content_file) {
            // Use a minimal type cast that satisfies getSectionContent
            const sectionForContent = {
              id: row.id,
              content_inline: row.content,
              content_file: row.content_file
            };
            content = this.db!.getSectionContent(
              sectionForContent as Parameters<
                typeof this.db.getSectionContent
              >[0]
            );
          }
          return {
            id: row.id,
            storeId: row.storeId,
            name: row.name,
            tokens: row.tokens,
            content,
            type: row.type,
            depth: row.depth
          };
        })
        .filter((s: PendingSection) => s.content && s.content.length > 0);
    } catch (error) {
      logger.error('Failed to find pending sections', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Process a batch of sections
   */
  private async processBatch(sections: PendingSection[]): Promise<void> {
    const concurrentLimit = this.config.maxConcurrent;

    for (let i = 0; i < sections.length; i += concurrentLimit) {
      const chunk = sections.slice(i, i + concurrentLimit);
      await Promise.all(chunk.map((section) => this.summarizeSection(section)));
    }
  }

  /**
   * Summarize a single section
   */
  private async summarizeSection(section: PendingSection): Promise<void> {
    if (!this.llmService || !this.db) return;

    const targetTokens = Math.ceil(
      section.tokens * this.config.targetCompressionRatio
    );

    logger.info('Summarizing section', { name: section.name, tokens: section.tokens, targetTokens });

    try {
      // Mark as being processed
      this.markSectionPending(section.id, true);

      const summary = await this.llmService.summarize({
        requestId: `sum-worker-${section.id}-${Date.now()}`,
        content: section.content,
        targetTokens,
        preserveKeyPoints: true
      });

      if (!summary || summary.trim().length === 0) {
        throw new Error('Empty summary returned');
      }

      // Store the summary as a new section at depth 1
      const summaryTokens = this.tokenCounter.countTokens(summary);

      await this.storeSummary(section, summary, summaryTokens);

      this.stats.totalProcessed++;
      this.stats.tokensOriginal += section.tokens;
      this.stats.tokensSummarized += summaryTokens;
      this.stats.lastProcessedAt = Date.now();

      this.emit('section:summarized', {
        sectionId: section.id,
        name: section.name,
        originalTokens: section.tokens,
        summaryTokens,
        compressionRatio: summaryTokens / section.tokens
      });
    } catch (error) {
      logger.error('Failed to summarize section', error instanceof Error ? error : undefined, { sectionId: section.id });
      this.stats.totalFailed++;
      this.markSectionPending(section.id, false, Date.now());

      this.emit('section:failed', {
        sectionId: section.id,
        name: section.name,
        error: (error as Error).message
      });
    }
  }

  /**
   * Store a summary in the database
   */
  private async storeSummary(
    original: PendingSection,
    summary: string,
    summaryTokens: number
  ): Promise<void> {
    if (!this.db) return;

    try {
      const summaryId = `sum-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

      this.db.addSection({
        id: summaryId,
        storeId: original.storeId,
        type: 'summary',
        name: `Summary: ${original.name}`,
        content: summary,
        startOffset: 0,
        endOffset: summary.length,
        tokens: summaryTokens,
        checksum: this.computeChecksum(summary),
        depth: original.depth + 1,
        summarizes: [original.id],
        parentSummaryId: undefined
      });

      // Mark original as having a summary (update pending_summary to done)
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      db.prepare(
        `
        UPDATE context_sections 
        SET pending_summary = 2, parent_summary_id = ?
        WHERE id = ?
      `
      ).run(summaryId, original.id);
    } catch (error) {
      logger.error('Failed to store summary', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Mark a section as pending/not pending summarization
   */
  private markSectionPending(
    sectionId: string,
    pending: boolean,
    attemptTime?: number
  ): void {
    if (!this.db) return;

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      db.prepare(
        `
        UPDATE context_sections 
        SET pending_summary = ?, last_summary_attempt = ?
        WHERE id = ?
      `
      ).run(pending ? 1 : 0, attemptTime || null, sectionId);
    } catch (error) {
      logger.error('Failed to mark section pending', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Compute checksum for content
   */
  private computeChecksum(content: string): string {
    return crypto.createHash('md5').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Get current stats
   */
  getStats(): SummarizationStats & {
    isRunning: boolean;
    isProcessing: boolean;
    config: SummarizationWorkerConfig;
  } {
    return {
      ...this.stats,
      isRunning: this.scanTimer !== null,
      isProcessing: this.isProcessing,
      config: { ...this.config }
    };
  }

  /**
   * Configure the worker
   */
  configure(config: Partial<SummarizationWorkerConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };

    // Handle enable/disable
    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled && this.db) {
      this.start();
    }

    // Restart timer if interval changed
    if (this.scanTimer && config.scanInterval) {
      this.stop();
      this.start();
    }

    this.emit('configured', { config: this.config });
  }

  /**
   * Force an immediate scan (for testing or manual trigger)
   */
  async forceScan(): Promise<void> {
    await this.scan();
  }

  /**
   * Manually queue a section for summarization
   */
  queueSection(sectionId: string): void {
    if (!this.db) return;

    try {
      const db = (this.db as unknown as RLMDatabaseWithRaw).db;
      db.prepare(
        `
        UPDATE context_sections 
        SET pending_summary = 0, summary_priority = summary_priority + 1
        WHERE id = ?
      `
      ).run(sectionId);

      this.emit('section:queued', { sectionId });
    } catch (error) {
      logger.error('Failed to queue section', error instanceof Error ? error : undefined);
    }
  }
}

// Singleton accessor
let instance: SummarizationWorker | null = null;

export function getSummarizationWorker(
  config?: Partial<SummarizationWorkerConfig>
): SummarizationWorker {
  if (!instance) {
    instance = SummarizationWorker.getInstance(config);
  }
  return instance;
}

export function initializeSummarizationWorker(
  config?: Partial<SummarizationWorkerConfig>
): void {
  const worker = getSummarizationWorker(config);
  worker.initialize();
  worker.start();
}

export function _resetSummarizationWorkerForTesting(): void {
  instance = null;
  SummarizationWorker._resetForTesting();
}
