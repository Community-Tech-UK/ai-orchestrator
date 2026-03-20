/**
 * Context Editing Fallback
 * Phase 1.2: Emergency fallback using Anthropic's context_management API
 *
 * FALLBACK ONLY - Use smart compaction first.
 * This is a blunt instrument that just clears old tool results.
 * Smart compaction does intelligent summarization - use that first.
 *
 * Integration Point: smart-compaction.ts calls this AFTER tier-based compaction fails
 */

import { EventEmitter } from 'events';
import Anthropic from '@anthropic-ai/sdk';
import type {
  ContextManagement,
  ClearToolUsesStrategy,
  ClearThinkingStrategy,
  ContextManagementResponse,
  AppliedEdit,
} from '../../shared/types/api-features.types';
import { CONTEXT_MANAGEMENT_BETA, supportsContextEditing } from '../../shared/types/api-features.types';
import { getMetricsCollector } from '../learning/metrics-collector';

// ============================================
// Types
// ============================================

/**
 * Context state used to determine if fallback is needed
 */
export interface ContextState {
  /** Current context utilization as percentage (0-100) */
  utilizationPercent: number;
  /** Whether smart compaction has already been attempted */
  compactionAttempted: boolean;
  /** Session ID for tracking */
  sessionId: string;
  /** Current model being used */
  model: string;
}

/**
 * Configuration for context editing fallback
 */
export interface ContextEditingConfig {
  /** Enable the fallback (default: true) */
  enabled: boolean;
  /** Only use fallback when utilization exceeds this after compaction (default: 95) */
  activationThreshold: number;
  /** Token threshold that triggers clearing (default: 180000) */
  triggerTokens: number;
  /** Number of recent tool uses to keep (default: 3) */
  keepToolUses: number;
  /** Minimum tokens to clear to make cache invalidation worthwhile (default: 10000) */
  clearAtLeastTokens: number;
  /** Tool names to never clear (default: []) */
  excludeTools: string[];
  /** Whether to also clear tool input parameters (default: false) */
  clearToolInputs: boolean;
  /** Enable extended thinking clearing when thinking is enabled (default: true) */
  enableThinkingClearing: boolean;
  /** Number of thinking turns to keep (default: 1) */
  keepThinkingTurns: number;
}

/**
 * Result from applying context edits
 */
export interface ContextEditResult {
  /** Whether edits were applied */
  applied: boolean;
  /** Number of tool uses cleared */
  clearedToolUses: number;
  /** Number of thinking turns cleared */
  clearedThinkingTurns: number;
  /** Total tokens cleared */
  clearedTokens: number;
  /** The applied edits from the API */
  appliedEdits: AppliedEdit[];
}

/**
 * Context editing events
 */
export type ContextEditingEvent =
  | { type: 'fallback:activated'; sessionId: string; utilizationPercent: number }
  | { type: 'fallback:skipped'; sessionId: string; reason: string }
  | { type: 'edits:applied'; sessionId: string; result: ContextEditResult }
  | { type: 'edits:failed'; sessionId: string; error: Error };

// ============================================
// Default Configuration
// ============================================

const DEFAULT_CONFIG: ContextEditingConfig = {
  enabled: true,
  activationThreshold: 95,
  triggerTokens: 180_000,
  keepToolUses: 3,
  clearAtLeastTokens: 10_000,
  excludeTools: [],
  clearToolInputs: false,
  enableThinkingClearing: true,
  keepThinkingTurns: 1,
};

// ============================================
// Context Editing Fallback
// ============================================

/**
 * Context Editing Fallback Manager
 *
 * Provides emergency context clearing when smart compaction can't keep up.
 * Uses the Anthropic context_management API (beta).
 */
export class ContextEditingFallback extends EventEmitter {
  private static instance: ContextEditingFallback | null = null;

  private config: ContextEditingConfig;
  private editHistory: Map<string, ContextEditResult[]> = new Map();

