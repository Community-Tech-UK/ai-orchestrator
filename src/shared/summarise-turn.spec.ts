import { describe, expect, it } from 'vitest';
import {
  MAX_SUMMARY_SEGMENTS,
  QUIET_TURN_MS,
  describeEditFailure,
  findEditFailureWarning,
  formatTurnDuration,
  summariseTurn,
} from './summarise-turn';
import { collectTurnToolEvents, type ToolEventMessage, type TurnToolEvent, type TurnToolKind } from './turn-tool-events';

let counter = 0;

function call(kind: TurnToolKind, extra: Partial<TurnToolEvent> = {}): TurnToolEvent {
  counter += 1;
  return {
    id: `t${counter}`, startMessageId: `m${counter}`, kind, name: kind, paths: [], settled: true, succeeded: true, failed: false,
    startedAt: 1_000 + counter, ...extra,
  };
}

const edit = (path: string, extra: Partial<TurnToolEvent> = {}) =>
  call('edit', { name: 'Edit', paths: [path], ...extra });
const repeat = (count: number, make: () => TurnToolEvent) => Array.from({ length: count }, make);

describe('formatTurnDuration', () => {
  it.each([
    [999, ''],
    [1_000, '1 s'],
    [12_000, '12 s'],
    [59_400, '59 s'],
    [59_600, '1 m'],
    [74_000, '1 m 14 s'],
    [134_000, '2 m 14 s'],
    [3_600_000, '1 h'],
    [3_900_000, '1 h 5 m'],
  ])('%i ms reads %p', (ms, text) => {
    expect(formatTurnDuration(ms)).toBe(text);
  });
});

