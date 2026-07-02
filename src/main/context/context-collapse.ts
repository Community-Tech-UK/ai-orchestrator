/**
 * Context Collapse
 *
 * Read-time projection over conversation history that can avoid expensive
 * LLM summarization by collapsing old turns to brief structural markers.
 *
 * Inspired by Claude Code's context_collapse system:
 * - Staged collapses computed cheaply (no LLM needed)
 * - Applied only when needed (saves ~90% of full summarization cost)
 * - Overflow recovery as first-resort before reactive compact
 */

import { getLogger } from '../logging/logger';
import { repairOrphanedToolPairs } from './tool-pair-repair';

const logger = getLogger('ContextCollapse');

/** Collapsed turn placeholder cost in tokens */
const COLLAPSE_PLACEHOLDER_TOKENS = 15;

export interface ContextCollapseConfig {
  /** Number of recent turns protected from collapse */
  collapseAfterTurns: number;
  /** Minimum token count for a turn to be worth collapsing */
  minTokensToCollapse: number;
}

export interface CollapsibleTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  collapsible?: boolean;
  toolCalls?: { name: string; id: string; output?: string }[];
  /**
   * Set when this turn IS a tool_result for a tool_use issued on an
   * earlier turn (split tool_use/tool_result message models only —
   * this codebase's primary `ConversationTurn` model pairs input/output
   * on the same `toolCalls[]` entry and never sets this).
   */
  toolResultFor?: string;
}

export interface StagedCollapse {
  collapsedTurnIds: string[];
  estimatedTokensSaved: number;
}

export interface ApplyResult {
  turns: CollapsibleTurn[];
  tokensSaved: number;
}

const DEFAULT_CONFIG: ContextCollapseConfig = {
  collapseAfterTurns: 5,
  minTokensToCollapse: 100,
};

export class ContextCollapse {
  private config: ContextCollapseConfig;
  /** Track which turns have been collapsed (persists across calls) */
  private collapsedStore = new Set<string>();

  constructor(config?: Partial<ContextCollapseConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Stage collapses: identify which turns CAN be collapsed.
   * This is a cheap computation (no LLM). Collapses are not applied yet.
   */
  stageCollapses(turns: CollapsibleTurn[]): StagedCollapse {
    const naiveProtectedIndex = Math.max(0, turns.length - this.config.collapseAfterTurns);

    // Orphan-repair invariant (B3): collapsing turns before `protectedIndex`
    // is itself a "cut" — collapsed turns lose their toolCalls entirely
    // (see applyCollapses). If the boundary would split a tool_use turn
    // from its tool_result turn (split message models only; this
    // codebase's ConversationTurn pairs input/output on one turn and is
    // unaffected), walk the protected boundary backward so the pair
    // collapses or survives together rather than being torn apart.
    const repaired = repairOrphanedToolPairs(turns, naiveProtectedIndex);
    const protectedIndex = naiveProtectedIndex - repaired.boundaryShift;
    if (repaired.dropped.length > 0) {
      logger.warn('Dropped orphaned tool call(s) at collapse boundary', {
        boundaryShift: repaired.boundaryShift,
        dropped: repaired.dropped,
      });
    }

    const collapsedTurnIds: string[] = [];
    let estimatedTokensSaved = 0;

    for (let i = 0; i < protectedIndex; i++) {
      const turn = turns[i];
      if (turn.collapsible === false) continue;
      if (turn.tokenCount < this.config.minTokensToCollapse) continue;
      if (this.collapsedStore.has(turn.id)) continue; // Already collapsed

      collapsedTurnIds.push(turn.id);
      estimatedTokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
    }

    return { collapsedTurnIds, estimatedTokensSaved };
  }

  /**
   * Apply staged collapses to the turn array.
   * Returns a new array with collapsed turns replaced by placeholders.
   */
  applyCollapses(turns: CollapsibleTurn[], staged: StagedCollapse): ApplyResult {
    const collapseSet = new Set(staged.collapsedTurnIds);
    let tokensSaved = 0;

    const result = turns.map(turn => {
      if (!collapseSet.has(turn.id)) return { ...turn };

      const toolNames = turn.toolCalls?.map(tc => tc.name).join(', ') || '';
      const summary = toolNames
        ? `[collapsed: ${turn.role} turn with tools: ${toolNames}]`
        : `[collapsed: ${turn.role} turn]`;

      tokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
      this.collapsedStore.add(turn.id);

      return {
        ...turn,
        content: summary,
        tokenCount: COLLAPSE_PLACEHOLDER_TOKENS,
        toolCalls: undefined,
      };
    });

    logger.info('Context collapse applied', {
      turnsCollapsed: staged.collapsedTurnIds.length,
      tokensSaved,
    });

    return { turns: result, tokensSaved };
  }

  /**
   * Emergency: recover from prompt-too-long by aggressively collapsing.
   * Protects only the last turn.
   */
  recoverFromOverflow(turns: CollapsibleTurn[]): StagedCollapse {
    const protectedIndex = Math.max(0, turns.length - 1); // Protect only last turn
    const collapsedTurnIds: string[] = [];
    let estimatedTokensSaved = 0;

    for (let i = 0; i < protectedIndex; i++) {
      const turn = turns[i];
      if (turn.collapsible === false) continue;
      if (this.collapsedStore.has(turn.id)) continue;
      if (turn.tokenCount <= COLLAPSE_PLACEHOLDER_TOKENS) continue;

      collapsedTurnIds.push(turn.id);
      estimatedTokensSaved += turn.tokenCount - COLLAPSE_PLACEHOLDER_TOKENS;
    }

    logger.warn('Context collapse overflow recovery', {
      turnsToCollapse: collapsedTurnIds.length,
      estimatedTokensSaved,
    });

    return { collapsedTurnIds, estimatedTokensSaved };
  }

  /** Reset tracked collapses (e.g., on session reset) */
  reset(): void {
    this.collapsedStore.clear();
  }
}
