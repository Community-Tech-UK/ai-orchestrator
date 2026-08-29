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
});
