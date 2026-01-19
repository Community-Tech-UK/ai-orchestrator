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
import Anthropic from '@anthropic-ai/sdk';

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

const DEFAULT_CONFIG: CompactionConfig = {
  triggerThreshold: 0.85,
  targetReduction: 0.5,
  preserveRecent: 5,
  summaryModel: 'claude-3-haiku-20240307',
  toolCallRetention: 'results_only',
  maxContextTokens: 200000,
  autoCompact: true,
};

export class ContextCompactor extends EventEmitter {
  private static instance: ContextCompactor | null = null;
  private config: CompactionConfig;
  private anthropic: Anthropic | null = null;
  private state: ContextState;
  private compactionHistory: CompactionResult[] = [];

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

  /**
   * Initialize with API key
   */
  initialize(apiKey: string): void {
    this.anthropic = new Anthropic({ apiKey });
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
    if (this.config.autoCompact && this.shouldCompact()) {
      this.compact().catch(err => {
        this.emit('error', err);
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
   * Perform context compaction
   */
  async compact(): Promise<CompactionResult> {
    const startTime = Date.now();
    const originalTokens = this.state.totalTokens;
    const originalTurnCount = this.state.turns.length;

    this.emit('compaction-started', { originalTokens, turnCount: originalTurnCount });

    try {
      // Determine how many turns to compact
      const turnsToPreserve = Math.min(this.config.preserveRecent, this.state.turns.length);
      const turnsToCompact = this.state.turns.slice(0, -turnsToPreserve);
      const preservedTurns = this.state.turns.slice(-turnsToPreserve);

      if (turnsToCompact.length === 0) {
        const result: CompactionResult = {
          originalTokens,
          compactedTokens: originalTokens,
          reductionRatio: 0,
          turnsRemoved: 0,
          turnsPreserved: preservedTurns.length,
          summaryGenerated: false,
          timestamp: Date.now(),
        };
        this.emit('compaction-skipped', result);
        return result;
      }

      // Generate summary of compacted turns
      const summary = await this.generateSummary(turnsToCompact);

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

      // Update state
      this.state.summaries.push(summary);
      this.state.turns = processedTurns;
      this.state.totalTokens = summaryTokens + preservedTokens;
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
      this.emit('compaction-completed', result);

      return result;
    } catch (error) {
      this.emit('compaction-error', error);
      throw error;
    }
  }

  /**
   * Generate a summary of conversation turns
   */
  private async generateSummary(turns: ConversationTurn[]): Promise<ConversationSummary> {
    const conversationText = turns
      .map(t => `[${t.role}]: ${t.content}`)
      .join('\n\n');

    let summaryContent: string;

    if (this.anthropic) {
      const response = await this.anthropic.messages.create({
        model: this.config.summaryModel,
        max_tokens: 1024,
        system: `You are a conversation summarizer. Create a concise summary that preserves:
- Key decisions made
- Important information shared
- Action items or tasks discussed
- Any unresolved questions

Be concise but complete. Use bullet points for clarity.`,
        messages: [
          {
            role: 'user',
            content: `Summarize this conversation:\n\n${conversationText}`,
          },
        ],
      });

      summaryContent =
        response.content[0].type === 'text'
          ? response.content[0].text
          : 'Summary generation failed';
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

export default ContextCompactor;
