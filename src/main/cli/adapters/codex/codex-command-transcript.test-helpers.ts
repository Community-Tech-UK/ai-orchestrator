/**
 * Codex command transcripts built by the real item handlers.
 *
 * Readers of a Codex transcript (the correction miner, the continuity projection)
 * depend on the exact metadata a run writes: the item id under plain `id` with no
 * `tool_use_id`, and `is_error` / `exitCode` / `isCheck` / `checkFailed` on a
 * result. A hand-copied shape drifts from the producer without any test noticing,
 * so specs that need Codex-shaped messages call this instead of writing them out.
 */

import type { OutputMessage } from '../../../../shared/types/instance.types';
import type { TurnCaptureState } from './app-server-types';
import {
  handleItemCompleted,
  handleItemStarted,
  type CodexItemNotificationHost,
} from './codex-notification-item-events';

export interface CodexCommandStep {
  id: string;
  command: string;
  /** The command's combined output. */
  output?: string;
  /** The exit status; leave it out (or null) for a command that never reported one. */
  exitCode?: number | null;
  /** Codex's own status for the item; defaults to `completed` for exit 0 and `failed` otherwise. */
  status?: string;
}

const THREAD_ID = 'thread-1';

function captureState(): TurnCaptureState {
  return {
    threadId: THREAD_ID,
    threadIds: new Set([THREAD_ID]),
    threadLabels: new Map(),
    threadTurnIds: new Map(),
    activeSubagentTurns: new Set(),
    pendingCollaborations: new Set(),
    commandExecutions: [],
    fileChanges: [],
    messages: [],
    reasoningSummary: [],
    streamingAgentMessages: new Map(),
    completed: false,
  } as unknown as TurnCaptureState;
}

/** The `tool_use` and `tool_result` messages Codex writes for these commands, in order. */
export function codexCommandTranscript(steps: readonly CodexCommandStep[]): OutputMessage[] {
  const messages: OutputMessage[] = [];
  const host: CodexItemNotificationHost = {
    emitOutput: (payload) => {
      messages.push({
        id: payload.id,
        timestamp: payload.timestamp,
        type: payload.type as OutputMessage['type'],
        content: payload.content,
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
      });
    },
    scheduleInferredCompletion: () => undefined,
    reconcileCompletedAgentMessage: (_state, _id, text) => text,
  };
  const state = captureState();
  for (const step of steps) {
    handleItemStarted(host, state, {
      threadId: THREAD_ID,
      item: { type: 'commandExecution', id: step.id, command: step.command },
    });
    handleItemCompleted(host, state, {
      threadId: THREAD_ID,
      item: {
        type: 'commandExecution',
        id: step.id,
        command: step.command,
        aggregatedOutput: step.output ?? '',
        exitCode: step.exitCode ?? null,
        status: step.status ?? (step.exitCode === 0 ? 'completed' : 'failed'),
      },
    });
  }
  return messages;
}
