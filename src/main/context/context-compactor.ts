/**
 * Context Compactor Service
 *
 * Intelligent context management for long conversations:
 * - Automatic compaction at configurable thresholds
 * - Conversation summarization
 * - Tool call clearing strategies
 * - Token usage optimization
 */

import { EventEmitter } from 'events';
import { getLLMService, type LLMService } from '../rlm/llm-service';
import { getLogger } from '../logging/logger';
import { LIMITS } from '../../shared/constants/limits';

const compactorLogger = getLogger('ContextCompactor');

export interface CompactionConfig {
  /** Threshold to trigger compaction (0-1, default 0.85) */
  triggerThreshold: number;
  /** Target reduction ratio (0-1, default 0.5) */
  targetReduction: number;
  /** Number of recent turns to preserve */
  preserveRecent: number;
  /** Model to use for summarization */
  summaryModel: string;
  /** Tool call retention strategy */
  toolCallRetention: 'none' | 'results_only' | 'all';
  /** Maximum context window size */
  maxContextTokens: number;
  /** Enable automatic compaction */
  autoCompact: boolean;
}

export interface ConversationTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  tokenCount: number;
  toolCalls?: ToolCallRecord[];
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  input: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CompactionResult {
  originalTokens: number;
  compactedTokens: number;
  reductionRatio: number;
  turnsRemoved: number;
  turnsPreserved: number;
  summaryGenerated: boolean;
  timestamp: number;
}

export interface ContextState {
  turns: ConversationTurn[];
  totalTokens: number;
  fillRatio: number;
  lastCompaction?: CompactionResult;
  summaries: ConversationSummary[];
}

export interface ConversationSummary {
  id: string;
  content: string;
  turnRange: { start: number; end: number };
  tokenCount: number;
  timestamp: number;
}

/** Maximum number of summaries to retain */
const MAX_SUMMARIES = 50;
const MAX_COMPACTION_HISTORY = 100;

/** Safety timeout for compaction LLM calls (5 minutes) */
const COMPACTION_TIMEOUT_MS = 5 * 60 * 1000;

/** Minimum prunable tokens before the prune pass fires */
const PRUNE_MINIMUM_TOKENS = 20000;

/** Recent tokens protected from pruning */
const PRUNE_PROTECT_TOKENS = 40000;

const DEFAULT_CONFIG: CompactionConfig = {
  triggerThreshold: 0.85,
  targetReduction: 0.5,
  preserveRecent: 5,
  summaryModel: 'default',
  toolCallRetention: 'results_only',
  maxContextTokens: LIMITS.DEFAULT_MAX_CONTEXT_TOKENS,
  autoCompact: true,
};

export class ContextCompactor extends EventEmitter {
  private static instance: ContextCompactor | null = null;
  private config: CompactionConfig;
  private llmService: LLMService | null = null;
  private state: ContextState;
  private compactionHistory: CompactionResult[] = [];
  private compactionInProgress = false;
  private metrics = {
    attempts: 0,
    successes: 0,
    failures: 0,
    totalTokensSaved: 0,
  };

  private constructor() {
    super();
    this.config = { ...DEFAULT_CONFIG };
    this.state = {
      turns: [],
      totalTokens: 0,
      fillRatio: 0,
      summaries: [],
    };
  }

  static getInstance(): ContextCompactor {
    if (!ContextCompactor.instance) {
      ContextCompactor.instance = new ContextCompactor();
    }
    return ContextCompactor.instance;
  }

  static _resetForTesting(): void {
    ContextCompactor.instance = null;
  }

  /**
   * Initialize with API key (backward-compatible).
   * Configures the underlying LLMService with the provided key.
   */
  initialize(apiKey: string): void {
    this.llmService = getLLMService();
    this.llmService.configure({ anthropicApiKey: apiKey });
    this.emit('initialized');
  }

  /**
   * Update compaction configuration
   */
  updateConfig(config: Partial<CompactionConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config-updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): CompactionConfig {
    return { ...this.config };
  }

