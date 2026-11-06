import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { projectTurns } from './turn-projection';

let sequence = 0;

function msg(
  type: OutputMessage['type'],
  at: number,
  extra: Partial<Pick<OutputMessage, 'content' | 'metadata' | 'thinking'>> & { id?: string } = {},
): OutputMessage {
  sequence += 1;
  return { id: extra.id ?? `m${sequence}`, timestamp: at, type, content: extra.content ?? '', ...extra };
}

const user = (at: number, id?: string) => msg('user', at, { content: 'do it', id });
const reply = (at: number, content = 'All done.', metadata?: Record<string, unknown>) =>
  msg('assistant', at, { content, metadata });
const toolUse = (at: number, metadata: Record<string, unknown>) =>
  msg('tool_use', at, { content: 'Using tool', metadata });
const outcome = (at: number, metadata: Record<string, unknown>, content = '') =>
  msg('tool_outcome', at, { content, metadata });
const machine = (at: number, id?: string) =>
  msg('system', at, {
    content: 'Background work finished',
    id,
    metadata: { internalInput: { actor: 'harness', source: 'async-work-continuation' } },
  });

const settled = { lastTurnOpen: false };

describe('projectTurns — where turns start and end', () => {
  it('starts a turn at each user message', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(2_000), user(5_000, 'u2'), reply(6_000),
    ], settled);
    expect(turns.map((turn) => [turn.key, turn.startKind, turn.startIndex, turn.endIndex])).toEqual([
      ['u1', 'user', 0, 2], ['u2', 'user', 2, 4],
    ]);
  });

  it('keeps messages that arrived before the first input as an unfinished turn with no note', () => {
    const { turns } = projectTurns([
      reply(500), user(1_000, 'u1'), reply(2_000),
    ], settled);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ startKind: 'unknown', complete: false, summary: null, warning: null });
    expect(turns[1]).toMatchObject({ key: 'u1', complete: true });
  });

  it('starts a separate turn at input Harness wrote itself', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(2_000), machine(30_000, 'sys1'),
      toolUse(31_000, { name: 'Bash', id: 'b1', input: { command: 'ls' } }), reply(33_000),
    ], settled);
    expect(turns.map((turn) => [turn.key, turn.startKind])).toEqual([['u1', 'user'], ['sys1', 'machine']]);
    expect(turns[1].toolEvents).toHaveLength(1);
    expect(turns[0].toolEvents).toHaveLength(0);
  });

  it('keeps a message sent mid-turn inside the turn when the provider ran both under one turn id', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(1_500, 'Working', { turnId: 'T1' }),
      user(2_000, 'steer'), reply(2_500, 'Adjusted', { turnId: 'T1' }),
    ], settled);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ key: 'u1', startIndex: 0, endIndex: 4 });
  });

  it('starts a new turn for a new user message when the provider turn id changes', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(1_500, 'One', { turnId: 'T1' }),
      user(2_000, 'u2'), reply(2_500, 'Two', { turnId: 'T2' }),
    ], settled);
    expect(turns.map((turn) => turn.key)).toEqual(['u1', 'u2']);
  });

  it('keeps separate turns when the provider gives no turn ids at all', () => {
    const { turns } = projectTurns([user(1_000, 'u1'), reply(1_500), user(2_000, 'u2'), reply(2_500)], settled);
    expect(turns).toHaveLength(2);
  });

  it('opens a turn when the provider starts a new turn on its own', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(1_500, 'First', { turnId: 'T1' }),
      msg('assistant', 9_000, { id: 'auto', content: 'Goal continued', metadata: { turnId: 'T2' } }),
    ], settled);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ startKind: 'provider', complete: true });
  });

  it('maps every message to its turn', () => {
    const messages = [user(1_000, 'u1'), reply(1_100, 'x'), user(2_000, 'u2'), reply(2_100, 'y')];
    const { turnOfMessage } = projectTurns(messages, settled);
    expect(messages.map((message) => turnOfMessage.get(message.id))).toEqual([0, 0, 1, 1]);
  });

  it('returns nothing for an empty transcript', () => {
    expect(projectTurns([], settled)).toEqual({ turns: [], turnOfMessage: new Map() });
  });
});

