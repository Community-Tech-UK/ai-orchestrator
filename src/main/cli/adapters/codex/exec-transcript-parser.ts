import type { CliResponse, CliToolCall, CliUsage } from '../base-cli-adapter';
import { generateId } from '../../../../shared/utils/id-generator';
import { extractThinkingContent, type ThinkingBlock } from '../../../../shared/utils/thinking-extractor';
import type { CodexDiagnostic } from './exec-diagnostics';
import { extractReasoningSections, mergeReasoningSections } from './reasoning';

export interface CodexParsedTranscript {
  hasMeaningfulOutput: boolean;
  response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
  threadId?: string;
  /**
   * Human-readable error surfaced by codex on a failed turn. Codex emits
   * failures as `{"type":"error",...}` / `{"type":"turn.failed",...}` events on
   * STDOUT (the only stderr line is the benign "Reading prompt from stdin..."),
   * so without parsing these the real cause (e.g. "model is not supported when
   * using Codex with a ChatGPT account") is lost. Populated only when the
   * transcript contained an error/turn.failed event.
   */
  errorMessage?: string;
}

export function parseCodexExecTranscript(
  rawStdout: string,
  diagnostics: CodexDiagnostic[],
  responseId: string,
): CodexParsedTranscript {
  const lines = rawStdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: CliToolCall[] = [];
  let usage: CliUsage | undefined;
  let threadId: string | undefined;
  let errorMessage: string | undefined;

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const type = typeof event['type'] === 'string' ? event['type'] : '';

      if (!threadId) {
        const id = event['thread_id'] ?? event['session_id'] ?? event['id'];
        if (
          typeof id === 'string'
          && (type === 'thread.started'
            || type === 'session.started'
            || type === 'session.created'
            || type === 'thread.created')
        ) {
          threadId = id;
          continue;
        }
      }

      if (type === 'error' || type === 'turn.failed') {
        const rawMessage = type === 'turn.failed'
          ? extractTurnFailedMessage(event)
          : (typeof event['message'] === 'string' ? event['message'] : undefined);
        const cleaned = cleanCodexErrorMessage(rawMessage);
        if (cleaned && !errorMessage) {
          errorMessage = cleaned;
        }
        continue;
      }

      if (type === 'turn.completed' && event['usage'] && typeof event['usage'] === 'object') {
        const usageEvent = event['usage'] as Record<string, unknown>;
        const inputTokens = typeof usageEvent['input_tokens'] === 'number' ? usageEvent['input_tokens'] : 0;
        const outputTokens = typeof usageEvent['output_tokens'] === 'number' ? usageEvent['output_tokens'] : 0;
        usage = {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
        continue;
      }

      if (type === 'item.completed' && event['item'] && typeof event['item'] === 'object') {
        const item = event['item'] as Record<string, unknown>;
        const itemType = typeof item['type'] === 'string' ? item['type'] : '';

        if (itemType === 'agent_message') {
          const text = extractTextFromItem(item);
          if (text) {
            contentParts.push(text);
          }
          continue;
        }

        if (itemType === 'command_execution') {
          toolCalls.push({
            id: typeof item['id'] === 'string' ? item['id'] : createToolId(),
            name: 'command_execution',
            arguments: {
              command: item['command'],
              exitCode: item['exit_code'],
              status: item['status'],
            },
            result: typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : undefined,
          });
          continue;
        }

        if (itemType === 'reasoning') {
          const sections = extractReasoningSections(
            item['summary'] ?? item['summaryText'] ?? item['text'] ?? item['content'],
          );
          reasoningParts.push(...sections);
          continue;
        }

        if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall') {
          toolCalls.push({
            id: typeof item['id'] === 'string' ? item['id'] : createToolId(),
            name: extractToolCallName(item),
            arguments: extractToolCallArguments(item),
            result: extractToolCallResult(item),
          });
          continue;
        }

        if (
          itemType === 'file_change' || itemType === 'fileChange'
          || itemType === 'webSearch' || itemType === 'exitedReviewMode'
          || itemType === 'collaboration'
        ) {
          continue;
        }

        const fallbackText = extractTextFromItem(item);
        if (fallbackText) {
          contentParts.push(fallbackText);
        }
        continue;
      }

      if (type === 'message' && typeof event['content'] === 'string') {
        contentParts.push(event['content']);
        continue;
      }

      if (type === 'agent_message' && event['message'] && typeof event['message'] === 'object') {
        const message = event['message'] as Record<string, unknown>;
        if (typeof message['content'] === 'string') {
          contentParts.push(message['content']);
        }
        continue;
      }

      if (type === 'text' && typeof event['text'] === 'string') {
        contentParts.push(event['text']);
        continue;
      }
    } catch {
      if (!line.startsWith('{')) {
        contentParts.push(line);
      }
    }
  }

  let content = contentParts.join('\n').trim();
  if (!content) {
    content = cleanCodexContent(rawStdout);
  }

  if (toolCalls.length === 0) {
    toolCalls.push(...extractToolCallsFromFallback(rawStdout));
  }

  const extracted = extractThinkingContent(content);
  const allThinking: ThinkingBlock[] = [];
  const dedupedReasoning = mergeReasoningSections([], reasoningParts);
  if (dedupedReasoning.length > 0) {
    allThinking.push({
      id: generateId(),
      content: dedupedReasoning.join('\n\n'),
      format: 'structured',
    });
  }
  allThinking.push(...extracted.thinking);

  return {
    hasMeaningfulOutput: extracted.response.trim().length > 0 || toolCalls.length > 0,
    errorMessage,
    response: {
      id: responseId,
      content: extracted.response,
      role: 'assistant',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      metadata: {
        diagnostics,
        threadId,
      },
      raw: rawStdout,
      thinking: allThinking.length > 0 ? allThinking : undefined,
    },
    threadId,
  };
}