  /**
   * Add a conversation turn
   */
  addTurn(turn: Omit<ConversationTurn, 'id' | 'timestamp'>): ConversationTurn {
    const fullTurn: ConversationTurn = {
      ...turn,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    this.state.turns.push(fullTurn);
    this.state.totalTokens += turn.tokenCount;

    if (turn.toolCalls) {
      for (const toolCall of turn.toolCalls) {
        this.state.totalTokens += toolCall.inputTokens + (toolCall.outputTokens || 0);
      }
    }

    this.updateFillRatio();
    this.emit('turn-added', fullTurn);

    // Check if compaction needed
    if (this.config.autoCompact && this.shouldCompact() && !this.compactionInProgress) {
      this.compactionInProgress = true;
      this.compact()
        .catch(err => {
          this.emit('error', err);
        })
        .finally(() => {
          this.compactionInProgress = false;
        });
    }

    return fullTurn;
  }

  /**
   * Check if compaction should be triggered
   */
  shouldCompact(): boolean {
    return this.state.fillRatio >= this.config.triggerThreshold;
  }

  /**
   * Get current context state
   */
  getState(): ContextState {
    return {
      ...this.state,
      turns: [...this.state.turns],
      summaries: [...this.state.summaries],
    };
  }

  /**
   * Get fill ratio (0-1)
   */
  getFillRatio(): number {
    return this.state.fillRatio;
  }

  /**
   * Prune pass: walk backwards through turns, marking old tool outputs as compacted.
   * Protects the most recent PRUNE_PROTECT_TOKENS of tool output, and only fires
   * if at least PRUNE_MINIMUM_TOKENS of tool output can be pruned.
   * Inspired by opencode's two-pass compaction approach.
   */
  pruneToolOutputs(): { prunedTokens: number; prunedTurns: number } {
    let protectedTokens = 0;
    let prunableTokens = 0;
    let prunedTurns = 0;

    // Walk backwards from newest to oldest
    const turnsReversed = [...this.state.turns].reverse();

    for (const turn of turnsReversed) {
      if (!turn.toolCalls || turn.toolCalls.length === 0) continue;

      for (const tc of turn.toolCalls) {
        const outputTokens = tc.outputTokens || 0;
        if (protectedTokens < PRUNE_PROTECT_TOKENS) {
          protectedTokens += outputTokens;
        } else {
          prunableTokens += outputTokens;
        }
      }
    }

    // Only prune if there's enough to be worth it
    if (prunableTokens < PRUNE_MINIMUM_TOKENS) {
      return { prunedTokens: 0, prunedTurns: 0 };
    }

    // Second pass: actually prune (walk forward this time, oldest first)
    let remainingProtect = PRUNE_PROTECT_TOKENS;
    let totalPruned = 0;

    // Process newest first to determine protection budget
    for (let i = this.state.turns.length - 1; i >= 0; i--) {
      const turn = this.state.turns[i];
      if (!turn.toolCalls) continue;

      let turnProtected = false;
      for (const tc of turn.toolCalls) {
        if (remainingProtect > 0) {
          remainingProtect -= (tc.outputTokens || 0);
          turnProtected = true;
        }
      }

      if (!turnProtected) {
        // This turn's tool outputs are outside the protection window — prune them
        for (const tc of turn.toolCalls) {
          if (tc.output && tc.outputTokens > 0) {
            totalPruned += tc.outputTokens;
            tc.output = '[Output pruned for context optimization]';
            tc.outputTokens = 10; // Minimal placeholder cost
          }
        }
        prunedTurns++;
      }
    }

    if (totalPruned > 0) {
      this.state.totalTokens -= totalPruned;
      this.updateFillRatio();
      compactorLogger.info('Prune pass completed', {
        prunedTokens: totalPruned,
        prunedTurns,
        remainingTokens: this.state.totalTokens,
      });
    }

    return { prunedTokens: totalPruned, prunedTurns };
  }

  /**
   * Perform context compaction with safety timeout, prune pass, and post-verification.
   */
  async compact(): Promise<CompactionResult> {
    const originalTokens = this.state.totalTokens;
    const originalTurnCount = this.state.turns.length;

    this.emit('compaction-started', { originalTokens, turnCount: originalTurnCount });

    compactorLogger.info('Compaction started', {
      originalTokens,
      turnCount: originalTurnCount,
      fillRatio: this.state.fillRatio,
    });

    try {
      // Phase 1: Prune tool outputs first (reduces what needs summarization)
      const pruneResult = this.pruneToolOutputs();
      if (pruneResult.prunedTokens > 0) {
        compactorLogger.info('Prune phase reduced context', {
          prunedTokens: pruneResult.prunedTokens,
          prunedTurns: pruneResult.prunedTurns,
          tokensAfterPrune: this.state.totalTokens,
        });
      }

      // Check if pruning alone was sufficient
      if (!this.shouldCompact()) {
        const result: CompactionResult = {
          originalTokens,
          compactedTokens: this.state.totalTokens,
          reductionRatio: 1 - this.state.totalTokens / originalTokens,
          turnsRemoved: 0,
          turnsPreserved: this.state.turns.length,
          summaryGenerated: false,
          timestamp: Date.now(),
        };
        this.emit('compaction-completed', result);
        return result;
      }

      // Phase 2: Summarize old turns
      const turnsToPreserve = Math.min(this.config.preserveRecent, this.state.turns.length);
      const turnsToCompact = this.state.turns.slice(0, -turnsToPreserve || undefined);
      const preservedTurns = this.state.turns.slice(-turnsToPreserve);

      if (turnsToCompact.length === 0) {
        const result: CompactionResult = {
          originalTokens,
          compactedTokens: this.state.totalTokens,
          reductionRatio: 0,
          turnsRemoved: 0,
          turnsPreserved: preservedTurns.length,
          summaryGenerated: false,
          timestamp: Date.now(),
        };
        this.emit('compaction-skipped', result);
        return result;
      }

      // Generate summary with safety timeout
      const summary = await this.generateSummaryWithTimeout(turnsToCompact);

      // Apply tool call retention strategy
      const processedTurns = this.applyToolCallRetention(preservedTurns);

      // Calculate new state
      const summaryTokens = this.estimateTokens(summary.content);
      const preservedTokens = processedTurns.reduce((sum, t) => {
        let tokens = t.tokenCount;
        if (t.toolCalls) {
          tokens += t.toolCalls.reduce(
            (s, tc) => s + tc.inputTokens + (tc.outputTokens || 0),
            0
          );
        }
        return sum + tokens;
      }, 0);

      const newTotalTokens = summaryTokens + preservedTokens;

      // Phase 3: Post-compaction verification
      this.metrics.attempts++;

      if (newTotalTokens >= originalTokens) {
        this.metrics.failures++;
        compactorLogger.warn('Post-compaction verification failed: tokens did not decrease — discarding result', {
          originalTokens,
          newTotalTokens,
          summaryTokens,
          preservedTokens,
        });
        const failedResult: CompactionResult = {
          originalTokens,
          compactedTokens: originalTokens,
          reductionRatio: 0,
          turnsRemoved: 0,
          turnsPreserved: this.state.turns.length,
          summaryGenerated: false,
          timestamp: Date.now(),
        };
        this.emit('compaction-failed', failedResult);
        return failedResult;
      }

      const reductionPct = (originalTokens - newTotalTokens) / originalTokens;
      if (reductionPct < 0.10) {
        compactorLogger.warn('Marginal compaction: tokens reduced by less than 10%', {
          originalTokens,
          newTotalTokens,
          reductionPct: (reductionPct * 100).toFixed(1) + '%',
        });
      }

      this.metrics.successes++;
      this.metrics.totalTokensSaved += originalTokens - newTotalTokens;

      // Update state
      this.state.summaries.push(summary);
      if (this.state.summaries.length > MAX_SUMMARIES) {
        this.state.summaries = this.state.summaries.slice(-MAX_SUMMARIES);
      }
      this.state.turns = processedTurns;
      this.state.totalTokens = newTotalTokens;
      this.updateFillRatio();

      const result: CompactionResult = {
        originalTokens,
        compactedTokens: this.state.totalTokens,
        reductionRatio: 1 - this.state.totalTokens / originalTokens,
        turnsRemoved: turnsToCompact.length,
        turnsPreserved: processedTurns.length,
        summaryGenerated: true,
        timestamp: Date.now(),
      };

      this.state.lastCompaction = result;
      this.compactionHistory.push(result);
      if (this.compactionHistory.length > MAX_COMPACTION_HISTORY) {
        this.compactionHistory = this.compactionHistory.slice(-MAX_COMPACTION_HISTORY);
      }

      compactorLogger.info('Compaction completed', {
        originalTokens,
        compactedTokens: result.compactedTokens,
        reductionRatio: result.reductionRatio.toFixed(2),
        turnsRemoved: result.turnsRemoved,
        summaryGenerated: true,
      });

      this.emit('compaction-completed', result);
      return result;
    } catch (error) {
      compactorLogger.error('Compaction failed', error instanceof Error ? error : undefined, {
        originalTokens,
        turnCount: originalTurnCount,
      });
      this.emit('compaction-error', error);
      throw error;
    }
  }

  /**
   * Generate a summary with a safety timeout to prevent hanging on slow LLM calls.
   * If the timeout fires, falls back to local summary generation.
   */
  private async generateSummaryWithTimeout(turns: ConversationTurn[]): Promise<ConversationSummary> {
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Compaction summary timed out')), COMPACTION_TIMEOUT_MS);
    });