describe('projectTurns — tools, notes and timing', () => {
  it('summarises a settled turn from its own tool calls', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'),
      toolUse(2_000, { name: 'Edit', id: 'e1', input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' } }),
      outcome(2_100, { tool_use_id: 'e1', is_error: false }),
      toolUse(3_000, { name: 'Bash', id: 'b1', input: { command: 'ls' } }),
      reply(13_000),
    ], { ...settled, cwd: '/repo' });
    expect(turns[0].summary?.text).toBe('12 s · edited 1 file +1 −1 · ran 1 command');
    expect(turns[0].firstToolAt).toBe(2_000);
  });

  it('does not summarise the turn that is still running', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), toolUse(2_000, { name: 'Bash', id: 'b1', input: { command: 'ls' } }),
    ], { lastTurnOpen: true });
    expect(turns[0]).toMatchObject({ settled: false, summary: null, warning: null });
  });

  it('measures the time from the input to the last piece of work, not to a trailing notice', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), reply(21_000),
      msg('system', 90_000, { content: 'Context compacted' }),
    ], settled);
    expect(turns[0].summary?.text).toBe('20 s');
  });

  it('decides from the transcript alone whether the last turn is over when the host cannot say', () => {
    const tools = [
      user(1_000, 'u1'),
      toolUse(2_000, { name: 'Bash', id: 'b1', input: { command: 'ls' } }),
    ];
    const open = projectTurns(tools, {});
    expect(open.turns[0]).toMatchObject({ settled: false, summary: null });

    const closed = projectTurns([...tools, reply(13_000)], {});
    expect(closed.turns[0].settled).toBe(true);
    expect(closed.turns[0].summary?.text).toBe('12 s · ran 1 command');
  });

  it('lets the host override: busy even with a reply, idle even without one', () => {
    const withReply = [user(1_000), toolUse(2_000, { name: 'Bash', id: 'b' }), reply(13_000)];
    expect(projectTurns(withReply, { lastTurnOpen: true }).turns[0].settled).toBe(false);
    const noReply = [user(1_000), toolUse(2_000, { name: 'Bash', id: 'b' })];
    expect(projectTurns(noReply, { lastTurnOpen: false }).turns[0].settled).toBe(true);
  });

  it('gives a short turn with no tools no note', () => {
    expect(projectTurns([user(1_000), reply(3_000)], settled).turns[0].summary).toBeNull();
  });

  it('attaches a result that arrives after the next input to the call it belongs to', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'),
      toolUse(1_500, { name: 'Edit', id: 'late', input: { file_path: 'a.ts' } }),
      user(2_000, 'u2'),
      outcome(2_500, { tool_use_id: 'late', is_error: true }, 'old_string not found'),
      reply(3_000),
    ], settled);
    expect(turns[0].toolEvents.map((event) => [event.id, event.settled, event.failed])).toEqual([['late', true, true]]);
    expect(turns[1].toolEvents).toEqual([]);
  });

  it('counts a call announced twice once', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'),
      toolUse(1_100, { name: 'Bash', id: 'b1', input: { command: 'ls' }, streaming: true }),
      toolUse(1_200, { name: 'Bash', id: 'b1', input: { command: 'ls' }, streaming: true }),
      reply(2_000),
    ], settled);
    expect(turns[0].toolEvents).toHaveLength(1);
  });
});

describe('projectTurns — final reply, interruption and the failed-edit warning', () => {
  const failedEdit = (at: number) => [
    toolUse(at, { name: 'Edit', id: `e${at}`, input: { file_path: 'src/a.ts' } }),
    outcome(at + 10, { tool_use_id: `e${at}`, is_error: true }, 'old_string not found'),
  ];

  it('warns when an edit failed, nothing redid it, and the turn ends in a text reply', () => {
    const { turns } = projectTurns([user(1_000), ...failedEdit(2_000), reply(3_000)], settled);
    expect(turns[0].hasFinalReply).toBe(true);
    expect(turns[0].warning?.text).toContain('1 edit failed and was not retried: src/a.ts');
  });

  it('clears the warning when a later write to the same file went through', () => {
    const { turns } = projectTurns([
      user(1_000), ...failedEdit(2_000),
      toolUse(2_500, { name: 'Edit', id: 'ok', input: { file_path: 'src/a.ts' } }),
      outcome(2_510, { tool_use_id: 'ok', is_error: false }),
      reply(3_000),
    ], settled);
    expect(turns[0].warning).toBeNull();
  });

  it('does not warn when the turn did not end in a text reply', () => {
    const { turns } = projectTurns([user(1_000), ...failedEdit(2_000)], settled);
    expect(turns[0].hasFinalReply).toBe(false);
    expect(turns[0].warning).toBeNull();
  });

  it('does not treat a progress note as the final reply', () => {
    const { turns } = projectTurns([
      user(1_000), ...failedEdit(2_000), reply(3_000, 'Trying another way', { messagePhase: 'commentary' }),
    ], settled);
    expect(turns[0].hasFinalReply).toBe(false);
  });

  it('looks past a thinking-only message to the reply before it', () => {
    const { turns } = projectTurns([
      user(1_000), ...failedEdit(2_000), reply(3_000),
      msg('assistant', 3_100, { content: '', thinking: [{ id: 't', content: 'hm', format: 'sdk' }] }),
    ], settled);
    expect(turns[0].hasFinalReply).toBe(true);
  });

  it('does not count a reply that is still streaming', () => {
    const { turns } = projectTurns([
      user(1_000), ...failedEdit(2_000), reply(3_000, 'Partial', { streaming: true }),
    ], settled);
    expect(turns[0].hasFinalReply).toBe(false);
  });

  it('does not warn on an interrupted turn, however the interruption was recorded', () => {
    const boundary = msg('system', 2_900, { content: '', metadata: { kind: 'interrupt-boundary', phase: 'completed' } });
    const quiet = msg('system', 2_900, { content: 'Interrupted — waiting for input' });
    for (const marker of [boundary, quiet]) {
      const { turns } = projectTurns([user(1_000), ...failedEdit(2_000), marker, reply(3_000)], settled);
      expect(turns[0].interrupted).toBe(true);
      expect(turns[0].warning).toBeNull();
    }
    const last = projectTurns([user(1_000), ...failedEdit(2_000), reply(3_000)], {
      ...settled, lastTurnOutcome: 'interrupted',
    });
    expect(last.turns[0].interrupted).toBe(true);
    expect(last.turns[0].warning).toBeNull();
  });

  it('applies the instance outcome to the last turn only', () => {
    const { turns } = projectTurns([
      user(1_000, 'u1'), ...failedEdit(2_000), reply(3_000),
      user(4_000, 'u2'), reply(5_000),
    ], { ...settled, lastTurnOutcome: 'cancelled' });
    expect(turns.map((turn) => turn.interrupted)).toEqual([false, true]);
    expect(turns[0].warning).not.toBeNull();
  });
});