  private constructor(config: Partial<ContextEditingConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  static getInstance(config?: Partial<ContextEditingConfig>): ContextEditingFallback {
    if (!ContextEditingFallback.instance) {
      ContextEditingFallback.instance = new ContextEditingFallback(config);
    }
    return ContextEditingFallback.instance;
  }

  static resetInstance(): void {
    ContextEditingFallback.instance = null;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  // ============================================
  // Configuration
  // ============================================

  /**
   * Configure the fallback manager
   */
  configure(config: Partial<ContextEditingConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('config:updated', this.config);
  }

  /**
   * Get current configuration
   */
  getConfig(): ContextEditingConfig {
    return { ...this.config };
  }

  // ============================================
  // Fallback Decision Logic
  // ============================================

  /**
   * Check if fallback should be used
   *
   * Only use if:
   * 1. Enabled in config
   * 2. Smart compaction has already been attempted
   * 3. Still over activation threshold (default 95%)
   * 4. Model supports context editing
   */
  shouldUseFallback(contextState: ContextState): boolean {
    if (!this.config.enabled) {
      this.emitEvent({
        type: 'fallback:skipped',
        sessionId: contextState.sessionId,
        reason: 'Fallback disabled in config',
      });
      return false;
    }

    if (!contextState.compactionAttempted) {
      this.emitEvent({
        type: 'fallback:skipped',
        sessionId: contextState.sessionId,
        reason: 'Smart compaction not attempted yet - try that first',
      });
      return false;
    }

    if (contextState.utilizationPercent < this.config.activationThreshold) {
      this.emitEvent({
        type: 'fallback:skipped',
        sessionId: contextState.sessionId,
        reason: `Utilization ${contextState.utilizationPercent}% below threshold ${this.config.activationThreshold}%`,
      });
      return false;
    }

    if (!supportsContextEditing(contextState.model)) {
      this.emitEvent({
        type: 'fallback:skipped',
        sessionId: contextState.sessionId,
        reason: `Model ${contextState.model} does not support context editing`,
      });
      return false;
    }

    this.emitEvent({
      type: 'fallback:activated',
      sessionId: contextState.sessionId,
      utilizationPercent: contextState.utilizationPercent,
    });

    return true;
  }

  // ============================================
  // Context Management Configuration
  // ============================================

  /**
   * Build context_management configuration for API request
   *
   * @param options - Optional overrides for the configuration
   * @param includeThinking - Whether to include thinking clearing (requires extended thinking enabled)
   */
  buildContextManagement(
    options: Partial<ContextEditingConfig> = {},
    includeThinking: boolean = false
  ): ContextManagement {
    const config = { ...this.config, ...options };
    const edits: (ClearToolUsesStrategy | ClearThinkingStrategy)[] = [];

    // Thinking clearing must come first if included
    if (includeThinking && config.enableThinkingClearing) {
      const thinkingStrategy: ClearThinkingStrategy = {
        type: 'clear_thinking_20251015',
        keep: {
          type: 'thinking_turns',
          value: config.keepThinkingTurns,
        },
      };
      edits.push(thinkingStrategy);
    }

    // Tool result clearing
    const toolStrategy: ClearToolUsesStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: config.triggerTokens,
      },
      keep: {
        type: 'tool_uses',
        value: config.keepToolUses,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: config.clearAtLeastTokens,
      },
    };

    // Add optional parameters
    if (config.excludeTools.length > 0) {
      toolStrategy.exclude_tools = config.excludeTools;
    }

    if (config.clearToolInputs) {
      toolStrategy.clear_tool_inputs = true;
    }

    edits.push(toolStrategy);

    return { edits };
  }

  /**
   * Get the beta header required for context management
   */
  getBetaHeader(): string {
    return CONTEXT_MANAGEMENT_BETA;
  }

  // ============================================
  // API Request Creation
  // ============================================

