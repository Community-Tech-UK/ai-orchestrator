/**
 * WS14 — pure mapper from Copilot SDK session events to adapter effects
 * (WS1 mapper pattern: pure function + fixture corpus spec; the server
 * session wrapper turns effects into adapter emissions).
 *
 * Event shapes are typed LOCALLY as a structural subset of the SDK's
 * generated `session-events.d.ts` (verified against @github/copilot 1.0.x)
 * because the SDK itself is runtime-discovered, not a compile-time import.
 *
 * Sub-agent events (`agentId` set) are intentionally skipped for the
 * instance transcript: interleaving sub-agent deltas with the root stream
 * would corrupt the accumulated assistant message. Revisit with livetest
 * evidence if sub-agent progress is worth surfacing separately.
 */

/** Structural subset of the SDK session event union — only what we map. */
export interface CopilotServerEvent {
  type: string;
  agentId?: string;
  data?: Record<string, unknown>;
}

export type MappedCopilotServerEffect =
  | { kind: 'assistant-delta'; messageId: string; delta: string }
  | { kind: 'assistant-message'; messageId: string; content: string; outputTokens?: number }
  | { kind: 'reasoning'; content: string }
  | { kind: 'tool-start'; toolCallId?: string; toolName: string; args?: Record<string, unknown> }
  | {
      kind: 'tool-complete';
      toolCallId?: string;
      toolName?: string;
      success: boolean;
      errorMessage?: string;
      result?: unknown;
    }
  | { kind: 'context'; used: number; total: number }
  | { kind: 'session-error'; message: string; errorType?: string; errorCode?: string }
  | { kind: 'turn-start' }
  | { kind: 'turn-end' }
  | { kind: 'idle' }
  | { kind: 'ignored'; type: string };

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function mapCopilotServerEvent(event: CopilotServerEvent): MappedCopilotServerEffect {
  // Root-agent transcript only (see header).
  if (event.agentId) {
    return { kind: 'ignored', type: event.type };
  }
  const data = event.data ?? {};

  switch (event.type) {
    case 'assistant.message_delta': {
      const delta = str(data['deltaContent']);
      const messageId = str(data['messageId']);
      if (!delta || !messageId) return { kind: 'ignored', type: event.type };
      return { kind: 'assistant-delta', messageId, delta };
    }

    case 'assistant.message': {
      const content = str(data['content']);
      const messageId = str(data['messageId']);
      if (!content || !messageId) return { kind: 'ignored', type: event.type };
      const outputTokens = num(data['outputTokens']);
      return {
        kind: 'assistant-message',
        messageId,
        content,
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      };
    }

    case 'assistant.reasoning': {
      const content = str(data['content']);
      return content ? { kind: 'reasoning', content } : { kind: 'ignored', type: event.type };
    }

    case 'tool.execution_start': {
      const toolName = str(data['toolName']) ?? 'unknown';
      return {
        kind: 'tool-start',
        toolName,
        toolCallId: str(data['toolCallId']),
        args: rec(data['arguments']),
      };
    }

    case 'tool.execution_complete': {
      const error = rec(data['error']);
      return {
        kind: 'tool-complete',
        toolCallId: str(data['toolCallId']),
        toolName: str(data['toolName']),
        success: data['success'] !== false,
        errorMessage: str(error?.['message']),
        result: data['result'],
      };
    }

    case 'session.usage_info': {
      // REAL context occupancy — a major upgrade over exec mode's estimate.
      const used = num(data['currentTokens']);
      const total = num(data['tokenLimit']);
      if (used === undefined || total === undefined || total <= 0) {
        return { kind: 'ignored', type: event.type };
      }
      return { kind: 'context', used, total };
    }

    case 'session.error': {
      return {
        kind: 'session-error',
        message: str(data['message']) ?? 'Copilot session error',
        errorType: str(data['errorType']),
        errorCode: str(data['errorCode']),
      };
    }

    case 'assistant.turn_start':
      return { kind: 'turn-start' };
    case 'assistant.turn_end':
      return { kind: 'turn-end' };
    case 'session.idle':
      return { kind: 'idle' };

    default:
      return { kind: 'ignored', type: event.type };
  }
}
