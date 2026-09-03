/**
 * Claude CLI `assistant` stream-message handling.
 *
 * Extracted from `claude-cli-adapter.ts` so the adapter stays inside its LOC
 * ceiling. Callers pass the live adapter host; this module does not own
 * adapter state. Behaviour matches the previous `processCliMessage` case.
 */

import type { CliStreamMessage } from '../../../shared/types/cli.types';
import type { InstanceStatus, ThinkingContent } from '../../../shared/types/instance.types';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import { parseClaudeStreamError } from './claude-stream-error';
import { parseClaudeAsyncWorkToolUse, type CliAsyncWorkEvent } from './claude-cli-async-work';
import type { RawCliPayload } from './claude-cli-adapter.types';

export interface ClaudeAssistantMessageHost {
  emit(event: string, ...args: unknown[]): boolean;
  rememberToolUse(toolUseId: string | undefined, toolName: string | undefined, input: unknown): void;
  emitAsyncWork(event: CliAsyncWorkEvent | null): void;
  emitAskUserQuestionInputRequired(
    toolUseId: string | undefined,
    input: unknown,
    timestamp: number,
    fallbackText?: string,
  ): void;
  lastKnownContextWindow: number;
  hasPerCallUsageThisTurn: boolean;
  lastObservedContextUsage: { used: number; total: number } | null;
}

export function processClaudeAssistantMessage(
  host: ClaudeAssistantMessageHost,
  message: CliStreamMessage,
  raw: RawCliPayload,
): void {
  const assistantMsg = raw;
  const assistantTimestamp = message.timestamp || Date.now();

  const streamError = parseClaudeStreamError(assistantMsg as unknown as Record<string, unknown>);
  if (streamError) {
    host.emit('error', streamError.error);
    return;
  }

  let precedingText = '';
  let pendingThinking: ThinkingContent[] = [];

  const emitAssistantTextBlock = (rawText: string): void => {
    const extracted = extractThinkingContent(rawText, { headerStyle: false });
    const response = extracted.response;
    const blockThinking = [
      ...pendingThinking,
      ...extracted.thinking.map(t => ({ ...t, timestamp: assistantTimestamp })),
    ];
    pendingThinking = [];
    if (response.trim() || blockThinking.length > 0) {
      host.emit('output', {
        id: generateId(),
        timestamp: assistantTimestamp,
        type: 'assistant',
        content: response,
        thinking: blockThinking.length > 0 ? blockThinking : undefined,
        thinkingExtracted: true,
      });
    }
    if (response.trim()) {
      precedingText = precedingText ? `${precedingText}\n${response}` : response;
    }
  };

  if (assistantMsg.message?.content) {
    for (const block of assistantMsg.message.content) {
      if (block.type === 'thinking' && block.thinking) {
        pendingThinking.push({
          id: generateId(),
          content: block.thinking,
          format: 'structured',
          timestamp: assistantTimestamp,
        });
      } else if (block.type === 'text' && block.text) {
        emitAssistantTextBlock(block.text);
      } else if (block.type === 'tool_use' && block.name) {
        const toolUseId = block.id || generateId();
        const toolInput = block.input || {};
        host.rememberToolUse(toolUseId, block.name, toolInput);
        host.emitAsyncWork(parseClaudeAsyncWorkToolUse(block.name, toolUseId, toolInput));

        host.emit('output', {
          id: generateId(),
          timestamp: assistantTimestamp,
          type: 'tool_use',
          content: `Using tool: ${block.name}`,
          metadata: {
            name: block.name,
            id: toolUseId,
            input: toolInput,
          },
        });

        if (block.name === 'AskUserQuestion') {
          host.emitAskUserQuestionInputRequired(
            toolUseId,
            toolInput,
            assistantTimestamp,
            precedingText,
          );
        }
      }
    }
  } else if (typeof assistantMsg.content === 'string') {
    emitAssistantTextBlock(assistantMsg.content);
  }

  if (pendingThinking.length > 0) {
    host.emit('output', {
      id: generateId(),
      timestamp: assistantTimestamp,
      type: 'assistant',
      content: '',
      thinking: pendingThinking,
      thinkingExtracted: true,
    });
  }

  if (assistantMsg.message?.usage) {
    const usage = assistantMsg.message.usage;
    const totalUsedTokens =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.output_tokens || 0);

    const contextWindow = host.lastKnownContextWindow;
    const percentage = (totalUsedTokens / contextWindow) * 100;

    host.hasPerCallUsageThisTurn = true;
    host.lastObservedContextUsage = { used: totalUsedTokens, total: contextWindow };
    host.emit('context', {
      used: totalUsedTokens,
      total: contextWindow,
      percentage: Math.min(percentage, 100),
    });
  }

  host.emit('status', 'busy' as InstanceStatus);
}
