import { describe, expect, it, vi } from 'vitest';
import {
  handleItemCompleted,
  handleItemStarted,
  VERIFICATION_CMD_PATTERN,
  type CodexItemNotificationHost,
} from './codex-notification-item-events';
import type { TurnCaptureState } from './app-server-types';

function state(partial: Partial<TurnCaptureState> = {}): TurnCaptureState {
  return {
    threadId: 'thread-1',
    threadIds: new Set(['thread-1']),
    threadLabels: new Map(),
    threadTurnIds: new Map(),
    activeSubagentTurns: new Set(),
    pendingCollaborations: new Set(),
    commandExecutions: [],
    fileChanges: [],
    messages: [],
    reasoningSummary: [],
    completed: false,
    ...partial,
  } as TurnCaptureState;
}

function host(): CodexItemNotificationHost & {
  emitOutput: ReturnType<typeof vi.fn>;
  scheduleInferredCompletion: ReturnType<typeof vi.fn>;
  reconcileCompletedAgentMessage: ReturnType<typeof vi.fn>;
} {
  return {
    emitOutput: vi.fn(),
    scheduleInferredCompletion: vi.fn(),
    reconcileCompletedAgentMessage: vi.fn((_state, _id, text: string) => text),
  };
}

describe('codex-notification-item-events', () => {
  it('classifies verification commands as verifying', () => {
    expect(VERIFICATION_CMD_PATTERN.test('npm test')).toBe(true);
    expect(VERIFICATION_CMD_PATTERN.test('ls -la')).toBe(false);
  });

  it('emits a verifying tool_use event for a test command', () => {
    const ops = host();
    handleItemStarted(ops, state(), {
      item: { type: 'commandExecution', command: 'npm test', id: 'item-1' },
    });
    expect(ops.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      type: 'tool_use',
      content: expect.stringContaining('npm test'),
      metadata: expect.objectContaining({ phase: 'verifying' }),
    }));
  });

  it('records a completed agent message on the root thread', () => {
    const capture = state();
    const ops = host();
    handleItemCompleted(ops, capture, {
      threadId: 'thread-1',
      item: { type: 'agentMessage', text: 'hello', phase: 'final_answer', id: 'm1' },
    });
    expect(capture.lastAgentMessage).toBe('hello');
    expect(capture.finalAnswerSeen).toBe(true);
    expect(ops.scheduleInferredCompletion).toHaveBeenCalled();
  });
});
