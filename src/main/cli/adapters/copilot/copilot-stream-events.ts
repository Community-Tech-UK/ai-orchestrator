/**
 * Copilot CLI JSONL event types and stream parsers.
 *
 * Extracted from `copilot-cli-adapter.ts` so the adapter stays inside its
 * LOC ceiling and the NDJSON / partial-JSON parse path is independently
 * testable. No behaviour change from the previous in-file helpers.
 */

import { getLogger } from '../../../logging/logger';
import { parseNdjsonLine, parseStreamingJson } from '../../json-parse';

const logger = getLogger('CopilotCliAdapter');

/**
 * Events emitted by `copilot -p --output-format json --stream on`.
 * Not exhaustive; we only type the fields we actually read.
 */
export type CopilotEvent =
  | {
      type: 'assistant.message_delta';
      data?: { messageId?: string; deltaContent?: string };
    }
  | {
      type: 'assistant.message';
      data?: {
        messageId?: string;
        content?: string;
        outputTokens?: number;
      };
    }
  | {
      type: 'assistant.reasoning';
      data?: { content?: string; reasoningId?: string };
    }
  | {
      type: 'tool.execution_start';
      data?: {
        toolName?: string;
        toolCallId?: string;
        arguments?: Record<string, unknown>;
      };
    }
  | {
      type: 'tool.execution_complete';
      data?: {
        toolCallId?: string;
        toolName?: string;
        success?: boolean;
        result?: {
          content?: string;
          detailedContent?: string;
          contents?: unknown[];
        };
        error?: {
          message?: string;
          code?: string;
        };
      };
    }
  | {
      type: 'session.error';
      data?: { message?: string };
    }
  | {
      type: 'result';
      sessionId?: string;
      exitCode?: number;
      usage?: {
        premiumRequests?: number;
        totalApiDurationMs?: number;
        sessionDurationMs?: number;
        codeChanges?: { linesAdded?: number; linesRemoved?: number; filesModified?: string[] };
      };
    }
  | {
      // Uninterpreted setup / housekeeping events.
      type:
        | 'session.mcp_server_status_changed'
        | 'session.mcp_servers_loaded'
        | 'session.skills_loaded'
        | 'session.tools_updated'
        | 'session.idle'
        | 'user.message'
        | 'assistant.turn_start'
        | 'assistant.turn_end';
      data?: unknown;
    };

export function parseCopilotNdjsonEvent(line: string): CopilotEvent | null {
  const result = parseNdjsonLine<CopilotEvent>(line);
  return result.ok && isCopilotEvent(result.value) ? result.value : null;
}

export function parseCopilotStreamingEvent(line: string): (CopilotEvent & { partial?: boolean }) | null {
  const strict = parseCopilotNdjsonEvent(line);
  if (strict) {
    return strict;
  }

  const result = parseStreamingJson<CopilotEvent>(line);
  if (!result.ok || !isCopilotEvent(result.value)) {
    return null;
  }
  if (result.partial && !hasUsefulPartialCopilotPayload(result.value)) {
    return null;
  }
  return result.partial ? { ...result.value, partial: true } : result.value;
}

export function isCopilotEvent(value: unknown): value is CopilotEvent {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string';
}

export function logCopilotParseFailure(line: string): void {
  if (line.trim().startsWith('{')) {
    logger.warn('Failed to parse Copilot stream-json line', { linePreview: line.slice(0, 200) });
  }
}

function hasUsefulPartialCopilotPayload(event: CopilotEvent): boolean {
  if (event.type === 'assistant.message') {
    return typeof event.data?.content === 'string' && event.data.content.length > 0;
  }
  if (event.type === 'assistant.message_delta') {
    return typeof event.data?.deltaContent === 'string' && event.data.deltaContent.length > 0;
  }
  return false;
}
