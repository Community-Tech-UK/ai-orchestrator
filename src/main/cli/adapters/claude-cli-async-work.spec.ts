import { describe, expect, it } from 'vitest';
import {
  ClaudeBackgroundTaskTracker,
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

  it('recognizes a command Claude moved to the background after its timeout', () => {
    expect(parseClaudeAsyncWorkToolResult(
      'toolu-shell',
      'Bash',
      'Command did not complete within its 120s timeout and was moved to the background (ID: bv3kogvto). Output is being written to: /tmp/tasks/bv3kogvto.output',
      false,
      { command: 'python3 sync.py', timeout: 120000 },
    )).toEqual({
      phase: 'started',
      workId: 'bv3kogvto',
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

  describe('ClaudeBackgroundTaskTracker (system task messages, Claude CLI stream-json)', () => {
    // Shapes captured from a live `claude --print --output-format stream-json
    // --input-format stream-json --verbose` run on 2026-09-17.
    const explicitStart = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'beja5ulfs',
      tool_use_id: 'toolu_01DK21Ngc6LyPGzjFFHSzWbS',
      description: 'long command',
      is_backgrounded: true,
      task_type: 'local_bash',
    };

    it('starts work for a task launched in the background', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe(explicitStart)).toEqual([{
        phase: 'started',
        workId: 'beja5ulfs',
        replacesWorkId: 'toolu_01DK21Ngc6LyPGzjFFHSzWbS',
        kind: 'background-shell',
      }]);
    });

    it('starts work when a foreground command is moved to the background by its timeout', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b5mda85zy',
        tool_use_id: 'toolu_01UWfhB9xVQjBpnez2Z3YhBt',
        is_backgrounded: false,
        task_type: 'local_bash',
      })).toEqual([]);
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'b5mda85zy',
        patch: { is_backgrounded: true },
      })).toEqual([{
        phase: 'started',
        workId: 'b5mda85zy',
        replacesWorkId: 'toolu_01UWfhB9xVQjBpnez2Z3YhBt',
        kind: 'background-shell',
      }]);
    });

    it('classifies background agents as subagent work', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'a9f2b123bbe36d66d',
        tool_use_id: 'toolu_01VDbJd3zpk73cD9312YjtEy',
        is_backgrounded: true,
        task_type: 'local_agent',
      })).toEqual([{
        phase: 'started',
        workId: 'a9f2b123bbe36d66d',
        replacesWorkId: 'toolu_01VDbJd3zpk73cD9312YjtEy',
        kind: 'subagent',
      }]);
    });

    it('ignores tasks a subagent runs internally, including their notifications', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'boa5w74x0',
        owned_by_subagent: true,
        tool_use_id: 'toolu_01H998F7Qu9jSyTYAJR2cdw8',
        is_backgrounded: false,
        task_type: 'local_bash',
      })).toEqual([]);
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'boa5w74x0',
        tool_use_id: 'toolu_01H998F7Qu9jSyTYAJR2cdw8',
        status: 'completed',
      })).toEqual([]);
    });

    it('emits the authoritative background task list as a snapshot', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'b5mda85zy', task_type: 'local_bash', description: 'x' },
          { task_id: 'a9f2b123bbe36d66d', task_type: 'local_agent', description: 'y' },
        ],
      })).toEqual([{
        phase: 'snapshot',
        work: [
          { workId: 'b5mda85zy', kind: 'background-shell' },
          { workId: 'a9f2b123bbe36d66d', kind: 'subagent' },
        ],
      }]);
      expect(tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }))
        .toEqual([{ phase: 'snapshot', work: [] }]);
    });

    it('withdraws a snapshot entry once its task turns out to belong to a subagent', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      // The CLI sends the list change before task_started for a new task.
      tracker.observe({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [
          { task_id: 'b-own', task_type: 'local_bash' },
          { task_id: 'b-sub', task_type: 'local_bash' },
        ],
      });

      expect(tracker.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b-sub',
        owned_by_subagent: true,
        tool_use_id: 'toolu-sub',
        is_backgrounded: true,
        task_type: 'local_bash',
      })).toEqual([{ phase: 'snapshot', work: [{ workId: 'b-own', kind: 'background-shell' }] }]);
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b-own',
        tool_use_id: 'toolu-own',
        is_backgrounded: true,
        task_type: 'local_bash',
      })).toEqual([{ phase: 'started', workId: 'b-own', replacesWorkId: 'toolu-own', kind: 'background-shell' }]);
    });

    it('turns a background task notification into a terminal event and marks the next turn as provider-resumed', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      tracker.observe(explicitStart);
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'beja5ulfs',
        tool_use_id: 'toolu_01DK21Ngc6LyPGzjFFHSzWbS',
        status: 'completed',
        summary: 'Background command completed',
      })).toEqual([{
        phase: 'terminal',
        workId: 'beja5ulfs',
        replacesWorkId: 'toolu_01DK21Ngc6LyPGzjFFHSzWbS',
        kind: 'background-shell',
        status: 'completed',
      }]);
      expect(tracker.observe({ type: 'system', subtype: 'init' }))
        .toEqual([{ phase: 'provider-resumed' }]);
      expect(tracker.observe({ type: 'system', subtype: 'init' })).toEqual([]);
    });

    it('does not report a resumed turn when no notification preceded it', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({ type: 'system', subtype: 'init' })).toEqual([]);
    });

    it('reports progress for tracked background tasks only', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      tracker.observe({ ...explicitStart, task_id: 'agent-1', task_type: 'local_agent' });
      expect(tracker.observe({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'agent-1',
        tool_use_id: 'toolu_01DK21Ngc6LyPGzjFFHSzWbS',
      })).toEqual([{ phase: 'progress', workId: 'agent-1', kind: 'subagent' }]);
      expect(tracker.observe({ type: 'system', subtype: 'task_progress', task_id: 'unknown' }))
        .toEqual([]);
    });

    it('ignores unrelated and malformed system messages', () => {
      const tracker = new ClaudeBackgroundTaskTracker();
      expect(tracker.observe({ type: 'system', subtype: 'thinking_tokens' })).toEqual([]);
      expect(tracker.observe({ type: 'system', subtype: 'task_started' })).toEqual([]);
      expect(tracker.observe({ type: 'system', subtype: 'background_tasks_changed', tasks: 'x' })).toEqual([]);
      expect(tracker.observe(null)).toEqual([]);
    });
  });
});
