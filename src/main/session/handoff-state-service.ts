/**
 * Maintained rolling handoff state (runtime-reconciler spec item 5).
 *
 * Per-instance handoff document maintained incrementally as turns complete:
 * a compaction-style rolling summary (deterministic, `generateLocalSummary`,
 * anchored across folds), a bounded ring of recent verbatim turns, unresolved
 * items, and key workspace facts. Rendered on demand for the hydration
 * ladder's bottom rung — replacing the swap-time replay-preamble construction
 * when `sessionHandoffStateEnabled` is ON. Native resume and the
 * token-budgeted full-history injection (`buildFallbackHistory`) remain the
 * upper rungs and are untouched.
 *
 * Redaction follows the compaction prompt's rules (`redactSecrets`), applied
 * both when folding into the summary and over the rendered document.
 *
 * No persistence in v1: the document is rebuildable from the transcript
 * (`buildHandoffDocumentFromMessages`); the incremental state is a quality
 * and latency optimization, not an authority.
 */

import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ConversationTurn } from '../context/context-compactor';
import { generateLocalSummary } from '../context/context-local-summary';
import { redactSecrets } from '../context/context-compaction-prompt';
import { extractUnresolvedItems } from './replay-continuity';
import {
  extractFileOperationsFromTurns,
  summarizeFileOperations,
} from '../context/file-operation-extractor';
import { getLogger } from '../logging/logger';

const logger = getLogger('HandoffStateService');

const MAX_RING_TURNS = 24;
const FOLD_BATCH = 8;
const MAX_CHARS_PER_TURN = 800;
const MAX_UNRESOLVED = 5;
const MAX_DOCUMENT_CHARS = 14_000;
const MAX_TRACKED_INSTANCES = 300;

