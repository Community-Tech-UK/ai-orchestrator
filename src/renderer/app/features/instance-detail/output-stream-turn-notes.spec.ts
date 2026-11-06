import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TurnBaselineResult } from '../../../../shared/types/turn-file-changes.types';
import { TurnBaselineIpcService } from '../../core/services/ipc/turn-baseline-ipc.service';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { DisplayItemProcessor, type DisplayItem } from './display-item-processor.service';
import { OutputStreamTurnNotes } from './output-stream-turn-notes';

let sequence = 0;

function msg(type: OutputMessage['type'], at: number, extra: Partial<OutputMessage> = {}): OutputMessage {
  sequence += 1;
  return { id: `m${sequence}`, timestamp: at, type, content: '', ...extra };
}

const user = (at: number, id: string) => msg('user', at, { id, content: 'please do it' });
const reply = (at: number, id: string, content = 'Done.') => msg('assistant', at, { id, content });
const bash = (at: number, id: string, extra: Record<string, unknown> = {}) =>
  msg('tool_use', at, { content: 'Using tool', metadata: { name: 'Bash', id, input: { command: 'ls' }, ...extra } });
const bashResult = (at: number, id: string, extra: Record<string, unknown> = {}) =>
  msg('tool_result', at, { metadata: { name: 'Bash', id, exitCode: 0, status: 'completed', is_error: false, isCheck: false, checkFailed: false, ...extra } });

const ready = (overrides: Partial<Extract<TurnBaselineResult, { state: 'ready' }>> = {}): TurnBaselineResult => ({
  state: 'ready', total: 2, truncated: false, baselineCompletedAt: 500, endedAt: 90_000,
  files: [
    { path: 'a.ts', status: 'modified', added: 3, deleted: 1 },
    { path: 'b.ts', status: 'added', added: 5, deleted: 0 },
  ],
  ...overrides,
});

