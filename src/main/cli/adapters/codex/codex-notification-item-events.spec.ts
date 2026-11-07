import { describe, expect, it, vi, type Mock } from 'vitest';
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
  emitOutput: Mock<CodexItemNotificationHost['emitOutput']>;
  scheduleInferredCompletion: Mock<CodexItemNotificationHost['scheduleInferredCompletion']>;
  reconcileCompletedAgentMessage: Mock<CodexItemNotificationHost['reconcileCompletedAgentMessage']>;
} {
  return {
    emitOutput: vi.fn(),
    scheduleInferredCompletion: vi.fn(),
    reconcileCompletedAgentMessage: vi.fn((_state, _id, text: string) => text),
  };
}

describe('codex-notification-item-events', () => {
  it('emits a bounded headline while retaining the complete reasoning summary', () => {
    const emitReasoningHeadline = vi.fn();
    const capture = state();
    handleItemCompleted({ ...host(), emitReasoningHeadline }, capture, {
      item: { type: 'reasoning', summary: [{ text: '**Checking migration order** More detail.' }] },
    });
    expect(emitReasoningHeadline).toHaveBeenCalledWith('Checking migration order');
    expect(capture.reasoningSummary).toEqual(['**Checking migration order** More detail.']);
  });
  it('does not emit an empty reasoning headline', () => {
    const emitReasoningHeadline = vi.fn();
    handleItemCompleted({ ...host(), emitReasoningHeadline }, state(), { item: { type: 'reasoning', summary: [] } });
    expect(emitReasoningHeadline).not.toHaveBeenCalled();
  });
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

  describe('command results (U1 step 5: a non-zero exit is not automatically an error)', () => {
    function completedCommand(item: Record<string, unknown>): { content: string; metadata?: Record<string, unknown> } {
      const ops = host();
      handleItemCompleted(ops, state(), {
        threadId: 'thread-1',
        item: { type: 'commandExecution', id: 'cmd-1', ...item },
      });
      expect(ops.emitOutput).toHaveBeenCalledTimes(1);
      return ops.emitOutput.mock.calls[0][0];
    }

    it('records a clean exit as a success', () => {
      const result = completedCommand({ command: 'ls', aggregatedOutput: 'a\nb', exitCode: 0, status: 'completed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 0, isCheck: false, checkFailed: false });
      expect(result.content).toBe('a\nb');
    });

    it('keeps the exit status but not an error flag when an ordinary command exits non-zero', () => {
      const result = completedCommand({ command: 'rg missing src', aggregatedOutput: '', exitCode: 1, status: 'failed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1, status: 'failed', isCheck: false, checkFailed: false });
      expect(result.content).toBe('Exited with status 1');
    });

    it('keeps the command output when an ordinary command exits non-zero', () => {
      const result = completedCommand({ command: 'git diff --exit-code', aggregatedOutput: '- old\n+ new', exitCode: 1, status: 'completed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1 });
      expect(result.content).toBe('- old\n+ new');
    });

    it('marks a failing test run as a failed check, still not a transport error', () => {
      const result = completedCommand({ command: 'npm test', aggregatedOutput: '1 failed', exitCode: 1, status: 'failed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: true });
    });

    it('does not mark a passing test run as failed', () => {
      const result = completedCommand({ command: 'npm test', aggregatedOutput: 'ok', exitCode: 0, status: 'completed' });
      expect(result.metadata).toMatchObject({ is_error: false, isCheck: true, checkFailed: false });
    });

    it('honours an explicit isCheck from the caller over the command text', () => {
      const result = completedCommand({ command: './ci.sh', exitCode: 3, status: 'failed', isCheck: true });
      expect(result.metadata).toMatchObject({ is_error: false, isCheck: true, checkFailed: true });
      const notACheck = completedCommand({ command: 'npm test', exitCode: 3, status: 'failed', isCheck: false });
      expect(notACheck.metadata).toMatchObject({ isCheck: false, checkFailed: false });
    });

    it('still calls a declined command an error, because it never ran', () => {
      const result = completedCommand({ command: 'npm test', status: 'declined', aggregatedOutput: null, exitCode: null });
      expect(result.metadata).toMatchObject({ is_error: true, status: 'declined', isCheck: true, checkFailed: true });
      expect(result.metadata?.['exitCode']).toBeUndefined();
      expect(result.content).toBe('Command declined');
    });

    it('calls a command that failed without ever reporting an exit status an error', () => {
      const result = completedCommand({ command: 'ls', status: 'failed', aggregatedOutput: null, exitCode: null });
      expect(result.metadata).toMatchObject({ is_error: true });
      expect(result.content).toBe('Command failed');
    });

    // A command can exit with any status on purpose, so the number alone proves nothing.
    it.each([124, 126, 127, 137, 143])('keeps a voluntary exit %i neutral: the command ran and chose it', (exitCode) => {
      const result = completedCommand({ command: './deploy.sh', aggregatedOutput: 'chose to stop', exitCode, status: 'failed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode, isCheck: false, checkFailed: false });
    });

    it('calls a command an error only when the item itself reports a timeout or a signal', () => {
      const timedOut = completedCommand({ command: './deploy.sh', exitCode: 124, status: 'failed', timedOut: true });
      expect(timedOut.metadata).toMatchObject({ is_error: true, exitCode: 124 });
      const snake = completedCommand({ command: './deploy.sh', exit_code: 1, status: 'failed', timed_out: true });
      expect(snake.metadata).toMatchObject({ is_error: true, exitCode: 1 });
      const signalled = completedCommand({ command: './deploy.sh', exitCode: 137, status: 'failed', signal: 'SIGKILL' });
      expect(signalled.metadata).toMatchObject({ is_error: true, exitCode: 137 });
      const noSignal = completedCommand({ command: './deploy.sh', exitCode: 2, status: 'failed', signal: null, timed_out: false });
      expect(noSignal.metadata).toMatchObject({ is_error: false });
    });

    it('does not call a failed check that ran after another failing step a failed test', () => {
      const result = completedCommand({ command: '/bin/zsh -lc "git pull && npm test"', aggregatedOutput: 'merge conflict', exitCode: 1, status: 'failed' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: false });
      const direct = completedCommand({ command: '/bin/zsh -lc "cd app && npm test"', aggregatedOutput: '1 failed', exitCode: 1, status: 'failed' });
      // Without per-step evidence the directory change could have failed first.
      expect(direct.metadata).toMatchObject({ isCheck: true, checkFailed: false });
    });

    it('reads the snake_case exit field some Codex releases send', () => {
      const result = completedCommand({ type: 'command_execution', command: 'npm run lint', exit_code: 2, status: 'completed', aggregated_output: '' });
      expect(result.metadata).toMatchObject({ is_error: false, exitCode: 2, isCheck: true, checkFailed: true });
      expect(result.content).toBe('Exited with status 2');
    });

    it('leaves file changes and tool calls failing on their own error flag', () => {
      const ops = host();
      handleItemCompleted(ops, state(), {
        threadId: 'thread-1',
        item: { type: 'fileChange', id: 'edit-1', path: 'a.ts', status: 'failed' },
      });
      handleItemCompleted(ops, state(), {
        threadId: 'thread-1',
        item: { type: 'mcpToolCall', id: 'mcp-1', server: 'docs', tool: 'lookup', status: 'failed' },
      });
      expect(ops.emitOutput.mock.calls[0][0].metadata).toMatchObject({ name: 'Edit', is_error: true });
      expect(ops.emitOutput.mock.calls[1][0].metadata).toMatchObject({ name: 'lookup', is_error: true });
    });
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