  /**
   * Create a message with context clearing enabled
   *
   * This wraps the standard client.beta.messages.create call with
   * the correct beta header and context_management configuration.
   *
   * @param client - Anthropic client instance
   * @param params - Message creation parameters
   * @param sessionId - Session ID for tracking
   */
  async createMessageWithClearing(
    client: Anthropic,
    params: {
      model: string;
      max_tokens: number;
      messages: Anthropic.MessageParam[];
      tools?: Anthropic.Tool[];
      system?: string | Anthropic.TextBlockParam[];
      thinking?: { type: 'enabled'; budget_tokens: number };
    },
    sessionId: string = 'unknown'
  ): Promise<Anthropic.Message & { context_management?: ContextManagementResponse }> {
    const includeThinking = !!params.thinking;
    const contextManagement = this.buildContextManagement({}, includeThinking);

    try {
      // Use beta API for context management
      const response = await (client.beta.messages as any).create({
        model: params.model,
        max_tokens: params.max_tokens,
        betas: [CONTEXT_MANAGEMENT_BETA, 'token-efficient-tools-2025-02-19'],
        tools: params.tools,
        messages: params.messages,
        system: params.system,
        ...(params.thinking && { thinking: params.thinking }),
        context_management: contextManagement,
      });

      // Extract and record edit results
      if (response.context_management?.applied_edits) {
        const result = this.parseAppliedEdits(response.context_management.applied_edits);
        this.recordEditResult(sessionId, result);

        this.emitEvent({
          type: 'edits:applied',
          sessionId,
          result,
        });

        // Report to metrics collector
        try {
          const metricsCollector = getMetricsCollector();
          if (result.clearedTokens > 0) {
            metricsCollector.recordCompaction('MINIMAL');
          }
        } catch {
          // Metrics collector not available - ignore
        }
      }

      return response;
    } catch (error) {
      this.emitEvent({
        type: 'edits:failed',
        sessionId,
        error: error as Error,
      });
      throw error;
    }
  }

  // ============================================
  // Result Parsing
  // ============================================

  /**
   * Parse applied edits from API response
   */
  private parseAppliedEdits(appliedEdits: AppliedEdit[]): ContextEditResult {
    let clearedToolUses = 0;
    let clearedThinkingTurns = 0;
    let clearedTokens = 0;

    for (const edit of appliedEdits) {
      clearedTokens += edit.cleared_input_tokens;

      if (edit.type === 'clear_tool_uses_20250919') {
        clearedToolUses += edit.cleared_tool_uses;
      } else if (edit.type === 'clear_thinking_20251015') {
        clearedThinkingTurns += edit.cleared_thinking_turns;
      }
    }

    return {
      applied: appliedEdits.length > 0,
      clearedToolUses,
      clearedThinkingTurns,
      clearedTokens,
      appliedEdits,
    };
  }

  /**
   * Record edit result for a session
   */
  private recordEditResult(sessionId: string, result: ContextEditResult): void {
    const history = this.editHistory.get(sessionId) || [];
    history.push(result);
    // Keep last 10 results per session
    this.editHistory.set(sessionId, history.slice(-10));
  }

  // ============================================
  // History & Metrics
  // ============================================

  /**
   * Get edit history for a session
   */
  getEditHistory(sessionId: string): ContextEditResult[] {
    return this.editHistory.get(sessionId) || [];
  }

  /**
   * Get aggregate statistics
   */
  getStats(): {
    totalSessions: number;
    totalEdits: number;
    totalTokensCleared: number;
    totalToolUsesCleared: number;
    totalThinkingTurnsCleared: number;
  } {
    let totalEdits = 0;
    let totalTokensCleared = 0;
    let totalToolUsesCleared = 0;
    let totalThinkingTurnsCleared = 0;

    for (const history of this.editHistory.values()) {
      for (const result of history) {
        if (result.applied) {
          totalEdits++;
          totalTokensCleared += result.clearedTokens;
          totalToolUsesCleared += result.clearedToolUses;
          totalThinkingTurnsCleared += result.clearedThinkingTurns;
        }
      }
    }

    return {
      totalSessions: this.editHistory.size,
      totalEdits,
      totalTokensCleared,
      totalToolUsesCleared,
      totalThinkingTurnsCleared,
    };
  }

  /**
   * Clear history for a session
   */
  clearSessionHistory(sessionId: string): void {
    this.editHistory.delete(sessionId);
  }

  /**
   * Clear all history
   */
  clearAllHistory(): void {
    this.editHistory.clear();
  }

  // ============================================
  // Event Emission
  // ============================================

  private emitEvent(event: ContextEditingEvent): void {
    this.emit(event.type, event);
    this.emit('context_editing_event', event);
  }

  // ============================================
  // Cleanup
  // ============================================

  /**
   * Clean up resources
   */
  destroy(): void {
    this.clearAllHistory();
    this.removeAllListeners();
    ContextEditingFallback.instance = null;
  }
}

// ============================================
// Singleton Getter
// ============================================

export function getContextEditingFallback(
  config?: Partial<ContextEditingConfig>
): ContextEditingFallback {
  return ContextEditingFallback.getInstance(config);
}

export default ContextEditingFallback;
