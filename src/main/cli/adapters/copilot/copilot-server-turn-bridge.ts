/**
 * WS14 — turns mapped Copilot server effects into adapter emissions.
 *
 * Mirrors the exec path's event semantics (same OutputMessage shapes the
 * renderer already understands) but with server-mode upgrades: REAL context
 * occupancy from `session.usage_info`, and turn lifecycle driven by
 * `session.idle` instead of process exit.
 *
 * Kept separate from the adapter so the streaming/accumulation logic is
 * testable with a fake host and so the adapter file stays within its LOC
 * ceiling.
 */

import { generateId } from '../../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../../shared/utils/thinking-extractor';
import { isSessionNotFoundText } from '../resume-error-classifier';
import type {
  ContextUsage,
  InstanceStatus,
  OutputMessage,
  ThinkingContent,
} from '../../../../shared/types/instance.types';
import type { MappedCopilotServerEffect } from './copilot-server-event-mapper';

export interface CopilotServerBridgeHost {
  emitOutput(message: OutputMessage): void;
  emitStatus(status: InstanceStatus): void;
  emitContext(usage: ContextUsage): void;
  emitError(error: Error): void;
  /** Resume-proof hook: a session-not-found style error arrived (B2). */
  noteSessionNotFound(): void;
}

export class CopilotServerTurnBridge {
  private streamingMessageId: string | null = null;
  private streamingContent = '';
  private reasoning: ThinkingContent[] = [];
  private readonly activeToolCalls = new Map<string, { name: string; input?: Record<string, unknown> }>();

  constructor(private readonly host: CopilotServerBridgeHost) {}

  /** Reset per-turn accumulation. Call when a new user turn is submitted. */
  resetTurn(): void {
    this.streamingMessageId = null;
    this.streamingContent = '';
    this.reasoning = [];
    this.activeToolCalls.clear();
  }

  handleEffect(effect: MappedCopilotServerEffect): void {
    switch (effect.kind) {
      case 'assistant-delta': {
        if (this.streamingMessageId && this.streamingMessageId !== effect.messageId) {
          // New assistant message inside the same turn — start fresh accumulation.
          this.streamingContent = '';
        }
        this.streamingMessageId = effect.messageId;
        this.streamingContent += effect.delta;
        const extracted = extractThinkingContent(this.streamingContent);
        this.host.emitOutput({
          id: effect.messageId,
          timestamp: Date.now(),
          type: 'assistant',
          content: this.streamingContent,
          metadata: { streaming: true, accumulatedContent: extracted.response },
          thinking: this.reasoning.length > 0 ? [...this.reasoning] : undefined,
          thinkingExtracted: true,
        });
        break;
      }

      case 'assistant-message': {
        // The server's final message is authoritative — it replaces whatever
        // was accumulated (deltas can be coalesced or elided by the runtime).
        this.streamingMessageId = effect.messageId;
        this.streamingContent = effect.content;
        const extracted = extractThinkingContent(effect.content);
        const thinking: ThinkingContent[] = [
          ...this.reasoning,
          ...extracted.thinking.map((t) => ({ ...t, timestamp: Date.now() })),
        ];
        this.host.emitOutput({
          id: effect.messageId,
          timestamp: Date.now(),
          type: 'assistant',
          content: extracted.response,
          thinking: thinking.length > 0 ? thinking : undefined,
          thinkingExtracted: true,
        });
        break;
      }

      case 'reasoning': {
        this.reasoning.push({
          id: generateId(),
          content: effect.content,
          format: 'sdk',
          timestamp: Date.now(),
        });
        break;
      }

      case 'tool-start': {
        if (effect.toolCallId) {
          this.activeToolCalls.set(effect.toolCallId, { name: effect.toolName, input: effect.args });
        }
        this.host.emitOutput({
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_use',
          content: `Using tool: ${effect.toolName}`,
          metadata: {
            id: effect.toolCallId,
            name: effect.toolName,
            input: effect.args,
            tool_use_id: effect.toolCallId,
            toolName: effect.toolName,
            toolCallId: effect.toolCallId,
          },
        });
        break;
      }

      case 'tool-complete': {
        const context = effect.toolCallId ? this.activeToolCalls.get(effect.toolCallId) : undefined;
        if (effect.toolCallId) this.activeToolCalls.delete(effect.toolCallId);
        const toolName = context?.name ?? effect.toolName ?? 'unknown';
        this.host.emitOutput({
          id: generateId(),
          timestamp: Date.now(),
          type: 'tool_result',
          content: effect.success
            ? `Tool ${toolName} completed`
            : `Tool ${toolName} failed${effect.errorMessage ? `: ${effect.errorMessage}` : ''}`,
          metadata: {
            name: toolName,
            input: context?.input,
            tool_use_id: effect.toolCallId,
            is_error: !effect.success,
            toolName,
            toolCallId: effect.toolCallId,
            success: effect.success,
            output: effect.result,
          },
        });
        break;
      }

      case 'context': {
        this.host.emitContext({
          used: effect.used,
          total: effect.total,
          percentage: effect.total > 0 ? Math.min((effect.used / effect.total) * 100, 100) : 0,
          source: 'provider-usage',
        });
        break;
      }

      case 'session-error': {
        if (isSessionNotFoundText(effect.message)) {
          this.host.noteSessionNotFound();
        }
        this.host.emitOutput({
          id: generateId(),
          timestamp: Date.now(),
          type: 'error',
          content: effect.message,
          metadata: {
            source: 'copilot-session-error',
            errorType: effect.errorType,
            errorCode: effect.errorCode,
          },
        });
        this.host.emitError(new Error(effect.message));
        break;
      }

      case 'turn-start':
        this.host.emitStatus('busy');
        break;

      case 'idle':
        this.host.emitStatus('idle');
        break;

      case 'turn-end':
      case 'ignored':
        break;
    }
  }
}
