import type { CliResponse, CliToolCall, CliUsage } from '../base-cli-adapter';
import { generateId } from '../../../../shared/utils/id-generator';
import { extractThinkingContent, type ThinkingBlock } from '../../../../shared/utils/thinking-extractor';
import type { CodexDiagnostic } from './exec-diagnostics';
import { extractReasoningSections, mergeReasoningSections } from './reasoning';

export interface CodexParsedTranscript {
  hasMeaningfulOutput: boolean;
  response: CliResponse & { metadata: Record<string, unknown>; thinking?: ThinkingBlock[] };
  threadId?: string;
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

        if (
          itemType === 'file_change' || itemType === 'fileChange'
          || itemType === 'mcpToolCall' || itemType === 'dynamicToolCall'
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

function createToolId(): string {
  return `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