describe('summariseTurn', () => {
  it('stays quiet when no tool ran and the turn was short', () => {
    expect(summariseTurn([], 3_000)).toBeNull();
    expect(summariseTurn([], QUIET_TURN_MS - 1)).toBeNull();
  });

  it('shows only the time when no tool ran but the turn took ten seconds or more', () => {
    const summary = summariseTurn([], QUIET_TURN_MS)!;
    expect(summary.text).toBe('10 s');
    expect(summary.segments).toEqual([]);
    expect(summary.failed).toBe(0);
  });

  it('shows a row for a short turn when tools ran', () => {
    expect(summariseTurn([call('read', { paths: ['a.ts'] })], 2_000)!.text).toBe('2 s · read 1 file');
  });

  it('leaves the time out when the turn lasted under a second', () => {
    expect(summariseTurn([call('command')], 400)!.text).toBe('ran 1 command');
  });

  it('says ran, not failed, for a command that exited non-zero with neutral published outcomes', () => {
    const messages: ToolEventMessage[] = [
      { id: 'u1', timestamp: 1_000, type: 'tool_use', content: 'Using tool',
        metadata: { id: 'c1', name: 'Bash', input: { command: 'rg absent src' }, streaming: true, phase: 'running' } },
      { id: 'r1', timestamp: 2_000, type: 'tool_result', content: '',
        metadata: { id: 'c1', name: 'Bash', command: 'rg absent src', exitCode: 1, status: 'failed',
          is_error: false, isCheck: false, checkFailed: false } },
    ];
    const summary = summariseTurn(collectTurnToolEvents(messages), 12_000)!;
    expect(summary.text).toBe('12 s · ran 1 command');
    expect(summary.failed).toBe(0);
  });

  it('writes the plan example: time, edits with lines, reads, commands and one failure', () => {
    const events = [
      edit('src/a.ts', { added: 12, removed: 1 }),
      edit('src/b.ts', { added: 6, removed: 2 }),
      ...['one.ts', 'two.ts', 'three.ts', 'four.ts'].map((path) => call('read', { paths: [path] })),
      call('command'),
      call('command'),
      call('command', { failed: true }),
    ];
    const summary = summariseTurn(events, 12_000)!;
    expect(summary.text).toBe('12 s · edited 2 files +18 −3 · used 7 other tools · 1 failed');
    expect(summary.segments.map((segment) => segment.kind)).toEqual(['edited', 'other', 'failed']);
    expect(summary.failed).toBe(1);
  });

  it('uses real singular and plural forms', () => {
    const one = summariseTurn([
      edit('a.ts', { added: 1, removed: 0 }), call('read', { paths: ['r.ts'] }), call('command'),
    ], 5_000)!;
    expect(one.text).toBe('5 s · edited 1 file +1 −0 · read 1 file · ran 1 command');
    const many = summariseTurn([
      edit('a.ts', { added: 1, removed: 0 }), edit('b.ts', { added: 1, removed: 0 }),
      ...repeat(2, () => call('command')),
    ], 5_000)!;
    expect(many.text).toBe('5 s · edited 2 files +2 −0 · ran 2 commands');
  });

  it('counts a file edited several times once', () => {
    const summary = summariseTurn([
      edit('a.ts', { added: 1, removed: 1 }), edit('a.ts', { added: 2, removed: 0 }),
    ], 5_000)!;
    expect(summary.segments[0].text).toBe('edited 1 file +3 −1');
  });

  it('leaves the line counts out unless every edit has exact counts', () => {
    const summary = summariseTurn([edit('a.ts', { added: 4, removed: 1 }), edit('b.ts')], 5_000)!;
    expect(summary.segments[0].text).toBe('edited 2 files');
  });

  it('counts edit calls, not files, when a provider gave no file name', () => {
    const summary = summariseTurn([call('edit', { name: 'edit' }), call('edit', { name: 'edit' })], 5_000)!;
    expect(summary.segments[0].text).toBe('made 2 edits');
    expect(summariseTurn([call('edit', { name: 'edit' })], 5_000)!.segments[0].text).toBe('made 1 edit');
  });

  it('counts reads of unnamed files by call', () => {
    expect(summariseTurn([call('read'), call('read')], 5_000)!.segments[0].text).toBe('2 reads');
    expect(summariseTurn([call('read')], 5_000)!.segments[0].text).toBe('1 read');
  });

  it('does not count a failed edit as an edit that happened', () => {
    const summary = summariseTurn([
      edit('a.ts', { added: 1, removed: 0 }),
      edit('b.ts', { failed: true, added: 9, removed: 9 }),
    ], 5_000)!;
    expect(summary.text).toBe('5 s · edited 1 file +1 −0 · 1 failed');
  });

  it('keeps an edit that failed and was then redone, and still reports the failed call', () => {
    const summary = summariseTurn([
      edit('a.ts', { failed: true }), edit('a.ts', { added: 2, removed: 1 }),
    ], 5_000)!;
    expect(summary.text).toBe('5 s · edited 1 file +2 −1 · 1 failed');
  });

  it('adds searches and other tools when there is room', () => {
    const summary = summariseTurn([
      call('search'), call('search'), call('other'),
    ], 5_000)!;
    expect(summary.text).toBe('5 s · searched 2 times · used 1 other tool');
  });

  it('never shows more than four segments, merges the rest, and keeps the failure count', () => {
    const events = [
      edit('a.ts', { added: 1, removed: 0 }),
      call('read', { paths: ['r.ts'] }),
      call('command'),
      call('command', { failed: true }),
      call('search'),
      call('search'),
      call('other'),
    ];
    const summary = summariseTurn(events, 30_000)!;
    expect(summary.text.split(' · ').length).toBeLessThanOrEqual(MAX_SUMMARY_SEGMENTS);
    expect(summary.segments.at(-1)).toMatchObject({ kind: 'failed', text: '1 failed', count: 1 });
    expect(summary.text).toBe('30 s · edited 1 file +1 −0 · used 6 other tools · 1 failed');
  });

  it('merges without a failure segment into at most four segments too', () => {
    const summary = summariseTurn([
      edit('a.ts', { added: 1, removed: 0 }), call('read', { paths: ['r'] }), call('command'),
      call('search'), call('other'),
    ], 5_000)!;
    expect(summary.segments).toHaveLength(3);
    expect(summary.segments.map((segment) => segment.kind)).toEqual(['edited', 'ran', 'other']);
    expect(summary.segments[2].text).toBe('used 3 other tools');
  });

  it('reports failures on their own when nothing else ran', () => {
    const summary = summariseTurn([call('command', { failed: true }), call('command', { failed: true })], 5_000)!;
    expect(summary.text).toBe('5 s · ran 2 commands · 2 failed');
  });

  it('does not count a command that ran and exited non-zero as a failure', () => {
    const summary = summariseTurn([call('command', { exitCode: 1, failed: false })], 5_000)!;
    expect(summary.failed).toBe(0);
    expect(summary.text).not.toContain('failed');
  });
});

