/**
 * ACP assistant-stream coalescing.
 *
 * Copilot/Cursor/Grok often flush `agent_message_chunk` tokens *after*
 * `session/prompt` has already returned `end_turn`. If those late deltas
 * mint a new OutputMessage id, the renderer shows one bubble per token.
 * Keep a settled turn around so post-RPC chunks append to the same id.
 *
 * Some agents also attach a single trailing newline to each token
 * notification (NDJSON line discipline leaking into `content.text`).
 * Strip only that sole trailing newline; real paragraph breaks stay.
 */

export interface AcpAssistantTurnState {
  responseId: string;
  startedAt: number;
  chunks: string[];
  messageChunksById: Map<string, string[]>;
  agentMessageIds: Set<string>;
  retryNoticeId?: string;
  toolActivityChunks: string[];
}

export function createAcpAssistantTurn(responseId: string): AcpAssistantTurnState {
  return {
    responseId,
    startedAt: Date.now(),
    chunks: [],
    messageChunksById: new Map<string, string[]>(),
    agentMessageIds: new Set<string>(),
    toolActivityChunks: [],
  };
}

export function normalizeAcpAssistantDelta(text: string): string {
  if (!text) {
    return text;
  }

  const trimmed = text.endsWith('\r\n')
    ? text.slice(0, -2)
    : text.endsWith('\n')
      ? text.slice(0, -1)
      : text;
  if (trimmed === text) {
    return text;
  }
  if (trimmed.includes('\n') || trimmed.includes('\r')) {
    return text;
  }
  return trimmed;
}

export function resolveAcpChunkTurn(
  currentPrompt: AcpAssistantTurnState | null,
  recentAssistantTurn: AcpAssistantTurnState | null,
  sessionUpdate: 'agent_message_chunk' | 'user_message_chunk',
): AcpAssistantTurnState | null {
  if (sessionUpdate === 'user_message_chunk') {
    return currentPrompt;
  }
  return currentPrompt ?? recentAssistantTurn;
}

export function appendAcpAssistantDelta(
  turn: AcpAssistantTurnState,
  messageId: string,
  content: string,
): string {
  const messageChunks = turn.messageChunksById.get(messageId) ?? [];
  messageChunks.push(content);
  turn.messageChunksById.set(messageId, messageChunks);
  turn.chunks.push(content);
  turn.agentMessageIds.add(messageId);
  return messageChunks.join('');
}

export function collectAcpAssistantFlushes(
  turn: AcpAssistantTurnState,
): Array<{ id: string; content: string }> {
  const canonicalContent = turn.chunks.join('');
  if (canonicalContent.trim()) {
    return [{ id: turn.responseId, content: canonicalContent }];
  }

  const flushes: Array<{ id: string; content: string }> = [];
  for (const messageId of turn.agentMessageIds) {
    const accumulatedContent = (turn.messageChunksById.get(messageId) ?? []).join('');
    if (!accumulatedContent.trim()) {
      continue;
    }
    flushes.push({ id: messageId, content: accumulatedContent });
  }
  return flushes;
}
