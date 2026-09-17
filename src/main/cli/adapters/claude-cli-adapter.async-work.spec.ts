import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { ClaudeCliAdapter } from './claude-cli-adapter';
import type { CliAsyncWorkEvent } from './claude-cli-async-work';

function makeAdapter(): {
  events: CliAsyncWorkEvent[];
  feed: (message: unknown) => void;
} {
  const adapter = new ClaudeCliAdapter();
  const events: CliAsyncWorkEvent[] = [];
  (adapter as unknown as { on: (event: string, listener: (value: CliAsyncWorkEvent) => void) => void })
    .on('async_work', (event) => events.push(event));
  const feed = (adapter as unknown as { processCliMessage: (message: unknown) => void })
    .processCliMessage.bind(adapter);
  return { events, feed };
}

describe('ClaudeCliAdapter async-work events', () => {
  it('emits provisional and native task identities for a background Bash launch', () => {
    const { events, feed } = makeAdapter();

    feed({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu-shell',
          name: 'Bash',
          input: { command: 'npm test', run_in_background: true },
        }],
      },
    });
    feed({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu-shell',
          content: 'Command running in background with ID: bg-1.',
        }],
      },
    });

    expect(events).toEqual([
      { phase: 'started', workId: 'toolu-shell', kind: 'background-shell' },
      {
        phase: 'started',
        workId: 'bg-1',
        replacesWorkId: 'toolu-shell',
        kind: 'background-shell',
      },
    ]);
  });

  it('emits terminal task notifications that arrive as user text blocks', () => {
    const { events, feed } = makeAdapter();

    feed({
      type: 'user',
      message: {
        content: [{
          type: 'text',
          text: '<task-notification><task-id>bg-1</task-id><tool-use-id>toolu-shell</tool-use-id><status>completed</status></task-notification>',
        }],
      },
    });

    expect(events).toEqual([{
      phase: 'terminal',
      workId: 'bg-1',
      replacesWorkId: 'toolu-shell',
      kind: 'background-shell',
      status: 'completed',
    }]);
  });

  it('recognizes tool_progress heartbeats without adding transcript output', () => {
    const adapter = new ClaudeCliAdapter();
    const events: CliAsyncWorkEvent[] = [];
    const outputs: unknown[] = [];
    (adapter as unknown as { on: (event: string, listener: (value: never) => void) => void })
      .on('async_work', (event) => events.push(event));
    adapter.on('output', (output) => outputs.push(output));
    const feed = (adapter as unknown as { processCliMessage: (message: unknown) => void })
      .processCliMessage.bind(adapter);

    feed({
      type: 'tool_progress',
      tool_use_id: 'toolu-shell-heartbeat-1',
      parent_tool_use_id: 'toolu-shell',
      tool_name: 'Bash',
      elapsed_time_seconds: 30,
      heartbeat: true,
    });

    expect(events).toEqual([{
      phase: 'progress',
      workId: 'toolu-shell',
      kind: 'background-shell',
    }]);
    expect(outputs).toEqual([]);
  });

  it('tracks a command moved to the background by its timeout through to the provider-resumed turn', () => {
    const { events, feed } = makeAdapter();
    // Order and shapes as emitted by Claude CLI stream-json on 2026-09-17.
    feed({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'toolu-slow',
          name: 'Bash',
          input: { command: 'python3 sync.py', timeout: 5000 },
        }],
      },
    });
    feed({
      type: 'system',
      subtype: 'task_started',
      task_id: 'b5mda85zy',
      tool_use_id: 'toolu-slow',
      is_backgrounded: false,
      task_type: 'local_bash',
    });
    feed({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [{ task_id: 'b5mda85zy', task_type: 'local_bash', description: 'python3 sync.py' }],
    });
    feed({ type: 'system', subtype: 'task_updated', task_id: 'b5mda85zy', patch: { is_backgrounded: true } });
    feed({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu-slow',
          content: 'Command did not complete within its 5s timeout and was moved to the background (ID: b5mda85zy). Output is being written to: /tmp/b5mda85zy.output',
        }],
      },
    });
    feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    feed({ type: 'system', subtype: 'task_updated', task_id: 'b5mda85zy', patch: { status: 'completed' } });
    feed({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'b5mda85zy',
      tool_use_id: 'toolu-slow',
      status: 'completed',
      output_file: '/tmp/b5mda85zy.output',
      summary: 'Background command completed',
    });
    feed({ type: 'system', subtype: 'init', session_id: 'session-1' });

    expect(events).toEqual([
      { phase: 'snapshot', work: [{ workId: 'b5mda85zy', kind: 'background-shell' }] },
      // Reported twice (task_updated and the tool_result text); the registry
      // treats a repeated start for the same work id as a no-op.
      { phase: 'started', workId: 'b5mda85zy', replacesWorkId: 'toolu-slow', kind: 'background-shell' },
      { phase: 'started', workId: 'b5mda85zy', replacesWorkId: 'toolu-slow', kind: 'background-shell' },
      { phase: 'snapshot', work: [] },
      {
        phase: 'terminal',
        workId: 'b5mda85zy',
        replacesWorkId: 'toolu-slow',
        kind: 'background-shell',
        status: 'completed',
      },
      { phase: 'provider-resumed' },
    ]);
  });
});
