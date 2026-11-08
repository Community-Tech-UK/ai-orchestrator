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

describe('ClaudeCliAdapter turn starts', () => {
  /** Stands in for the CLI: records the uuid on each message written, and replays the lifecycle lines the real CLI printed. */
  function turnStartHarness(sendMessage: () => Promise<void> = async () => undefined) {
    const adapter = new ClaudeCliAdapter();
    const uuids: string[] = [];
    (adapter as unknown as { formatter: unknown }).formatter = {
      isWritable: () => true,
      sendMessage: vi.fn(async (_message: string, _attachments: unknown, _dispatch: unknown, uuid?: string) => {
        if (uuid) uuids.push(uuid);
        await sendMessage();
      }),
      sendRaw: vi.fn(async () => undefined),
    };
    const sources: string[] = [];
    (adapter as unknown as { on: (event: string, listener: (event: { source: string }) => void) => void })
      .on('turn_started', event => sources.push(event.source));
    const feed = (adapter as unknown as { processCliMessage: (message: unknown) => void }).processCliMessage.bind(adapter);
    const lifecycle = (uuid: string, state: string): void => feed({ type: 'command_lifecycle', command_uuid: uuid, state });
    const init = (): void => feed({ type: 'system', subtype: 'init', session_id: 'session-1' });
    return { adapter, uuids, sources, feed, lifecycle, init };
  }

  it('reports every turn start, including one the CLI begins by itself after background work ends', async () => {
    const { adapter, uuids, sources, feed, lifecycle, init } = turnStartHarness();

    await adapter.sendInput('do the work');
    lifecycle(uuids[0], 'queued');
    lifecycle(uuids[0], 'started');
    init();
    feed({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    expect(sources).toEqual(['harness-send']);
    feed({ type: 'result', subtype: 'success', result: 'done' });
    lifecycle(uuids[0], 'completed');

    // Background job ends between turns: the CLI starts a turn of its own, with an init and no lifecycle lines.
    feed({ type: 'system', subtype: 'task_notification', task_id: 'bg-1', status: 'completed' });
    init();
    expect(sources).toEqual(['harness-send', 'provider']);
  });

  it('puts a uuid of its own on every message it writes', async () => {
    const { adapter, uuids } = turnStartHarness();
    await adapter.sendInput('one');
    await adapter.sendInput('two');
    expect(uuids).toHaveLength(2);
    expect(new Set(uuids).size).toBe(2);
    expect(uuids.every(uuid => /^[0-9a-f-]{36}$/.test(uuid))).toBe(true);
  });

  it('calls an init with no started message of ours before it a provider turn', async () => {
    const { adapter, uuids, sources, lifecycle, init } = turnStartHarness();
    init(); // the CLI's own turn
    feed_result(adapter);
    await adapter.sendInput('typed after the background turn ended');
    lifecycle(uuids[0], 'started');
    init();
    init(); // a second init with nothing started before it
    expect(sources).toEqual(['provider', 'harness-send', 'provider']);
  });

  it('does not take a provider turn that begins after the write for the message\'s own turn', async () => {
    const { adapter, uuids, sources, lifecycle, init } = turnStartHarness();
    await adapter.sendInput('typed just before the CLI began a turn of its own');
    lifecycle(uuids[0], 'queued');
    init(); // the provider's turn got there first: no lifecycle line for our message precedes it
    feed_result(adapter);
    lifecycle(uuids[0], 'started'); // our message's own turn comes next
    init();
    expect(sources).toEqual(['provider', 'harness-send']);
  });

  it('reports finished background work as a provider turn, whether the CLI starts a turn for it or folds it into the running one', async () => {
    const { adapter, uuids, sources, feed, lifecycle, init } = turnStartHarness();
    await adapter.sendInput('message');
    feed({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification><task-id>bg-1</task-id><tool-use-id>toolu-shell</tool-use-id><status>completed</status></task-notification>' }] } });
    lifecycle(uuids[0], 'started');
    init();
    expect(sources).toEqual(['provider', 'harness-send']);
  });

  it('ignores lifecycle lines for a uuid Harness did not write', async () => {
    const { sources, lifecycle, init } = turnStartHarness();
    lifecycle('11111111-1111-4111-8111-111111111111', 'started');
    init();
    expect(sources).toEqual(['provider']);
  });

  it('does not let a started message that never got its own init label the next provider init', async () => {
    const { adapter, uuids, sources, lifecycle, init } = turnStartHarness();
    init(); // a turn the CLI began itself
    await adapter.sendInput('folded into the running turn');
    lifecycle(uuids[0], 'started'); // started, but no init of its own
    feed_result(adapter);
    init();
    expect(sources).toEqual(['provider', 'provider']);
  });

  it('does not let a message whose write failed turn a later init into a harness send', async () => {
    const { adapter, uuids, sources, lifecycle, init } = turnStartHarness(async () => { throw new Error('stdin closed'); });
    await expect(adapter.sendInput('lost')).rejects.toThrow('stdin closed');
    lifecycle(uuids[0], 'started');
    init();
    expect(sources).toEqual(['provider']);
  });

  it('does not report command lifecycle lines or other system messages as a turn start', () => {
    const { sources, feed, lifecycle } = turnStartHarness();
    lifecycle('11111111-1111-4111-8111-111111111111', 'queued');
    lifecycle('11111111-1111-4111-8111-111111111111', 'completed');
    feed({ type: 'system', subtype: 'task_progress', task_id: 'bg-1' });
    feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    expect(sources).toEqual([]);
  });

  it('says it reports turn starts, so Land anyway from a Claude session can be considered', () => {
    expect(new ClaudeCliAdapter().getAdapterCapabilities().reportsTurnStarts).toBe(true);
  });
});

function feed_result(adapter: ClaudeCliAdapter): void {
  (adapter as unknown as { processCliMessage: (message: unknown) => void })
    .processCliMessage({ type: 'result', subtype: 'success', result: 'done' });
}