describe('describeEditFailure', () => {
  it.each([
    ['EACCES: permission denied, open /x', 'Harness was not allowed to change the file'],
    ['ENOENT: no such file or directory', 'the file was not found'],
    ['File does not exist.', 'the file was not found'],
    ['String to replace not found in file.', 'the text to change was not found in the file'],
    ['old_string did not match', 'the text to change was not found in the file'],
    ['Found 3 matches of the string to replace, but replace_all is false', 'the text to change appears more than once'],
    ['The user declined this change', 'the change was declined'],
    ['file too large to edit', 'the file is too large'],
    ['something odd', 'the tool reported an error'],
    ['', 'the tool reported an error'],
  ])('%j → %s', (raw, reason) => {
    expect(describeEditFailure(raw)).toBe(reason);
  });

  it('never puts the raw text into the reason', () => {
    expect(describeEditFailure('permission denied: token=PLACEHOLDER')).not.toContain('PLACEHOLDER');
  });
});

describe('findEditFailureWarning', () => {
  const gates = { hasFinalReply: true, interrupted: false };
  const failedEdit = (path: string, failureText = 'old_string not found', extra: Partial<TurnToolEvent> = {}) =>
    edit(path, { failed: true, failureText, ...extra });

  it('warns about a failed edit that nothing redid, in the plan wording', () => {
    const warning = findEditFailureWarning([failedEdit('src/a.ts')], gates)!;
    expect(warning.count).toBe(1);
    expect(warning.text).toBe(
      '1 edit failed and was not retried: src/a.ts (the text to change was not found in the file). '
      + 'Check before trusting the summary.',
    );
    expect(warning.items[0]).toMatchObject({ path: 'src/a.ts', retried: false, detail: 'old_string not found' });
  });

  it('counts several failed edits and lists their files', () => {
    const warning = findEditFailureWarning([
      failedEdit('a.ts', 'ENOENT: no such file'),
      failedEdit('b.ts', 'permission denied'),
    ], gates)!;
    expect(warning.text).toBe(
      '2 edits failed and were not retried: a.ts (the file was not found), '
      + 'b.ts (Harness was not allowed to change the file). Check before trusting the summary.',
    );
  });

  it('lists a file once when two edits to it failed', () => {
    const warning = findEditFailureWarning([failedEdit('a.ts'), failedEdit('a.ts')], gates)!;
    expect(warning.count).toBe(2);
    expect(warning.text.startsWith('2 edits failed')).toBe(true);
    expect(warning.text.match(/a\.ts/g)).toHaveLength(1);
    expect(warning.text).toContain('after a retry');
  });

  it('shortens a long list', () => {
    const warning = findEditFailureWarning(
      ['a', 'b', 'c', 'd', 'e'].map((name) => failedEdit(`${name}.ts`)), gates)!;
    expect(warning.text).toContain('a.ts (');
    expect(warning.text).toContain('c.ts (');
    expect(warning.text).not.toContain('d.ts');
    expect(warning.text).toContain('and 2 more');
  });

  it('clears when a later write to the same file succeeded', () => {
    expect(findEditFailureWarning([failedEdit('a.ts'), edit('a.ts', { added: 1, removed: 0 })], gates)).toBeNull();
  });

  it('keeps the warning until a later write has an observed successful outcome', () => {
    expect(findEditFailureWarning([failedEdit('a.ts'), edit('a.ts', { settled: false })], gates)).not.toBeNull();
  });

  it('does not clear a failure when the later write was cancelled or had no successful outcome', () => {
    expect(findEditFailureWarning([failedEdit('a.ts'), edit('a.ts', { succeeded: false })], gates)).not.toBeNull();
    expect(findEditFailureWarning([failedEdit('a.ts'), edit('a.ts', { succeeded: undefined })], gates)).not.toBeNull();
  });

  it('treats the same file under an absolute and a relative path as one file', () => {
    const events = [failedEdit('/repo/src/a.ts'), edit('src/a.ts')];
    expect(findEditFailureWarning(events, { ...gates, cwd: '/repo' })).toBeNull();
    expect(findEditFailureWarning(events, gates)).not.toBeNull();
  });

  it('keeps the warning when the only later write to the file also failed, and says so', () => {
    const warning = findEditFailureWarning([failedEdit('a.ts'), failedEdit('a.ts', 'permission denied')], gates)!;
    expect(warning.items.every((item) => item.retried)).toBe(true);
    expect(warning.text).toContain('failed, even after a retry: a.ts');
  });

  it('says "not fixed" when some failed files were retried and others were not', () => {
    const warning = findEditFailureWarning([
      failedEdit('a.ts'), failedEdit('a.ts'), failedEdit('b.ts'),
    ], gates)!;
    expect(warning.text).toContain('were not fixed: a.ts');
  });

  it('does not clear a failure with a write to a different file', () => {
    const warning = findEditFailureWarning([failedEdit('a.ts'), edit('b.ts')], gates)!;
    expect(warning.items.map((item) => item.path)).toEqual(['a.ts']);
  });

  it('does not clear a failure with a write that came before it', () => {
    expect(findEditFailureWarning([edit('a.ts'), failedEdit('a.ts')], gates)).not.toBeNull();
  });

  it('clears when a later command that writes to the file succeeded', () => {
    const redo = call('command', { command: "sed -i 's/a/b/' src/a.ts", exitCode: 0 });
    expect(findEditFailureWarning([failedEdit('src/a.ts'), redo], gates)).toBeNull();
    const readOnly = call('command', { command: 'cat src/a.ts' });
    expect(findEditFailureWarning([failedEdit('src/a.ts'), readOnly], gates)).not.toBeNull();
    const failedRedo = call('command', { command: "sed -i 's/a/b/' src/a.ts", failed: true });
    expect(findEditFailureWarning([failedEdit('src/a.ts'), failedRedo], gates)).not.toBeNull();
  });

  it('requires an explicit destination, not a matching basename or a command input', () => {
    for (const command of ['cp src/a.ts other.ts', "sed -i 's/a/b/' other/a.ts", 'echo fixed > other/a.ts', 'false || tee src/a.ts', 'echo "text > src/a.ts "', 'cp --help src/a.ts', 'tee --help src/a.ts', 'truncate --help src/a.ts', 'dd --help of=src/a.ts', String.raw`echo \>src/a.ts`]) {
      expect(findEditFailureWarning([failedEdit('src/a.ts'), call('command', { command, exitCode: 0 })], gates)).not.toBeNull();
    }
    expect(findEditFailureWarning([failedEdit('src/a.ts'), call('command', { command: 'cp other.ts src/a.ts', exitCode: 0 })], gates)).toBeNull();
  });

  it.each([
    "printf ' > src/a.ts ' > report.log",
    'printf " > src/a.ts " > report.log',
    'echo ok # > src/a.ts',
    'cp -n other.ts src/a.ts',
    'cp --no-clobber other.ts src/a.ts',
  ])('does not treat quoted text, comments or a skipped copy as a write: %s', command => {
    expect(findEditFailureWarning([
      failedEdit('src/a.ts'), call('command', { command, exitCode: 0 }),
    ], gates)).not.toBeNull();
  });

  it('keeps a failure whose file is unknown, without claiming it was not retried', () => {
    const warning = findEditFailureWarning([call('edit', { name: 'edit', failed: true, failureText: 'denied' })], gates)!;
    expect(warning.text).toBe('1 edit failed and was not completed: a file (the tool reported an error). '
      + 'Check before trusting the summary.');
  });

  it('stays quiet without a final text reply', () => {
    expect(findEditFailureWarning([failedEdit('a.ts')], { hasFinalReply: false, interrupted: false })).toBeNull();
  });

  it('stays quiet when the turn was interrupted', () => {
    expect(findEditFailureWarning([failedEdit('a.ts')], { hasFinalReply: true, interrupted: true })).toBeNull();
  });

  it('ignores failed commands, reads and other tools', () => {
    expect(findEditFailureWarning([
      call('command', { failed: true }), call('read', { failed: true }), call('other', { failed: true }),
    ], gates)).toBeNull();
  });

  it('keeps raw detail for the Details view but out of the sentence', () => {
    const warning = findEditFailureWarning([failedEdit('a.ts', 'permission denied: token=PLACEHOLDER')], gates)!;
    expect(warning.text).not.toContain('PLACEHOLDER');
    expect(warning.items[0].detail).toContain('PLACEHOLDER');
  });
});
