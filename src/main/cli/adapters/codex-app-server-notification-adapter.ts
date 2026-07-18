import { CodexAppServerAdapter } from './codex-app-server-adapter';
import { generateId } from '../../../shared/utils/id-generator';
import { extractThinkingContent } from '../../../shared/utils/thinking-extractor';
import { getLogger } from '../../logging/logger';
import type {
  AppServerNotification,
  ThreadItem,
  TurnCaptureState,
  TurnPhase,
} from './codex/app-server-types';
import {
  getCommandAggregatedOutput,
  getCommandExitCode,
  getFileChangePath,
  getToolCallInput,
  getToolCallName,
  isCommandExecutionItem,
} from './codex/thread-item-accessors';
import {
  extractCodexAppServerError,
  formatCodexAppServerError,
} from './codex/app-server-errors';
import {
  extractReasoningSections,
  mergeReasoningSections,
  shorten,
} from './codex/reasoning';

const logger = getLogger('CodexCliAdapter');
const INFERRED_COMPLETION_MS = 250;
const VERIFICATION_CMD_PATTERN = /\\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\\b/i;

/** App-server notification routing and streamed-message reconciliation. */
export abstract class CodexAppServerNotificationAdapter extends CodexAppServerAdapter {
  protected handleTurnNotification(state: TurnCaptureState, notification: AppServerNotification): void {
    // Drop notifications that arrive after the turn has already completed.
    // This prevents orphaned output events from violating the event ordering
    // contract (all output must arrive before 'complete').
    if (state.completed) {
      return;
    }

    this.recordContextPressureNotification(state, notification);

    const { method, params } = notification;

    // Record native activity from structured events
    if (this.activityDetector) {
      if (method === 'item/started' || method === 'item/completed' || method === 'turn/started') {
        this.activityDetector.recordActivityEntry({
          ts: Date.now(),
          state: 'active',
          source: 'native',
          provider: 'openai',
        }).catch((error: unknown) => {
          logger.debug('Failed to record Codex native activity', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    }

    switch (method) {
      case 'thread/started': {
        // Handle both flat (params.threadId) and nested (params.thread.id) formats
        const threadObj = params['thread'] as Record<string, unknown> | undefined;
        const tId = (threadObj?.['id'] as string) || params['threadId'] as string | undefined;
        if (tId) {
          state.threadIds.add(tId);
          // Extract label from multiple sources (matches codex-plugin-cc)
          const label = (threadObj?.['name'] as string)
            || (params['name'] as string)
            || (threadObj?.['agentNickname'] as string)
            || (threadObj?.['agentRole'] as string)
            || (params['label'] as string)
            || tId;
          state.threadLabels.set(tId, label);
        }
        break;
      }

      case 'thread/name/updated': {
        const tId = params['threadId'] as string | undefined;
        const name = (params['threadName'] as string) || (params['name'] as string) || undefined;
        if (tId && name) {
          state.threadLabels.set(tId, name);
        }
        break;
      }

      case 'turn/started': {
        const turnId = params['turn'] && typeof params['turn'] === 'object'
          ? (params['turn'] as Record<string, unknown>)['id'] as string | undefined
          : undefined;
        const tId = params['threadId'] as string | undefined;
        if (turnId && tId) {
          state.threadTurnIds.set(tId, turnId);
          // Track subagent turns
          if (tId !== state.threadId) {
            state.activeSubagentTurns.add(turnId);
          }
        }
        break;
      }

      case 'item/started': {
        const item = params['item'] as ThreadItem | undefined;
        const threadId = params['threadId'] as string | undefined;
        if (!item) break;

        // Track collaboration lifecycle (started phase)
        if (item.type === 'collabAgentToolCall') {
          if (!threadId || threadId === state.threadId) {
            if (item.id) {
              state.pendingCollaborations.add(item.id);
            }
          }
          // Auto-register receiver threads for subagent tracking
          for (const receiverThreadId of item.receiverThreadIds ?? []) {
            if (receiverThreadId) {
              state.threadIds.add(receiverThreadId);
              if (!state.threadLabels.has(receiverThreadId)) {
                state.threadLabels.set(receiverThreadId, receiverThreadId);
              }
            }
          }
        }

        // Emit real-time tool_use events for various item types
        if (isCommandExecutionItem(item) && item.command) {
          const phase: TurnPhase = VERIFICATION_CMD_PATTERN.test(item.command)
            ? 'verifying'
            : 'running';
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running command: ${shorten(item.command, 96)}`,
            metadata: { name: 'Bash', streaming: true, phase },
          });
        } else if (item.type === 'file_change' || item.type === 'fileChange') {
          const path = getFileChangePath(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Editing file: ${path}`,
            metadata: { name: 'Edit', streaming: true, phase: 'editing' as TurnPhase },
          });
        } else if (item.type === 'enteredReviewMode') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Reviewer started: ${item.review || 'code review'}`,
            metadata: { name: 'other', streaming: true, phase: 'reviewing' as TurnPhase },
          });
        } else if (item.type === 'mcpToolCall') {
          const toolName = getToolCallName(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Calling ${item.server || 'mcp'}/${toolName}`,
            metadata: { name: toolName, input: getToolCallInput(item), streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'dynamicToolCall') {
          const toolName = getToolCallName(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Running tool: ${toolName}`,
            metadata: { name: toolName, input: getToolCallInput(item), streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'collabAgentToolCall') {
          const subagentLabels = (item.receiverThreadIds ?? [])
            .map((tid) => state.threadLabels.get(tid) ?? tid);
          const summary = subagentLabels.length > 0
            ? `Starting subagent ${subagentLabels.join(', ')} via ${item.tool || 'collaboration'}`
            : `Starting collaboration tool: ${item.tool || 'unknown'}`;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: summary,
            metadata: { name: 'Task', streaming: true, phase: 'investigating' as TurnPhase },
          });
        } else if (item.type === 'webSearch') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_use',
            content: `Searching: ${shorten(item.query, 96)}`,
            metadata: { name: 'WebSearch', streaming: true, phase: 'investigating' as TurnPhase },
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params['item'] as ThreadItem | undefined;
        const threadId = params['threadId'] as string | undefined;
        if (!item) break;

        // ── Collaboration lifecycle (completed phase) ──
        if (item.type === 'collabAgentToolCall') {
          if (!threadId || threadId === state.threadId) {
            if (item.id) {
              state.pendingCollaborations.delete(item.id);
              this.scheduleInferredCompletion(state);
            }
          }
          // Auto-register receiver threads even on completion
          for (const receiverThreadId of item.receiverThreadIds ?? []) {
            if (receiverThreadId) {
              state.threadIds.add(receiverThreadId);
            }
          }
          const subagentLabels = (item.receiverThreadIds ?? [])
            .map((tid) => state.threadLabels.get(tid) ?? tid);
          const summary = subagentLabels.length > 0
            ? `Subagent ${subagentLabels.join(', ')} ${item.status || 'completed'}`
            : `Collaboration tool ${item.tool || 'unknown'} ${item.status || 'completed'}`;
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: summary,
            metadata: { is_error: false },
          });
        }

        // ── Command execution ──
        if (isCommandExecutionItem(item)) {
          state.commandExecutions.push(item);
          const output = getCommandAggregatedOutput(item);
          if (output) {
            const exitCode = getCommandExitCode(item);
            this.emit('output', {
              id: generateId(),
              timestamp: Date.now(),
              type: 'tool_result',
              content: output,
              metadata: {
                command: item.command,
                exitCode,
                is_error: exitCode !== undefined && exitCode !== 0,
              },
            });
          }
        }

        // ── Agent message ──
        // Handle both 'agent_message' (our convention) and 'agentMessage' (codex protocol)
        if (item.type === 'agent_message' || item.type === 'agentMessage') {
          const text = item.text || item.content
            || (item.message && typeof item.message === 'object' ? item.message.content : undefined)
            || '';
          if (text) {
            const itemPhase = item.phase || (params['phase'] as string | undefined) || null;
            state.messages.push({ lifecycle: 'completed', phase: itemPhase, text });

            // Only update lastAgentMessage for root thread messages
            if (!threadId || threadId === state.threadId) {
              state.lastAgentMessage = this.reconcileCompletedAgentMessage(state, item.id, text);
              if (itemPhase === 'final_answer') {
                state.finalAnswerSeen = true;
                this.scheduleInferredCompletion(state);
              }
            }
          }
        }

        // ── File change ──
        if (item.type === 'file_change' || item.type === 'fileChange') {
          state.fileChanges.push(item);
          const path = getFileChangePath(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `File ${item.changeType || 'modified'}: ${path}`,
            metadata: { path, changeType: item.changeType, is_error: false },
          });
        }

        // ── Reasoning (with deduplication) ──
        if (item.type === 'reasoning') {
          // Extract from heterogeneous summary field (string, array, or nested object)
          const nextSections = extractReasoningSections(item.summary ?? item.summaryText);
          if (nextSections.length > 0) {
            state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
          }
        }

        // ── Review mode exited ──
        if (item.type === 'exitedReviewMode') {
          state.reviewText = item.review ?? '';
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: item.review || 'Review completed',
            metadata: { is_error: false, phase: 'reviewing' },
          });
        }

        // ── MCP tool call completed ──
        if (item.type === 'mcpToolCall') {
          const toolName = getToolCallName(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Tool ${item.server || 'mcp'}/${toolName} ${item.status || 'completed'}`,
            metadata: { name: toolName, input: getToolCallInput(item), is_error: false, phase: 'investigating' },
          });
        }

        // ── Dynamic tool call completed ──
        if (item.type === 'dynamicToolCall') {
          const toolName = getToolCallName(item);
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Tool ${toolName} ${item.status || 'completed'}`,
            metadata: { name: toolName, input: getToolCallInput(item), is_error: false, phase: 'investigating' },
          });
        }

        // ── Web search completed ──
        if (item.type === 'webSearch') {
          this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'tool_result',
            content: `Search completed: ${shorten(item.query, 96)}`,
            metadata: { is_error: false, phase: 'investigating' },
          });
        }

        break;
      }

      case 'turn/completed': {
        const turn = params['turn'] as TurnCaptureState['finalTurn'] | undefined;
        const tId = params['threadId'] as string | undefined;

        // If this is a subagent turn completing, just remove from tracking
        if (tId && tId !== state.threadId) {
          const turnId = turn?.id;
          if (turnId) {
            state.activeSubagentTurns.delete(turnId);
          }
          // Check if we should infer completion
          this.scheduleInferredCompletion(state);
          break;
        }

        // Root thread turn completed
        this.completeTurn(state, turn || null);
        break;
      }

      case 'thread/tokenUsage/updated': {
        // Codex app-server provides accurate per-turn and cumulative token data.
        // Structure: { tokenUsage: { total: {...}, last: {...}, modelContextWindow: N } }
        // Field names may be camelCase or snake_case depending on Codex version.
        const tokenUsage = (params['tokenUsage'] ?? params['token_usage']) as Record<string, unknown> | undefined;
        if (!tokenUsage) break;

        const last = (tokenUsage['last'] ?? tokenUsage['last_token_usage']) as Record<string, unknown> | undefined;
        const total = (tokenUsage['total'] ?? tokenUsage['total_token_usage']) as Record<string, unknown> | undefined;

        // last.totalTokens = actual context window occupancy for the most recent API call.
        // Guard against NaN from malformed fields (empty strings, objects, etc.).
        const lastTotal = Number(last?.['totalTokens'] ?? last?.['total_tokens'] ?? 0) || 0;
        const cumulativeTotal = Number(total?.['totalTokens'] ?? total?.['total_tokens'] ?? 0) || 0;

        // Use model_context_window from Codex when available (authoritative source)
        // Persist Codex-reported context window for future resolveContextWindow() calls
        const codexContextWindow = Number(tokenUsage['modelContextWindow'] ?? tokenUsage['model_context_window'] ?? 0) || 0;
        if (codexContextWindow > 0) {
          this.codexReportedContextWindow = codexContextWindow;
        }
        const contextWindow = codexContextWindow > 0 ? codexContextWindow : this.resolveContextWindow();

        // Prefer last.totalTokens (actual context-window occupancy for the most
        // recent API call). Do NOT fall back to cumulativeTotal — that's lifetime
        // spend, not occupancy, and would always inflate the context bar.
        const hasAccurateOccupancy = lastTotal > 0;
        const used = hasAccurateOccupancy ? lastTotal : this.lastTurnTokens;
        if (hasAccurateOccupancy) {
          this.lastTurnTokens = lastTotal;
        }
        if (cumulativeTotal > 0) {
          this.cumulativeTokensUsed = cumulativeTotal;
        }
        this.hasTokenUsageNotification = true;

        this.emit('context', {
          used,
          total: contextWindow,
          percentage: Math.min((used / contextWindow) * 100, 100),
          cumulativeTokens: this.cumulativeTokensUsed,
          costEstimate: this.cumulativeCostUsd,
          // If we don't have per-call occupancy AND no prior occupancy, flag it
          ...(!hasAccurateOccupancy && used === 0 ? { isEstimated: true } : {}),
        });
        if (cumulativeTotal > 0) {
          this.contextCostController.observe(cumulativeTotal, contextWindow);
        }
        break;
      }

      case 'error': {
        const errorDetails = extractCodexAppServerError(params);
        // Include codex_error_info in the error message so upstream overflow detection
        // can match it (e.g., "ContextWindowExceeded" matches /context.?window.?exceeded/i).
        const fullMessage = formatCodexAppServerError(errorDetails);
        if (errorDetails.willRetry === true) {
          logger.warn('Retrying error notification from app-server', {
            additionalDetails: errorDetails.additionalDetails,
            codexErrorInfo: errorDetails.codexErrorInfo,
            error: errorDetails.message,
            willRetry: true,
          });
          break;
        }
        state.error = new Error(fullMessage);
        logger.warn('Error notification from app-server', {
          additionalDetails: errorDetails.additionalDetails,
          codexErrorInfo: errorDetails.codexErrorInfo,
          error: errorDetails.message,
          willRetry: errorDetails.willRetry,
        });
        break;
      }

      case 'thread/compacted': {
        this.handleObservedThreadCompaction(state.threadId);
        break;
      }

      // ── Streaming deltas ──
      // Codex app-server emits fine-grained deltas during reasoning and
      // agent message generation. These notifications prove the turn is
      // alive even when no tool_use/tool_result output events are emitted.
      // Without a heartbeat here, the stuck-process detector fires during
      // long reasoning phases (>120 s with no visible output).
      case 'item/agentMessage/delta': {
        this.handleAgentMessageDelta(state, params);
        break;
      }
      case 'item/reasoning/summaryPartAdded':
      case 'item/reasoning/summaryTextDelta': {
        this.emit('heartbeat');
        break;
      }

      default:
        break;
    }
  }

  private recordContextPressureNotification(state: TurnCaptureState, notification: AppServerNotification): void {
    const collector = this.contextDiagnostics;
    if (!collector) return;

    const { method, params } = notification;
    if (method === 'turn/started' && params['threadId'] === state.threadId) {
      collector.startTurn(this.lastTurnTokens > 0 ? this.lastTurnTokens : null);
    } else if (method === 'item/completed' && params['item']) {
      const threadId = params['threadId'];
      collector.recordItemCompleted(params['item'], !threadId || threadId === state.threadId);
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = params['tokenUsage'] ?? params['token_usage'];
      if (usage) collector.recordTokenUsage(usage);
    } else if (method === 'thread/compacted') {
      collector.recordCompactionObserved();
    }
  }

  private handleAgentMessageDelta(state: TurnCaptureState, params: Record<string, unknown>): void {
    const threadId = params['threadId'] as string | undefined;
    if (threadId && threadId !== state.threadId) {
      return;
    }

    const delta = typeof params['delta'] === 'string' ? params['delta'] : '';
    if (!delta) {
      return;
    }

    const itemId = typeof params['itemId'] === 'string' ? params['itemId'] : null;
    this.emitStreamingAgentDelta(state, itemId, delta);
  }

  private emitStreamingAgentDelta(state: TurnCaptureState, itemId: string | null, delta: string): void {
    const stream = this.getStreamingAgentMessage(state, itemId);
    this.emitStreamingAgentDeltaForStream(state, stream, delta);
  }

  private emitStreamingAgentDeltaForStream(
    state: TurnCaptureState,
    stream: { outputId: string; content: string; deltaSeen: boolean },
    delta: string,
  ): void {
    stream.content += delta;
    stream.deltaSeen = true;

    const extracted = extractThinkingContent(stream.content);
    const accumulatedContent = extracted.hasThinking ? extracted.response : stream.content;
    this.emit('output', {
      id: stream.outputId,
      timestamp: Date.now(),
      type: 'assistant',
      content: delta,
      metadata: {
        streaming: true,
        accumulatedContent,
        thinkingExtracted: true,
        phase: 'finalizing' as TurnPhase,
        ...(state.turnId ? { turnId: state.turnId } : {}),
      },
      thinking: extracted.thinking.length > 0 ? extracted.thinking : undefined,
      thinkingExtracted: true,
    });
  }

  private getStreamingAgentMessage(
    state: TurnCaptureState,
    itemId: string | null,
  ): { outputId: string; content: string; deltaSeen: boolean } {
    const key = this.getAgentMessageStreamKey(state, itemId);
    let stream = state.streamingAgentMessages.get(key);
    if (!stream) {
      const turnId = state.turnId ?? this.appServerRuntime.getCurrentTurnId() ?? 'turn';
      stream = {
        outputId: `codex-agent-message:${state.threadId}:${turnId}:${key}`,
        content: '',
        deltaSeen: false,
      };
      state.streamingAgentMessages.set(key, stream);
    }
    return stream;
  }

  private findStreamingAgentMessage(
    state: TurnCaptureState,
    itemId: string | null,
  ): { outputId: string; content: string; deltaSeen: boolean } | null {
    if (itemId) {
      const exact = state.streamingAgentMessages.get(itemId);
      if (exact) {
        return exact;
      }
      if (state.streamingAgentMessages.size === 1) {
        return Array.from(state.streamingAgentMessages.values())[0] ?? null;
      }
      return null;
    }
    if (state.streamingAgentMessages.size === 1) {
      return Array.from(state.streamingAgentMessages.values())[0] ?? null;
    }
    return state.streamingAgentMessages.get(this.getAgentMessageStreamKey(state, null)) ?? null;
  }

  private getAgentMessageStreamKey(state: TurnCaptureState, itemId: string | null): string {
    return itemId || state.turnId || this.appServerRuntime.getCurrentTurnId() || 'root-agent-message';
  }

  private reconcileCompletedAgentMessage(
    state: TurnCaptureState,
    itemId: string | undefined,
    text: string,
  ): string {
    const stream = this.findStreamingAgentMessage(state, itemId ?? null);
    if (!stream?.deltaSeen) {
      return text;
    }

    if (text === stream.content || stream.content.startsWith(text)) {
      state.finalAgentOutputId = stream.outputId;
      return stream.content;
    }

    if (text.startsWith(stream.content)) {
      const suffix = text.slice(stream.content.length);
      if (suffix) {
        this.emitStreamingAgentDeltaForStream(state, stream, suffix);
      }
      state.finalAgentOutputId = stream.outputId;
      return text;
    }

    logger.warn('Codex assistant final did not match streamed content; using final message as canonical', {
      itemId,
      streamedLength: stream.content.length,
      finalLength: text.length,
      streamedTail: stream.content.slice(-120),
      finalTail: text.slice(-120),
    });
    stream.content = text;
    state.finalAgentOutputId = stream.outputId;
    return text;
  }

  private getAgentMessageText(item: ThreadItem): string {
    return item.text || item.content
      || (item.message && typeof item.message === 'object' ? item.message.content : undefined)
      || '';
  }

  private reconcileCompletedTurnAgentMessages(
    state: TurnCaptureState,
    turn: TurnCaptureState['finalTurn'],
  ): void {
    if (!turn?.items || turn.items.length === 0) {
      return;
    }

    for (const item of turn.items) {
      if (item.type !== 'agent_message' && item.type !== 'agentMessage') {
        continue;
      }

      const text = this.getAgentMessageText(item);
      if (!text) {
        continue;
      }

      const itemPhase = item.phase || null;
      const alreadyRecorded = state.messages.some((message) =>
        message.lifecycle === 'completed' &&
        message.phase === itemPhase &&
        message.text === text
      );
      if (!alreadyRecorded) {
        state.messages.push({ lifecycle: 'completed', phase: itemPhase, text });
      }

      state.lastAgentMessage = this.reconcileCompletedAgentMessage(state, item.id, text);
      if (itemPhase === 'final_answer') {
        state.finalAnswerSeen = true;
      }
    }
  }

  /**
   * Schedules inferred completion for cases where `turn/completed` may not fire.
   * This handles multi-agent scenarios where the root turn finishes after
   * a final_answer + all subagent turns drain.
   */
  private scheduleInferredCompletion(state: TurnCaptureState): void {
    if (state.completed || !state.finalAnswerSeen) return;
    if (state.activeSubagentTurns.size > 0 || state.pendingCollaborations.size > 0) return;

    // Clear any existing timer
    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
    }

    state.completionTimer = setTimeout(() => {
      if (!state.completed) {
        logger.debug('Inferred turn completion after final answer + subagent drain');
        this.completeTurn(state, null);
      }
    }, INFERRED_COMPLETION_MS);
    // Don't let this timer prevent clean process exit
    if (state.completionTimer && typeof state.completionTimer === 'object' && 'unref' in state.completionTimer) {
      (state.completionTimer as NodeJS.Timeout).unref();
    }
  }

  /**
   * Marks the turn as completed and resolves the completion promise.
   */
  protected completeTurn(state: TurnCaptureState, turn: TurnCaptureState['finalTurn']): void {
    if (state.completed) return;
    const completionStatus = turn?.status === 'completed' || turn?.status === 'interrupted' || turn?.status === 'failed' ? turn.status : 'unknown';
    this.contextDiagnostics?.completeTurn(completionStatus);
    this.reconcileCompletedTurnAgentMessages(state, turn);
    state.completed = true;
    state.finalTurn = turn;

    if (state.completionTimer) {
      clearTimeout(state.completionTimer);
      state.completionTimer = null;
    }

    state.resolveCompletion(state);
  }
}
