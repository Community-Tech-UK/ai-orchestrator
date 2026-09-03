/**
 * Codex app-server item/started and item/completed handlers.
 *
 * Extracted from `codex-app-server-notification-adapter.ts` so that file
 * stays under the hard LOC cap. The adapter still owns turn completion,
 * token usage, and streamed-message reconciliation; this module only
 * translates item notifications into output events. Behaviour matches the
 * previous switch cases.
 */

import { generateId } from '../../../../shared/utils/id-generator';
import type {
  ThreadItem,
  TurnCaptureState,
  TurnPhase,
} from './app-server-types';
import {
  getCommandAggregatedOutput,
  getCommandExitCode,
  getFileChangeInput,
  getFileChangePath,
  getToolCallInput,
  getToolCallName,
  isCommandExecutionItem,
  isFailedThreadItemStatus,
} from './thread-item-accessors';
import {
  extractReasoningSections,
  mergeReasoningSections,
  shorten,
} from './reasoning';

export const VERIFICATION_CMD_PATTERN = /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i;

export interface CodexItemOutputPayload {
  id: string;
  timestamp: number;
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface CodexItemNotificationHost {
  emitOutput(payload: CodexItemOutputPayload): void;
  scheduleInferredCompletion(state: TurnCaptureState): void;
  reconcileCompletedAgentMessage(
    state: TurnCaptureState,
    itemId: string | undefined,
    text: string,
  ): string;
}

export function toolMetadata(
  item: ThreadItem,
  name: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(item.id ? { id: item.id } : {}), name, ...(input ? { input } : {}), ...metadata };
}

export function handleItemStarted(
  host: CodexItemNotificationHost,
  state: TurnCaptureState,
  params: Record<string, unknown>,
): void {
  const item = params['item'] as ThreadItem | undefined;
  const threadId = params['threadId'] as string | undefined;
  if (!item) return;

  if (item.type === 'collabAgentToolCall') {
    if (!threadId || threadId === state.threadId) {
      if (item.id) {
        state.pendingCollaborations.add(item.id);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      if (receiverThreadId) {
        state.threadIds.add(receiverThreadId);
        if (!state.threadLabels.has(receiverThreadId)) {
          state.threadLabels.set(receiverThreadId, receiverThreadId);
        }
      }
    }
  }

  if (isCommandExecutionItem(item) && item.command) {
    const phase: TurnPhase = VERIFICATION_CMD_PATTERN.test(item.command)
      ? 'verifying'
      : 'running';
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Running command: ${shorten(item.command, 96)}`,
      metadata: toolMetadata(item, 'Bash', { command: item.command }, { streaming: true, phase }),
    });
  } else if (item.type === 'file_change' || item.type === 'fileChange') {
    const path = getFileChangePath(item);
    const input = getFileChangeInput(item);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Editing file: ${path}`,
      metadata: toolMetadata(item, 'Edit', input, {
        streaming: true,
        phase: 'editing' as TurnPhase,
      }),
    });
  } else if (item.type === 'enteredReviewMode') {
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: `Reviewer started: ${item.review || 'code review'}`,
      metadata: { phase: 'reviewing' as TurnPhase },
    });
  } else if (item.type === 'mcpToolCall') {
    const toolName = getToolCallName(item);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Calling ${item.server || 'mcp'}/${toolName}`,
      metadata: toolMetadata(item, toolName, getToolCallInput(item), {
        streaming: true,
        phase: 'investigating' as TurnPhase,
      }),
    });
  } else if (item.type === 'dynamicToolCall') {
    const toolName = getToolCallName(item);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Running tool: ${toolName}`,
      metadata: toolMetadata(item, toolName, getToolCallInput(item), {
        streaming: true,
        phase: 'investigating' as TurnPhase,
      }),
    });
  } else if (item.type === 'collabAgentToolCall') {
    const subagentLabels = (item.receiverThreadIds ?? [])
      .map((tid) => state.threadLabels.get(tid) ?? tid);
    const summary = subagentLabels.length > 0
      ? `Starting subagent ${subagentLabels.join(', ')} via ${item.tool || 'collaboration'}`
      : `Starting collaboration tool: ${item.tool || 'unknown'}`;
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: summary,
      metadata: toolMetadata(item, 'Task', {
        tool: item.tool || 'unknown',
        receiverThreadIds: item.receiverThreadIds ?? [],
        ...(item.prompt ? { prompt: item.prompt } : {}),
      }, {
        streaming: true,
        phase: 'investigating' as TurnPhase,
      }),
    });
  } else if (item.type === 'webSearch') {
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_use',
      content: `Searching: ${shorten(item.query, 96)}`,
      metadata: toolMetadata(item, 'WebSearch', { query: item.query ?? '' }, {
        streaming: true,
        phase: 'investigating' as TurnPhase,
      }),
    });
  }
}

