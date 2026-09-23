/**
 * ACP `agent_thought_chunk` handling.
 *
 * Thought chunks are the agent's reasoning. They must never reach assistant
 * text: they are collected per turn and attached to the turn's assistant
 * message as `thinking` blocks, the same shape Codex and Copilot reasoning
 * takes (`format: 'sdk'`, `thinkingExtracted: true`).
 */

import type { ThinkingContent } from '../../../shared/types/instance.types';
import type { AcpAssistantTurnState } from './acp-assistant-stream';

const DEFAULT_THOUGHT_KEY = 'thought';

/** Append one thought delta. Chunks sharing a `messageId` form one thinking block. */
export function appendAcpThoughtDelta(
  turn: AcpAssistantTurnState,
  messageId: string | undefined,
  text: string,
): void {
  if (!text) return;
  const key = messageId?.trim() || DEFAULT_THOUGHT_KEY;
  const chunks = turn.thoughtChunksById.get(key) ?? [];
  chunks.push(text);
  turn.thoughtChunksById.set(key, chunks);
}

/**
 * The turn's thinking blocks in arrival order, or undefined when there are
 * none. Ids are derived from the turn so repeated flushes of the same turn
 * produce the same ids and the renderer can merge them.
 */
export function buildAcpTurnThinking(turn: AcpAssistantTurnState): ThinkingContent[] | undefined {
  const blocks: ThinkingContent[] = [];
  let index = 0;
  for (const chunks of turn.thoughtChunksById.values()) {
    const content = chunks.join('').trim();
    if (!content) continue;
    blocks.push({ id: `${turn.responseId}-thought-${index}`, content, format: 'sdk' });
    index += 1;
  }
  return blocks.length > 0 ? blocks : undefined;
}