function extractTurnFailedMessage(event: Record<string, unknown>): string | undefined {
  const error = event['error'];
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>)['message'];
    if (typeof message === 'string') {
      return message;
    }
  }
  if (typeof event['message'] === 'string') {
    return event['message'];
  }
  return undefined;
}

/**
 * Codex frequently double-encodes its error payloads — the `message` field is
 * itself a JSON string like `{"type":"error","status":400,"error":{"message":
 * "The 'gpt-5.3-codex' model is not supported ..."}}`. Unwrap one level so the
 * surfaced error is the human-readable sentence, not raw JSON.
 */
function cleanCodexErrorMessage(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const nestedError = parsed['error'];
      const nestedMessage =
        nestedError && typeof nestedError === 'object'
          ? (nestedError as Record<string, unknown>)['message']
          : undefined;
      const inner = nestedMessage ?? parsed['message'];
      if (typeof inner === 'string' && inner.trim()) {
        return inner.trim();
      }
    } catch {
      // Not valid JSON — fall through and return the raw string.
    }
  }
  return trimmed;
}

function extractTextFromItem(item: Record<string, unknown>): string | undefined {
  if (typeof item['text'] === 'string') {
    return item['text'];
  }

  const message = item['message'];
  if (message && typeof message === 'object' && typeof (message as Record<string, unknown>)['content'] === 'string') {
    return (message as Record<string, unknown>)['content'] as string;
  }

  const content = item['content'];
  if (typeof content === 'string') {
    return content;
  }

  return undefined;
}

function cleanCodexContent(raw: string): string {
  const nonJsonContent = raw
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() && !line.trim().startsWith('{'))
    .join('\n');
  const { response } = extractThinkingContent(nonJsonContent);
  return response
    .replace(/\[TOOL:\s*\w+\][\s\S]*?\[\/TOOL\]/g, '')
    .replace(/\[codex\].*$/gim, '')
    .trim();
}

function extractToolCallsFromFallback(raw: string): CliToolCall[] {
  const toolCalls: CliToolCall[] = [];
  const toolPattern = /\[TOOL:\s*(\w+)\]([\s\S]*?)\[\/TOOL\]/g;
  let match: RegExpExecArray | null;

  while ((match = toolPattern.exec(raw)) !== null) {
    toolCalls.push({
      id: createToolId(),
      name: match[1],
      arguments: { raw: match[2].trim() },
    });
  }

  return toolCalls;
}

function extractToolCallName(item: Record<string, unknown>): string {
  for (const key of ['tool', 'toolName', 'name']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return 'unknown';
}

function extractToolCallArguments(item: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['input', 'arguments', 'args']) {
    const value = item[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
}

function extractToolCallResult(item: Record<string, unknown>): string | undefined {
  for (const key of ['output', 'result', 'content', 'text', 'description']) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function createToolId(): string {
  return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