    try {
      return await Promise.race([
        this.generateSummary(turns),
        timeoutPromise,
      ]);
    } catch (error) {
      compactorLogger.warn('Summary generation timed out or failed, using local fallback', {
        error: (error as Error).message,
        turnCount: turns.length,
        timeoutMs: COMPACTION_TIMEOUT_MS,
      });
      // Fall back to local keyword-extraction summary
      return {
        id: this.generateId(),
        content: this.generateLocalSummary(turns),
        turnRange: { start: 0, end: turns.length - 1 },
        tokenCount: this.estimateTokens(this.generateLocalSummary(turns)),
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Generate a summary of conversation turns.
   * Uses LLMService (provider-neutral) when available, falls back to local extraction.
   */
  private async generateSummary(turns: ConversationTurn[]): Promise<ConversationSummary> {
    const conversationText = turns
      .map(t => `[${t.role}]: ${t.content}`)
      .join('\n\n');

    let summaryContent: string;

    // Lazily resolve LLMService if not yet initialized
    const llm = this.llmService ?? getLLMService();
    const isLlmAvailable = await llm.isAvailable();

    if (isLlmAvailable) {
      const requestId = `compact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      summaryContent = await llm.summarize({
        requestId,
        content: conversationText,
        targetTokens: 500,
        preserveKeyPoints: true,
      });
    } else {
      // Fallback: simple extraction without API
      summaryContent = this.generateLocalSummary(turns);
    }

    return {
      id: this.generateId(),
      content: summaryContent,
      turnRange: {
        start: 0,
        end: turns.length - 1,
      },
      tokenCount: this.estimateTokens(summaryContent),
      timestamp: Date.now(),
    };
  }

  /**
   * Generate a local summary without API call
   */
  private generateLocalSummary(turns: ConversationTurn[]): string {
    const userMessages = turns.filter(t => t.role === 'user');
    const assistantMessages = turns.filter(t => t.role === 'assistant');

    const topics = new Set<string>();
    const keywords = ['implement', 'create', 'fix', 'update', 'add', 'remove', 'change'];

    for (const turn of turns) {
      for (const keyword of keywords) {
        if (turn.content.toLowerCase().includes(keyword)) {
          const sentences = turn.content.split(/[.!?]/);
          for (const sentence of sentences) {
            if (sentence.toLowerCase().includes(keyword)) {
              topics.add(sentence.trim().substring(0, 100));
            }
          }
        }
      }
    }

    return `**Conversation Summary (${turns.length} turns)**

User messages: ${userMessages.length}
Assistant responses: ${assistantMessages.length}

Key topics discussed:
${[...topics].slice(0, 5).map(t => `- ${t}`).join('\n')}`;
  }

  /**
   * Apply tool call retention strategy to turns
   */
  private applyToolCallRetention(turns: ConversationTurn[]): ConversationTurn[] {
    if (this.config.toolCallRetention === 'all') {
      return turns;
    }

    return turns.map(turn => {
      if (!turn.toolCalls) return turn;

      if (this.config.toolCallRetention === 'none') {
        return {
          ...turn,
          toolCalls: undefined,
          content: turn.content + '\n\n[Tool calls omitted for context optimization]',
        };
      }

      // results_only: keep only outputs
      return {
        ...turn,
        toolCalls: turn.toolCalls.map(tc => ({
          ...tc,
          input: '[Input omitted]',
          inputTokens: 20,
        })),
      };
    });
  }

  /**
   * Get compaction history
   */
  getCompactionHistory(): CompactionResult[] {
    return [...this.compactionHistory];
  }

  /**
   * Get compaction metrics (attempts, successes, failures, tokens saved)
   */
  getMetrics(): {
    attempts: number;
    successes: number;
    failures: number;
    totalTokensSaved: number;
    successRate: number;
    averageTokensSavedPerSuccess: number;
  } {
    const successRate = this.metrics.attempts > 0
      ? this.metrics.successes / this.metrics.attempts
      : 0;
    const averageTokensSavedPerSuccess = this.metrics.successes > 0
      ? this.metrics.totalTokensSaved / this.metrics.successes
      : 0;
    return {
      ...this.metrics,
      successRate,
      averageTokensSavedPerSuccess,
    };
  }

  /**
   * Clear all context
   */
  clear(): void {
    this.state = {
      turns: [],
      totalTokens: 0,
      fillRatio: 0,
      summaries: [],
    };
    this.emit('cleared');
  }

  /**
   * Export context for persistence
   */
  export(): {
    config: CompactionConfig;
    state: ContextState;
    history: CompactionResult[];
  } {
    return {
      config: { ...this.config },
      state: this.getState(),
      history: [...this.compactionHistory],
    };
  }

  /**
   * Import context from persistence
   */
  import(data: {
    config?: Partial<CompactionConfig>;
    state?: Partial<ContextState>;
    history?: CompactionResult[];
  }): void {
    if (data.config) {
      this.config = { ...this.config, ...data.config };
    }
    if (data.state) {
      this.state = {
        turns: data.state.turns || [],
        totalTokens: data.state.totalTokens || 0,
        fillRatio: data.state.fillRatio || 0,
        summaries: data.state.summaries || [],
        lastCompaction: data.state.lastCompaction,
      };
    }
    if (data.history) {
      this.compactionHistory = [...data.history];
    }
    this.emit('imported');
  }

  /**
   * Get context statistics
   */
  getStatistics(): {
    totalTurns: number;
    totalTokens: number;
    fillRatio: number;
    summaryCount: number;
    compactionCount: number;
    averageReduction: number;
  } {
    const avgReduction =
      this.compactionHistory.length > 0
        ? this.compactionHistory.reduce((sum, r) => sum + r.reductionRatio, 0) /
          this.compactionHistory.length
        : 0;

    return {
      totalTurns: this.state.turns.length,
      totalTokens: this.state.totalTokens,
      fillRatio: this.state.fillRatio,
      summaryCount: this.state.summaries.length,
      compactionCount: this.compactionHistory.length,
      averageReduction: avgReduction,
    };
  }

  private updateFillRatio(): void {
    this.state.fillRatio = this.state.totalTokens / this.config.maxContextTokens;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }

  private generateId(): string {
    return `ctx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

export function getContextCompactor(): ContextCompactor {
  return ContextCompactor.getInstance();
}

export default ContextCompactor;