interface HandoffTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface HandoffState {
  /** Message ids already ingested (bounded implicitly by ring + fold). */
  seenIds: Set<string>;
  ring: HandoffTurn[];
  rollingSummary: string | null;
  foldedTurnCount: number;
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}...[truncated]`;
}

function toConversationTurn(turn: HandoffTurn): ConversationTurn {
  return {
    id: turn.id,
    role: turn.role,
    content: turn.content,
    timestamp: turn.timestamp,
    tokenCount: Math.ceil(turn.content.length / 4),
  };
}

function conversationalMessages(messages: readonly OutputMessage[]): HandoffTurn[] {
  return messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .map((message) => ({
      id: message.id,
      role: message.type as 'user' | 'assistant',
      content: truncate(message.content, MAX_CHARS_PER_TURN),
      timestamp: message.timestamp,
    }));
}

export interface HandoffDocumentMeta {
  reason: string;
  workingDirectory?: string;
  provider?: string;
  model?: string;
}

function renderDocument(parts: {
  meta: HandoffDocumentMeta;
  rollingSummary: string | null;
  foldedTurnCount: number;
  ring: readonly HandoffTurn[];
  unresolved: string[];
}): string | null {
  if (parts.ring.length === 0 && !parts.rollingSummary) {
    return null;
  }

  const facts: string[] = [];
  if (parts.meta.workingDirectory) facts.push(`- Working directory: ${parts.meta.workingDirectory}`);
  if (parts.meta.provider) {
    facts.push(`- Runtime: ${parts.meta.provider}${parts.meta.model ? ` (${parts.meta.model})` : ''}`);
  }
  const fileOps = extractFileOperationsFromTurns(parts.ring.map(toConversationTurn));
  if (fileOps.length > 0) {
    facts.push(`- File operations observed:\n${summarizeFileOperations(fileOps, 20)}`);
  }

  const lines: string[] = [
    '<conversation_history>',
    `Resume mode: maintained handoff document (${parts.meta.reason}). Native session state was unavailable, so this incrementally maintained handoff is being provided as context.`,
    'Tool calls and tool results from the earlier conversation were already executed. Do not repeat them unless the user explicitly asks you to rerun something.',
  ];

  if (parts.rollingSummary) {
    lines.push('', `Rolling summary (${parts.foldedTurnCount} earlier turns folded):`, parts.rollingSummary);
  }

  lines.push('', 'Unresolved items:');
  if (parts.unresolved.length > 0) {
    for (const item of parts.unresolved) lines.push(`- ${truncate(item, MAX_CHARS_PER_TURN)}`);
  } else {
    lines.push('- None explicitly captured.');
  }

  if (facts.length > 0) {
    lines.push('', 'Key workspace facts:', ...facts);
  }

  lines.push('', 'Recent transcript:');
  for (const turn of parts.ring) {
    lines.push(`${turn.role === 'user' ? 'Human' : 'Assistant'}: ${turn.content}`);
  }
  lines.push('</conversation_history>');
  lines.push('Use this as background context for the next reply. Prefer continuing the task over asking the user to repeat information unless critical context is still missing.');

  return truncate(redactSecrets(lines.join('\n')), MAX_DOCUMENT_CHARS);
}

export class HandoffStateService {
  private static instance: HandoffStateService | null = null;

  /** Insertion order doubles as LRU order — re-insert on write. */
  private readonly states = new Map<string, HandoffState>();

  static getInstance(): HandoffStateService {
    if (!this.instance) this.instance = new HandoffStateService();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Incremental maintenance: ingest conversational messages this service has
   * not yet seen for the instance, fold overflow into the rolling summary.
   * Called from the turn-completion seam; must stay cheap (no LLM calls).
   */
  noteTurnCompleted(instance: Pick<Instance, 'id' | 'outputBuffer'>): void {
    const state = this.takeState(instance.id);
    const incoming = conversationalMessages(instance.outputBuffer)
      .filter((turn) => !state.seenIds.has(turn.id));
    if (incoming.length === 0) return;

    for (const turn of incoming) {
      state.seenIds.add(turn.id);
      state.ring.push(turn);
    }

    while (state.ring.length > MAX_RING_TURNS) {
      const folded = state.ring.splice(0, FOLD_BATCH);
      // Anchor the prior summary so decisions survive successive folds —
      // same semantics as compaction rounds.
      state.rollingSummary = redactSecrets(
        generateLocalSummary(folded.map(toConversationTurn), state.rollingSummary),
      );
      state.foldedTurnCount += folded.length;
      for (const turn of folded) {
        // The content lives in the summary now; keep the id so re-ingest of a
        // replayed buffer cannot double-count it.
        state.seenIds.add(turn.id);
      }
    }
  }

  /**
   * Render the maintained handoff document for the hydration ladder's bottom
   * rung. Returns null when nothing has been maintained for the instance —
   * callers must fall through to the existing replay-preamble builder.
   */
  buildHandoffDocument(
    instance: Pick<Instance, 'id' | 'outputBuffer' | 'workingDirectory' | 'provider' | 'currentModel'>,
    reason: string,
  ): string | null {
    const state = this.states.get(instance.id);
    if (!state || (state.ring.length === 0 && !state.rollingSummary)) {
      return null;
    }
    try {
      return renderDocument({
        meta: {
          reason,
          workingDirectory: instance.workingDirectory,
          provider: instance.provider,
          model: instance.currentModel,
        },
        rollingSummary: state.rollingSummary,
        foldedTurnCount: state.foldedTurnCount,
        ring: state.ring,
        unresolved: extractUnresolvedItems(instance.outputBuffer as OutputMessage[], MAX_UNRESOLVED),
      });
    } catch (error) {
      logger.warn('Handoff document render failed; caller falls back to replay preamble', {
        instanceId: instance.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  removeInstance(instanceId: string): void {
    this.states.delete(instanceId);
  }

  private takeState(instanceId: string): HandoffState {
    let state = this.states.get(instanceId);
    if (state) {
      this.states.delete(instanceId);
    } else {
      state = { seenIds: new Set<string>(), ring: [], rollingSummary: null, foldedTurnCount: 0 };
    }
    this.states.set(instanceId, state);
    if (this.states.size > MAX_TRACKED_INSTANCES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
    return state;
  }
}

/**
 * Stateless render for archive-backed consumers (history restore) where no
 * live rolling state exists: folds all but the most recent ring-width of
 * turns into a one-shot summary, then renders the same document shape.
 */
export function buildHandoffDocumentFromMessages(
  messages: readonly OutputMessage[],
  meta: HandoffDocumentMeta,
): string | null {
  const turns = conversationalMessages(messages);
  if (turns.length === 0) return null;

  const ring = turns.slice(-MAX_RING_TURNS);
  const folded = turns.slice(0, -MAX_RING_TURNS);
  const rollingSummary = folded.length > 0
    ? redactSecrets(generateLocalSummary(folded.map(toConversationTurn), null))
    : null;

  return renderDocument({
    meta,
    rollingSummary,
    foldedTurnCount: folded.length,
    ring,
    unresolved: extractUnresolvedItems(messages as OutputMessage[], MAX_UNRESOLVED),
  });
}

export function getHandoffStateService(): HandoffStateService {
  return HandoffStateService.getInstance();
}
