import { describe, expect, it } from 'vitest';
import {
  parseClaudeAsyncWorkToolResult,
  parseClaudeAsyncWorkToolUse,
  parseClaudeTaskNotification,
  parseClaudeToolProgress,
} from './claude-cli-async-work';

describe('Claude CLI async-work protocol parsing', () => {
  it('starts a provisional inhibitor for a background Bash invocation', () => {
    expect(parseClaudeAsyncWorkToolUse('Bash', 'toolu-shell', {
      command: 'npm test',
      run_in_background: true,
    })).toEqual({
      phase: 'started',
      workId: 'toolu-shell',
      kind: 'background-shell',
    });
  });

  it('does not treat an ordinary Bash invocation as background work', () => {
    expect(parseClaudeAsyncWorkToolUse('Bash', 'toolu-shell', {
      command: 'npm test',
    })).toBeNull();
  });

  it('replaces the provisional tool-use id with the native Bash task id', () => {
    expect(parseClaudeAsyncWorkToolResult(
      'toolu-shell',
      'Bash',
      'Command running in background with ID: b1r9dkwx8. Output is being written elsewhere.',
      false,
    )).toEqual({
      phase: 'started',
      workId: 'b1r9dkwx8',
      replacesWorkId: 'toolu-shell',
      kind: 'background-shell',
    });
  });

  it('recognizes an asynchronous Agent launch result', () => {
    expect(parseClaudeAsyncWorkToolResult(
      'toolu-agent',
      'Agent',
      'Async agent launched successfully.\nagentId: a681d928f3cea43d0 (internal ID)\nThe agent is working in the background.',
      false,
    )).toEqual({
      phase: 'started',
      workId: 'a681d928f3cea43d0',
      replacesWorkId: 'toolu-agent',
      kind: 'subagent',
    });
  });

  it('terminates a provisional background invocation whose launch failed', () => {
    expect(parseClaudeAsyncWorkToolResult(
      'toolu-shell',
      'Bash',
      'Unable to start background command',
      true,
      { run_in_background: true },
    )).toEqual({
      phase: 'terminal',
      workId: 'toolu-shell',
      kind: 'background-shell',
      status: 'failed',
      continueOnCompletion: false,
    });
  });

  it('parses terminal task notifications without exposing their summary', () => {
    expect(parseClaudeTaskNotification([
      '<task-notification>',
      '<task-id>b1r9dkwx8</task-id>',
      '<tool-use-id>toolu-shell</tool-use-id>',
      '<status>completed</status>',
      '<summary>Full output may contain sensitive command text.</summary>',
      '</task-notification>',
    ].join('\n'))).toEqual({
      phase: 'terminal',
      workId: 'b1r9dkwx8',
      replacesWorkId: 'toolu-shell',
      kind: 'background-shell',
      status: 'completed',
    });
  });

  it('rejects non-terminal or malformed task notifications', () => {
    expect(parseClaudeTaskNotification('<task-notification><status>running</status></task-notification>'))
      .toBeNull();
    expect(parseClaudeTaskNotification('ordinary user text')).toBeNull();
  });

  it('normalizes Claude tool_progress heartbeats to the parent tool id', () => {
    expect(parseClaudeToolProgress({
      type: 'tool_progress',
      tool_use_id: 'toolu-shell-heartbeat-4',
      parent_tool_use_id: 'toolu-shell',
      tool_name: 'Bash',
      elapsed_time_seconds: 150,
      heartbeat: true,
    })).toEqual({
      phase: 'progress',
      workId: 'toolu-shell',
      kind: 'background-shell',
    });
  });
});
