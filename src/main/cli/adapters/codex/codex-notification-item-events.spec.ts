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
    streamingAgentMessages: new Map(),
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

  it('shows an async user-input question without treating it as the final answer', () => {
    const capture = state({ turnId: 'turn-1', lastAgentMessage: 'earlier note', finalAnswerSeen: false });
    const ops = host();
    const questions = [{ title: 'Keep writes blocked?', options: ['Yes', 'No'] }];
    handleItemCompleted(ops, capture, {
      threadId: 'thread-1',
      item: {
        type: 'agentMessage',
        id: 'call_q1',
        text: 'Keep writes blocked?\n- Yes\n- No',
        phase: 'final_answer',
        delivery: 'async',
        questions,
      },
    });
    expect(ops.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex-async-question:call_q1',
      type: 'assistant',
      content: 'Keep writes blocked?\n- Yes\n- No',
      metadata: { asyncUserInput: true, questions, turnId: 'turn-1' },
    }));
    expect(capture.finalAnswerSeen).toBe(false);
    expect(capture.lastAgentMessage).toBe('earlier note');
    expect(ops.scheduleInferredCompletion).not.toHaveBeenCalled();
    expect(ops.reconcileCompletedAgentMessage).not.toHaveBeenCalled();
  });

  it('finalises a streamed async question in its own bubble and drops the stream', () => {
    const capture = state({
      turnId: 'turn-1',
      streamingAgentMessages: new Map([
        ['call_q1', { outputId: 'stream-out-q1', content: 'Keep writes', deltaSeen: true }],
      ]),
    });
    const ops = host();
    handleItemCompleted(ops, capture, {
      threadId: 'thread-1',
      item: { type: 'agentMessage', id: 'call_q1', text: 'Keep writes blocked?', phase: 'final_answer', delivery: 'async' },
    });
    expect(ops.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      id: 'stream-out-q1',
      content: 'Keep writes blocked?',
      metadata: expect.objectContaining({ streaming: false, accumulatedContent: 'Keep writes blocked?' }),
    }));
    expect(capture.streamingAgentMessages.has('call_q1')).toBe(false);
  });

  it('surfaces a subagent async question labelled with the subagent, without ending the turn', () => {
    const capture = state({
      turnId: 'turn-1',
      threadIds: new Set(['thread-1', 'child-1']),
      threadLabels: new Map([['child-1', '/root/reviewer']]),
      finalAnswerSeen: false,
    });
    const ops = host();
    const questions = [{ title: 'Which branch?', options: ['main', 'develop'] }];
    handleItemCompleted(ops, capture, {
      threadId: 'child-1',
      item: { type: 'agentMessage', id: 'call_c1', text: 'Which branch?', phase: 'final_answer', delivery: 'async', questions },
    });
    expect(ops.emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      id: 'codex-async-question:call_c1',
      type: 'assistant',
      content: 'Question from subagent /root/reviewer:\n\nWhich branch?',
      metadata: { asyncUserInput: true, questions, subagentLabel: '/root/reviewer', turnId: 'turn-1' },
    }));
    expect(capture.finalAnswerSeen).toBe(false);
    expect(ops.scheduleInferredCompletion).not.toHaveBeenCalled();
  });
});