describe('OutputStreamTurnNotes', () => {
  const messages = signal<OutputMessage[]>([]);
  const items = signal<DisplayItem[]>([]);
  const instanceId = signal('inst-1');
  interface Session { status: string; workingDirectory: string; executionLocation?: { type: string }; lastTurnOutcome?: string }
  /** Signal-backed like the real store, so a status change reaches the controller. */
  const session = signal<Session | undefined>(undefined);
  const getTurnFileChanges = vi.fn<(instanceId: string, turnKey: string) => Promise<TurnBaselineResult | null>>();
  let notes: OutputStreamTurnNotes;

  /** Real display rows for the current messages, exactly as the transcript builds them. */
  function setTranscript(list: OutputMessage[], hideToolGroups = false): void {
    messages.set(list);
    const rows = new DisplayItemProcessor().process(list, instanceId());
    items.set(hideToolGroups ? rows.filter((row) => row.type !== 'tool-group') : rows);
  }

  /** Runs the effects, lets any answer from the main process land, and runs the effects again. */
  async function settle(): Promise<void> {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    TestBed.tick();
  }

  beforeEach(() => {
    sequence = 0;
    getTurnFileChanges.mockReset();
    getTurnFileChanges.mockResolvedValue({ state: 'unavailable', reason: 'no-baseline' });
    session.set({ status: 'idle', workingDirectory: '/repo' });
    instanceId.set('inst-1');
    messages.set([]);
    items.set([]);
    TestBed.configureTestingModule({
      providers: [
        { provide: InstanceStore, useValue: { getInstance: () => session() } },
        { provide: TurnBaselineIpcService, useValue: { getTurnFileChanges } },
      ],
    });
    notes = TestBed.runInInjectionContext(() => new OutputStreamTurnNotes({
      messages: () => messages(),
      items: () => items(),
      instanceId: () => instanceId(),
    }));
  });

  it('puts the note on the last row of each finished turn', () => {
    setTranscript([
      user(1_000, 'u1'), bash(2_000, 'b1'), bashResult(2_100, 'b1'), reply(13_000, 'r1'),
      user(20_000, 'u2'), reply(21_000, 'r2'),
    ]);
    const anchored = [...notes.notes().entries()];
    expect(anchored).toHaveLength(1);
    const [rowId, note] = anchored[0];
    expect(rowId).toBe('msg-r1');
    expect(note.turnKey).toBe('u1');
    expect(note.summary?.text).toBe('12 s · ran 1 command');
    expect(notes.noteFor('msg-r1')).toBe(note);
    expect(notes.noteFor('msg-r2')).toBeUndefined();
  });

  it('puts the note after a tool group when the turn ends there', () => {
    setTranscript([user(1_000, 'u1'), bash(2_000, 'b1'), bashResult(2_100, 'b1')]);
    const [rowId] = [...notes.notes().keys()];
    expect(rowId).toMatch(/^tools-/);
  });

  it('puts the note after the reply when a run of tool calls was folded into a work cycle', () => {
    setTranscript([
      user(1_000, 'u1'),
      bash(2_000, 'b1'), bashResult(2_100, 'b1'), msg('assistant', 2_200, { id: 'think', content: '', thinking: [{ id: 't', content: 'hmm', format: 'sdk' }] }),
      bash(3_000, 'b2'), bashResult(3_100, 'b2'),
      reply(14_000, 'r1'),
    ]);
    expect(items().some((item) => item.type === 'work-cycle')).toBe(true);
    expect([...notes.notes().keys()]).toEqual(['msg-r1']);
  });

  it('still writes the note when tool calls are hidden, under the last row that is shown', () => {
    setTranscript([
      user(1_000, 'u1'), bash(2_000, 'b1'), bashResult(2_100, 'b1'), reply(13_000, 'r1'),
    ], true);
    expect(items().some((item) => item.type === 'tool-group')).toBe(false);
    const [rowId, note] = [...notes.notes().entries()][0];
    expect(rowId).toBe('msg-r1');
    expect(note.summary?.text).toBe('12 s · ran 1 command');
  });

  it('writes nothing for a turn still running', () => {
    session.set({ status: 'busy', workingDirectory: '/repo' });
    setTranscript([user(1_000, 'u1'), bash(2_000, 'b1')]);
    expect(notes.notes().size).toBe(0);
  });

  it('writes the note once the session goes idle', () => {
    session.set({ status: 'busy', workingDirectory: '/repo' });
    const transcript = [user(1_000, 'u1'), bash(2_000, 'b1'), bashResult(2_100, 'b1'), reply(13_000, 'r1')];
    setTranscript(transcript);
    expect(notes.notes().size).toBe(0);

    session.set({ status: 'idle', workingDirectory: '/repo' });
    expect(notes.notes().size).toBe(1);
  });

  it('warns under the reply when an edit failed and was not redone', () => {
    setTranscript([
      user(1_000, 'u1'),
      msg('tool_use', 2_000, { metadata: { name: 'Edit', id: 'e1', input: { file_path: '/repo/src/a.ts' } } }),
      msg('tool_outcome', 2_100, { content: 'old_string not found', metadata: { tool_use_id: 'e1', is_error: true } }),
      reply(3_000, 'r1', 'All edits applied.'),
    ]);
    const note = notes.noteFor('msg-r1')!;
    expect(note.warning?.text).toContain('1 edit failed and was not retried: src/a.ts');
  });

  describe('files changed while the reply ran', () => {
    const turn = () => [
      user(1_000, 'u1'), bash(2_000, 'b1'), bashResult(2_100, 'b1'), reply(13_000, 'r1'),
    ];

    it('asks the main process about a finished turn that used tools, and shows the real count', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      setTranscript(turn());
      await settle();

      expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-1', 'u1');
      const note = notes.noteFor('msg-r1')!;
      expect(note.changedFiles).toBe(2);
      expect(note.changedPaths).toEqual(['a.ts', 'b.ts']);
    });

    it('asks once per turn however often the transcript changes', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      setTranscript(turn());
      await settle();
      messages.set([...messages()]);
      await settle();
      messages.set([...messages()]);
      await settle();
      expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
    });

    it('shows no count when nothing changed, and never invents one when the answer is unavailable', async () => {
      getTurnFileChanges.mockResolvedValue(ready({ total: 0, files: [] }));
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);

      getTurnFileChanges.mockResolvedValue({ state: 'unavailable', reason: 'not-git' });
      setTranscript(turn().map((message) => ({ ...message, id: `${message.id}x` })));
      await settle();
      for (const note of notes.notes().values()) expect(note.changedFiles).toBe(0);
    });

    it('does not ask for a turn that used no tools, a turn still running, or a remote computer', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      setTranscript([user(1_000, 'u1'), reply(30_000, 'r1')]);
      await settle();
      expect(getTurnFileChanges).not.toHaveBeenCalled();

      session.set({ status: 'busy', workingDirectory: '/repo' });
      setTranscript([user(1_000, 'u2'), bash(2_000, 'b9')]);
      await settle();
      expect(getTurnFileChanges).not.toHaveBeenCalled();

      session.set({ status: 'idle', workingDirectory: '/repo', executionLocation: { type: 'remote' } });
      setTranscript([user(1_000, 'u3'), bash(2_000, 'b3'), bashResult(2_100, 'b3'), reply(5_000, 'r3')]);
      await settle();
      expect(getTurnFileChanges).not.toHaveBeenCalled();
    });

    it('does not ask when the session is not a live one this view can compare', async () => {
      session.set(undefined);
      setTranscript(turn());
      await settle();
      expect(getTurnFileChanges).not.toHaveBeenCalled();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);
    });

    it('does not trust a baseline taken after the agent had already started using tools', async () => {
      getTurnFileChanges.mockResolvedValue(ready({ baselineCompletedAt: 2_500 }));
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);
    });

    it('does not trust a comparison that finished before the turn did', async () => {
      getTurnFileChanges.mockResolvedValue(ready({ endedAt: 12_000 }));
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);
    });

    it('counts a steered turn across its chained input spans', async () => {
      getTurnFileChanges.mockImplementation(async (_instanceId, turnKey) => turnKey === 'u1'
        ? ready({ total: 1, files: [{ path: 'a.ts', status: 'modified', added: 1, deleted: 0 }], baselineCompletedAt: 500, endedAt: 2_000 })
        : ready({ total: 1, files: [{ path: 'b.ts', status: 'added', added: 1, deleted: 0 }], baselineCompletedAt: 2_000, endedAt: 14_000 }));
      setTranscript([
        user(1_000, 'u1'),
        bash(1_500, 'b1', { turnId: 'T1' }), bashResult(1_600, 'b1', { turnId: 'T1' }),
        user(2_000, 'steer'),
        bash(3_000, 'b2', { turnId: 'T1' }), bashResult(3_100, 'b2', { turnId: 'T1' }),
        reply(13_000, 'r1'),
      ]);
      await settle();

      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-1', 'u1');
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-1', 'steer');
      const note = notes.noteFor('msg-r1')!;
      expect(note.changedFiles).toBe(2);
      expect(note.changedPaths).toEqual(['a.ts', 'b.ts']);
    });

    it('shows no count for a steered turn whose spans do not cover it', async () => {
      getTurnFileChanges.mockImplementation(async (_instanceId, turnKey) => turnKey === 'u1'
        ? ready({ total: 1, files: [{ path: 'a.ts', status: 'modified', added: 1, deleted: 0 }], baselineCompletedAt: 500, endedAt: 1_900 })
        : ready({ total: 1, files: [{ path: 'b.ts', status: 'added', added: 1, deleted: 0 }], baselineCompletedAt: 2_100, endedAt: 14_000 }));
      setTranscript([
        user(1_000, 'u1'),
        bash(1_500, 'b1', { turnId: 'T1' }), bashResult(1_600, 'b1', { turnId: 'T1' }),
        user(2_000, 'steer'),
        bash(3_000, 'b2', { turnId: 'T1' }), bashResult(3_100, 'b2', { turnId: 'T1' }),
        reply(13_000, 'r1'),
      ]);
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);

      getTurnFileChanges.mockImplementation(async (_instanceId, turnKey) => turnKey === 'u1'
        ? ready({ total: 1, files: [{ path: 'a.ts', status: 'modified', added: 1, deleted: 0 }], baselineCompletedAt: 500, endedAt: 2_000 })
        : { state: 'unavailable', reason: 'no-baseline' });
      setTranscript([
        user(1_000, 'u1x'),
        bash(1_500, 'b1x', { turnId: 'T2' }), bashResult(1_600, 'b1x', { turnId: 'T2' }),
        user(2_000, 'steer-x'),
        bash(3_000, 'b2x', { turnId: 'T2' }), bashResult(3_100, 'b2x', { turnId: 'T2' }),
        reply(13_000, 'r1x'),
      ]);
      await settle();
      for (const note of notes.notes().values()) expect(note.changedFiles).toBe(0);
    });

    it('shows the exact total when a single span’s path list was truncated', async () => {
      getTurnFileChanges.mockResolvedValue(ready({
        total: 250,
        truncated: true,
        files: Array.from({ length: 200 }, (_, index) => ({ path: `f${index}.ts`, status: 'modified' as const, added: 1, deleted: 0 })),
      }));
      setTranscript(turn());
      await settle();
      const note = notes.noteFor('msg-r1')!;
      expect(note.changedFiles).toBe(250);
      expect(note.changedPaths).toHaveLength(200);
    });

    it('claims no exact union when a steered span was truncated', async () => {
      getTurnFileChanges.mockImplementation(async (_instanceId, turnKey) => turnKey === 'u1'
        ? ready({ total: 1, files: [{ path: 'a.ts', status: 'modified', added: 1, deleted: 0 }], baselineCompletedAt: 500, endedAt: 2_000 })
        : ready({
            total: 250,
            truncated: true,
            files: [{ path: 'b.ts', status: 'added', added: 1, deleted: 0 }],
            baselineCompletedAt: 2_000,
            endedAt: 14_000,
          }));
      setTranscript([
        user(1_000, 'u1'),
        bash(1_500, 'b1', { turnId: 'T1' }), bashResult(1_600, 'b1', { turnId: 'T1' }),
        user(2_000, 'steer'),
        bash(3_000, 'b2', { turnId: 'T1' }), bashResult(3_100, 'b2', { turnId: 'T1' }),
        reply(13_000, 'r1'),
      ]);
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);
    });

    it('asks again when the same turn went on and finished again', async () => {
      getTurnFileChanges.mockResolvedValueOnce(ready({ endedAt: 14_000 }));
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(2);

      getTurnFileChanges.mockResolvedValueOnce(ready({ total: 3, endedAt: 70_000, files: [
        { path: 'a.ts', status: 'modified', added: 1, deleted: 0 },
        { path: 'b.ts', status: 'modified', added: 1, deleted: 0 },
        { path: 'c.ts', status: 'added', added: 1, deleted: 0 },
      ] }));
      setTranscript([...turn(), bash(60_000, 'b-late'), bashResult(60_100, 'b-late'), reply(65_000, 'r-late')]);
      await settle();
      expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
      expect(notes.noteFor('msg-r-late')!.changedFiles).toBe(3);
    });

    it('starts fresh when the view switches to another session', async () => {
      getTurnFileChanges.mockResolvedValue(ready());
      setTranscript(turn());
      await settle();
      instanceId.set('inst-2');
      setTranscript(turn().map((message) => ({ ...message, id: `${message.id}-2` })));
      await settle();
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-2', 'u1-2');
    });

    it('keeps a late answer with the session it was for, not whichever session is showing', async () => {
      let release: (value: TurnBaselineResult) => void = () => undefined;
      getTurnFileChanges.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
      setTranscript(turn());
      TestBed.tick();
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-1', 'u1');

      // Another session shows a turn with the very same message ids.
      instanceId.set('inst-2');
      setTranscript(turn());
      TestBed.tick();
      expect(getTurnFileChanges).toHaveBeenCalledWith('inst-2', 'u1');

      release(ready());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);

      instanceId.set('inst-1');
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(2);
      expect(getTurnFileChanges).toHaveBeenCalledTimes(2);
    });

    it('treats a failed request as no count and does not keep asking', async () => {
      getTurnFileChanges.mockRejectedValue(new Error('ipc down'));
      setTranscript(turn());
      await settle();
      expect(notes.noteFor('msg-r1')!.changedFiles).toBe(0);
      messages.set([...messages()]);
      await settle();
      expect(getTurnFileChanges).toHaveBeenCalledTimes(1);
    });
  });
});
