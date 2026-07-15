/**
 * Microcompact - Surgical removal of old tool outputs without full summarization.
 * Inspired by Claude Code's microcompact system.
 */

import { getLogger } from '../logging/logger';
import { parseEvidenceCitations } from '../context-evidence/evidence-citation-parser';
import {
  isVerifiedEvidencePreview,
  type VerifiedEvidencePreview,
} from '../context-evidence/evidence-preview-builder';

const logger = getLogger('Microcompact');

export interface MicrocompactConfig {
  recentTurnsToProtect: number;
  minSavingsTokens: number;
}

export type AuthenticatedEvidencePreview = VerifiedEvidencePreview;

export interface MicrocompactToolCall {
  id: string;
  name: string;
  input: string;
  output?: string;
  inputTokens: number;
  outputTokens: number;
  evidencePreview?: AuthenticatedEvidencePreview;
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
      toolCalls: t.toolCalls?.map(tc => ({
        ...tc,
        evidencePreview: tc.evidencePreview,
      })),
    }));

    const protectedStartIndex = Math.max(0, result.length - this.config.recentTurnsToProtect);

    // First pass: calculate potential savings
    let potentialSavings = 0;
    let eligibleOutputs = 0;
    for (let i = 0; i < protectedStartIndex; i++) {
      const turn = result[i];
      if (!turn.toolCalls) continue;
      for (const tc of turn.toolCalls) {
        if (hasAuthenticatedEvidencePreview(tc)) {
          eligibleOutputs++;
          potentialSavings += tc.outputTokens - tc.evidencePreview.tokenCount;
        }
      }
    }

    if (eligibleOutputs === 0 || potentialSavings < this.config.minSavingsTokens) {
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
        if (hasAuthenticatedEvidencePreview(tc)) {
          tokensSaved += tc.outputTokens - tc.evidencePreview.tokenCount;
          tc.output = tc.evidencePreview.preview;
          tc.outputTokens = tc.evidencePreview.tokenCount;
          turnCompacted = true;
        }
      }

      if (turnCompacted) turnsCompacted++;
    }

    logger.info('Microcompact completed', { tokensSaved, turnsCompacted });
    return { turns: result, tokensSaved, turnsCompacted, skipped: false };
  }
}

export function hasAuthenticatedEvidencePreview(
  toolCall: MicrocompactToolCall,
): toolCall is MicrocompactToolCall & { evidencePreview: NonNullable<MicrocompactToolCall['evidencePreview']> } {
  const preview = toolCall.evidencePreview;
  if (
    !toolCall.output
    || !isVerifiedEvidencePreview(preview)
    || preview.tokenCount < 0
    || toolCall.outputTokens <= preview.tokenCount
  ) {
    return false;
  }

  const parsed = parseEvidenceCitations(preview.preview);
  return parsed.malformedMarkers.length === 0
    && parsed.citations.some(citation => citation.evidenceId === preview.evidenceId);
}