export function handleItemCompleted(
  host: CodexItemNotificationHost,
  state: TurnCaptureState,
  params: Record<string, unknown>,
): void {
  const item = params['item'] as ThreadItem | undefined;
  const threadId = params['threadId'] as string | undefined;
  if (!item) return;

  if (item.type === 'collabAgentToolCall') {
    if (!threadId || threadId === state.threadId) {
      if (item.id) {
        state.pendingCollaborations.delete(item.id);
        host.scheduleInferredCompletion(state);
      }
    }
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
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: summary,
      metadata: toolMetadata(item, 'Task', undefined, { is_error: isFailedThreadItemStatus(item) }),
    });
  }

  if (isCommandExecutionItem(item)) {
    state.commandExecutions.push(item);
    const output = getCommandAggregatedOutput(item);
    const exitCode = getCommandExitCode(item);
    const isError = isFailedThreadItemStatus(item) || (exitCode !== undefined && exitCode !== 0);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: output || (exitCode !== undefined ? `Command exited with code ${exitCode}`
        : isError ? `Command ${item.status}` : 'Command completed'),
      metadata: toolMetadata(item, 'Bash', undefined, {
        command: item.command,
        exitCode,
        status: item.status,
        is_error: isError,
      }),
    });
  }

  if (item.type === 'agent_message' || item.type === 'agentMessage') {
    const text = item.text || item.content
      || (item.message && typeof item.message === 'object' ? item.message.content : undefined)
      || '';
    if (text) {
      const itemPhase = item.phase || (params['phase'] as string | undefined) || null;
      state.messages.push({ lifecycle: 'completed', phase: itemPhase, text });

      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = host.reconcileCompletedAgentMessage(state, item.id, text);
        if (itemPhase === 'final_answer') {
          state.finalAnswerSeen = true;
          host.scheduleInferredCompletion(state);
        }
      }
    }
  }

  if (item.type === 'file_change' || item.type === 'fileChange') {
    state.fileChanges.push(item);
    const path = getFileChangePath(item);
    const input = getFileChangeInput(item);
    const isError = isFailedThreadItemStatus(item);
    const changeType = item.changeType ?? (typeof item['change_type'] === 'string' ? item['change_type'] : undefined);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: isError ? `File change ${item.status}: ${path}` : `File ${changeType || 'modified'}: ${path}`,
      metadata: toolMetadata(item, 'Edit', input, {
        path,
        changeType,
        status: item.status,
        is_error: isError,
      }),
    });
  }

  if (item.type === 'reasoning') {
    const nextSections = extractReasoningSections(item.summary ?? item.summaryText);
    if (nextSections.length > 0) {
      state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    }
  }

  if (item.type === 'exitedReviewMode') {
    state.reviewText = item.review ?? '';
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: item.review || 'Review completed',
      metadata: { phase: 'reviewing' as TurnPhase },
    });
  }

  if (item.type === 'mcpToolCall') {
    const toolName = getToolCallName(item);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: `Tool ${item.server || 'mcp'}/${toolName} ${item.status || 'completed'}`,
      metadata: toolMetadata(item, toolName, getToolCallInput(item), {
        is_error: isFailedThreadItemStatus(item),
        phase: 'investigating',
      }),
    });
  }

  if (item.type === 'dynamicToolCall') {
    const toolName = getToolCallName(item);
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: `Tool ${toolName} ${item.status || 'completed'}`,
      metadata: toolMetadata(item, toolName, getToolCallInput(item), {
        is_error: isFailedThreadItemStatus(item),
        phase: 'investigating',
      }),
    });
  }

  if (item.type === 'webSearch') {
    host.emitOutput({
      id: generateId(),
      timestamp: Date.now(),
      type: 'tool_result',
      content: `Search completed: ${shorten(item.query, 96)}`,
      metadata: toolMetadata(item, 'WebSearch', undefined, {
        is_error: false,
        phase: 'investigating',
      }),
    });
  }
}
