/**
 * Microcompact - Surgical removal of old tool outputs without full summarization.
 * Inspired by Claude Code's microcompact system.
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('Microcompact');

const PLACEHOLDER_TOKEN_COST = 5;

export interface MicrocompactConfig {
  recentTurnsToProtect: number;
  minSavingsTokens: number;
}

export interface MicrocompactToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MicrocompactTurn {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  toolCalls?: MicrocompactToolCall[];
  metadata?: Record<string, unknown>;
}

export interface MicrocompactResult {
  turns: MicrocompactTurn[];
  tokensSaved: number;
  turnsCompacted: number;
  skipped: boolean;
}

const DEFAULT_CONFIG: MicrocompactConfig = {
  recentTurnsToProtect: 3,
  minSavingsTokens: 500,
};

export class Microcompact {
  private config: MicrocompactConfig;

  constructor(config?: Partial<MicrocompactConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  compact(turns: MicrocompactTurn[]): MicrocompactResult {
    const result = turns.map(t => ({
      ...t,
      toolCalls: t.toolCalls?.map(tc => ({ ...tc })),
    }));

    const protectedStartIndex = Math.max(0, result.length - this.config.recentTurnsToProtect);

    // First pass: calculate potential savings
    let potentialSavings = 0;
    for (let i = 0; i < protectedStartIndex; i++) {
      const turn = result[i];
      if (!turn.toolCalls) continue;
      for (const tc of turn.toolCalls) {
        if (tc.output && tc.outputTokens > PLACEHOLDER_TOKEN_COST) {
          potentialSavings += tc.outputTokens - PLACEHOLDER_TOKEN_COST;
        }
      }
    }

    if (potentialSavings < this.config.minSavingsTokens) {
      return { turns: result, tokensSaved: 0, turnsCompacted: 0, skipped: true };
    }

    // Second pass: compact old tool outputs
    let tokensSaved = 0;
    let turnsCompacted = 0;

    for (let i = 0; i < protectedStartIndex; i++) {
      const turn = result[i];
      if (!turn.toolCalls) continue;

      let turnCompacted = false;
      for (const tc of turn.toolCalls) {
        if (tc.output && tc.outputTokens > PLACEHOLDER_TOKEN_COST) {
          tokensSaved += tc.outputTokens - PLACEHOLDER_TOKEN_COST;
          tc.output = '[microcompacted]';
          tc.outputTokens = PLACEHOLDER_TOKEN_COST;
          turnCompacted = true;
        }
      }

      if (turnCompacted) turnsCompacted++;
    }

    logger.info('Microcompact completed', { tokensSaved, turnsCompacted });
    return { turns: result, tokensSaved, turnsCompacted, skipped: false };
  }
}
