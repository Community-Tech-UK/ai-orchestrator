import { describe, expect, it } from 'vitest';
import {
  classifyToolKind,
  collectTurnToolEvents,
  countFailedToolCalls,
  normaliseToolPath,
  type ToolEventMessage,
} from './turn-tool-events';

let nextId = 0;

function message(
  type: ToolEventMessage['type'],
  metadata: Record<string, unknown> | undefined,
  content = '',
  timestamp = 1_000 + nextId * 10,
): ToolEventMessage {
  nextId += 1;
  return { id: `m${nextId}`, timestamp, type, content, metadata };
}

const use = (metadata: Record<string, unknown>, timestamp?: number) =>
  message('tool_use', metadata, 'Using tool', timestamp);
const result = (metadata: Record<string, unknown>, content = '', timestamp?: number) =>
  message('tool_result', metadata, content, timestamp);

describe('classifyToolKind', () => {
  it.each([
    ['Edit', 'edit'], ['MultiEdit', 'edit'], ['Write', 'edit'], ['NotebookEdit', 'edit'],
    ['apply_patch', 'edit'], ['editFile', 'edit'], ['createFile', 'edit'],
    ['file_change', 'edit'], ['patch', 'edit'], ['command_execution', 'command'], ['pwsh', 'command'],
    ['Bash', 'command'], ['shell', 'command'], ['runCommand', 'command'],
    ['Read', 'read'], ['read_file', 'read'], ['readFile', 'read'],
    ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['WebSearch', 'search'], ['WebFetch', 'search'],
    ['Task', 'other'], ['TodoWrite', 'other'], ['mcp__github__create_issue', 'other'], ['', 'other'],
  ])('%s is %s', (name, kind) => {
    expect(classifyToolKind(name)).toBe(kind);
  });

  it('reads the ACP tool kind that those adapters put in the name', () => {
    expect(classifyToolKind('execute')).toBe('command');
    expect(classifyToolKind('edit')).toBe('edit');
    expect(classifyToolKind('delete')).toBe('edit');
    expect(classifyToolKind('move')).toBe('edit');
    expect(classifyToolKind('read')).toBe('read');
    expect(classifyToolKind('search')).toBe('search');
    expect(classifyToolKind('fetch')).toBe('search');
    expect(classifyToolKind('think')).toBe('other');
  });
});

describe('normaliseToolPath', () => {
  it('makes paths under the working folder relative and tidies separators', () => {
    expect(normaliseToolPath('/repo/src/a.ts', '/repo')).toBe('src/a.ts');
    expect(normaliseToolPath('./src//a.ts', '/repo')).toBe('src/a.ts');
    expect(normaliseToolPath('src/../src/a.ts', '/repo')).toBe('src/a.ts');
    expect(normaliseToolPath('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts');
  });

  it('keeps paths outside the working folder as they are', () => {
    expect(normaliseToolPath('/elsewhere/b.ts', '/repo')).toBe('/elsewhere/b.ts');
    expect(normaliseToolPath('/repo-two/b.ts', '/repo')).toBe('/repo-two/b.ts');
  });

  it('returns an empty string for blank input', () => {
    expect(normaliseToolPath('   ', '/repo')).toBe('');
  });
});

describe('collectTurnToolEvents — pairing and ids', () => {
  it('pairs a Claude tool start with the outcome record that carries the same tool_use_id', () => {
    const events = collectTurnToolEvents([
      use({ name: 'Edit', id: 'toolu_1', input: { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' } }),
      message('tool_outcome', { tool_use_id: 'toolu_1', is_error: true, name: 'Edit' }, 'old_string not found'),
      use({ name: 'Read', id: 'toolu_2', input: { file_path: '/repo/b.ts' } }),
      message('tool_outcome', { tool_use_id: 'toolu_2', is_error: false, name: 'Read' }),
    ], { cwd: '/repo' });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'toolu_1', kind: 'edit', paths: ['a.ts'], settled: true, failed: true,
      failureText: 'old_string not found',
    });
    expect(events[1]).toMatchObject({ id: 'toolu_2', kind: 'read', paths: ['b.ts'], settled: true, failed: false });
  });

  it('leaves a call unsettled, and never failed, when the provider reports no outcome', () => {
    const [event] = collectTurnToolEvents([use({ name: 'Edit', id: 't1', input: { file_path: 'a.ts' } })]);
    expect(event).toMatchObject({ settled: false, failed: false });
  });

  describe('when a provider reuses its call ids', () => {
    const input = (content: string) => message('user', undefined, content);

    it('keeps the calls of different turns apart (Codex exec numbers its items from zero every run)', () => {
      const events = collectTurnToolEvents([
        input('first'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'ls' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'a'),
        input('second'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'pwd' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'b'),
      ]);
      expect(events.map((event) => [event.command, event.settled])).toEqual([['ls', true], ['pwd', true]]);
    });

    it('does not merge into an earlier call that never got an outcome', () => {
      const events = collectTurnToolEvents([
        input('first'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'ls' } }),
        input('second'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'pwd' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'b'),
      ]);
      expect(events.map((event) => [event.command, event.settled])).toEqual([['ls', false], ['pwd', true]]);
    });

    it('lets a late result reach the open call it belongs to, across a later input', () => {
      const events = collectTurnToolEvents([
        input('first'),
        use({ name: 'Edit', id: 'late', input: { file_path: 'a.ts' } }),
        input('second'),
        message('tool_outcome', { tool_use_id: 'late', is_error: true }, 'old_string not found'),
      ]);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ settled: true, failed: true });
    });

    it('sends a result to the call from the current turn when both turns used the same id', () => {
      const events = collectTurnToolEvents([
        input('first'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'ls' } }),
        input('second'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'pwd' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'b'),
      ]);
      expect(events[0].settled).toBe(false);
      expect(events[1].settled).toBe(true);
    });

    it('treats a start that reuses the id of a finished call in the same turn as a new call', () => {
      const events = collectTurnToolEvents([
        input('go'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'ls' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'a'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'pwd' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'b'),
      ]);
      expect(events.map((event) => event.command)).toEqual(['ls', 'pwd']);
    });

    it('ignores a second copy of a result for a call that has already finished', () => {
      const events = collectTurnToolEvents([
        input('go'),
        use({ name: 'Bash', id: 'item_0', input: { command: 'ls' } }),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'a'),
        result({ name: 'Bash', id: 'item_0', exitCode: 0 }, 'a'),
      ]);
      expect(events).toHaveLength(1);
    });
  });

  it('counts a call once when the provider announces it twice with the same id', () => {
    const events = collectTurnToolEvents([
      use({ name: 'Bash', id: 'item_1', input: { command: 'ls' }, streaming: true }, 1_000),
      use({ name: 'Bash', id: 'item_1', input: { command: 'ls' }, streaming: true }, 1_050),
      result({ name: 'Bash', id: 'item_1', exitCode: 0, status: 'completed', is_error: false }, 'ok', 1_200),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].startedAt).toBe(1_000);
    expect(events[0].endedAt).toBe(1_200);
  });

  it('settles a call from its latest terminal result when a progress copy arrives first', () => {
    const events = collectTurnToolEvents([
      use({ toolCallId: 'c1', name: 'execute', title: 'Run tests', transport: 'acp' }),
      result({ toolCallId: 'c1', status: 'in_progress', transport: 'acp' }, 'partial'),
      result({ toolCallId: 'c1', status: 'completed', is_error: false, transport: 'acp' }, 'done'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ settled: true, failed: false });
  });

  it('does not let a later progress copy undo a terminal failure', () => {
    const [event] = collectTurnToolEvents([
      use({ toolCallId: 'c1', name: 'edit', transport: 'acp' }),
      result({ toolCallId: 'c1', status: 'failed', is_error: true, transport: 'acp' }, 'denied'),
      result({ toolCallId: 'c1', status: 'in_progress', transport: 'acp' }, 'denied'),
    ]);
    expect(event.failed).toBe(true);
  });

  it('pairs by the first id field present across provider spellings', () => {
    const events = collectTurnToolEvents([
      use({ name: 'shell', tool_use_id: 'cur_1', callId: 'cur_1' }),
      result({ name: 'shell', tool_use_id: 'cur_1', is_error: false }),
      use({ name: 'editFile', id: 'cp_1', toolCallId: 'cp_1', input: { path: 'z.ts' } }),
      result({ name: 'editFile', tool_use_id: 'cp_1', is_error: true }),
    ]);
    expect(events.map((event) => [event.id, event.settled, event.failed])).toEqual([
      ['cur_1', true, false],
      ['cp_1', true, true],
    ]);
  });

  it('attaches an id-less result to the oldest open call with the same tool name', () => {
    const events = collectTurnToolEvents([
      use({ toolName: 'read_file' }),
      use({ toolName: 'read_file' }),
      result({ toolName: 'read_file' }, 'first'),
    ]);
    expect(events.map((event) => event.settled)).toEqual([true, false]);
  });

  it('keeps a result whose start was never seen, so the work still counts', () => {
    const events = collectTurnToolEvents([result({ name: 'Bash', id: 'orphan', exitCode: 0 }, 'ok')]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'command', settled: true, failed: false });
  });

  it('records which message opened each call, including a call known only from its result', () => {
    const start = use({ name: 'Bash', id: 'c1', input: { command: 'ls' } });
    const lone = result({ name: 'Bash', id: 'c2', exitCode: 0 }, 'ok');
    const events = collectTurnToolEvents([start, lone]);
    expect(events.map((event) => event.startMessageId)).toEqual([start.id, lone.id]);
  });

  it('gives the same answer when it reads the same messages again', () => {
    const messages = [
      use({ id: 'e', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' } }),
      message('tool_outcome', { tool_use_id: 'e', is_error: false }),
    ];
    const first = collectTurnToolEvents(messages, { cwd: '/repo' });
    const second = collectTurnToolEvents(messages, { cwd: '/repo' });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(first[0]).toMatchObject({ paths: ['a.ts'], added: 2, removed: 1 });
    // A different working folder re-reads the start instead of reusing a stale path.
    expect(collectTurnToolEvents(messages, { cwd: '/other' })[0].paths).toEqual(['/repo/a.ts']);
  });

  it('ignores messages that are not tool traffic', () => {
    const events = collectTurnToolEvents([
      message('assistant', undefined, 'hello'),
      message('system', { kind: 'interrupt-boundary' }),
      message('user', undefined, 'hi'),
    ]);
    expect(events).toEqual([]);
  });

  it('turns a Gemini tool error message into the failed outcome of the open call', () => {
    const events = collectTurnToolEvents([
      use({ toolName: 'edit_file' }),
      message('error', { toolName: 'edit_file' }, 'Tool edit_file failed: no such file'),
    ]);
    expect(events[0]).toMatchObject({ settled: true, failed: true });
    expect(events[0].failureText).toBe('Tool edit_file failed: no such file');
  });

  it('does not count the error message Copilot sends beside a failed result a second time', () => {
    const events = collectTurnToolEvents([
      use({ id: 'cp_9', name: 'editFile', tool_use_id: 'cp_9', input: { path: 'a.ts' } }),
      result({ name: 'editFile', tool_use_id: 'cp_9', is_error: true, toolName: 'editFile' }, 'Tool editFile failed'),
      message('error', { name: 'editFile', tool_use_id: 'cp_9', toolName: 'editFile' }, 'Copilot tool call failed'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].failed).toBe(true);
    expect(countFailedToolCalls([
      use({ id: 'cp_9', name: 'editFile', tool_use_id: 'cp_9' }),
      result({ name: 'editFile', tool_use_id: 'cp_9', is_error: true }),
      message('error', { name: 'editFile', tool_use_id: 'cp_9' }, 'again'),
    ])).toBe(1);
  });
});

describe('collectTurnToolEvents — what counts as a failure', () => {
  const bash = (command: string, extra: Record<string, unknown> = {}, phase = 'running') => [
    use({ id: `b-${command}`, name: 'Bash', input: { command }, streaming: true, phase }),
    result({ id: `b-${command}`, name: 'Bash', command, status: 'completed', ...extra }, ''),
  ];

  it('treats a search that found nothing as neutral even when the older metadata flags exit 1 as an error', () => {
    const [event] = collectTurnToolEvents(bash('rg missing src', { exitCode: 1, is_error: true }));
    expect(event).toMatchObject({ kind: 'command', exitCode: 1, failed: false });
  });

  it('treats a search that found nothing as neutral under the new command metadata too', () => {
    const [event] = collectTurnToolEvents(bash('rg missing src', {
      exitCode: 1, is_error: false, isCheck: false, checkFailed: false,
    }));
    expect(event.failed).toBe(false);
  });

  it('keeps a non-zero exit neutral when the status word says failed but the producer published neutral flags', () => {
    const [event] = collectTurnToolEvents(bash('rg absent src', {
      exitCode: 1, status: 'failed', is_error: false, isCheck: false, checkFailed: false,
    }));
    expect(event).toMatchObject({ kind: 'command', exitCode: 1, failed: false });
  });

  it('honours an explicit checkFailed=false over deriving failure from a check’s non-zero exit', () => {
    const [event] = collectTurnToolEvents(bash('git pull && npm test', {
      exitCode: 1, is_error: false, isCheck: true, checkFailed: false,
    }));
    expect(event).toMatchObject({ exitCode: 1, failed: false });
  });

  it('fails a command the provider marked as a check when it exits non-zero', () => {
    const [legacy] = collectTurnToolEvents(bash('npm test', { exitCode: 1, is_error: true }, 'verifying'));
    expect(legacy.failed).toBe(true);
    const [modern] = collectTurnToolEvents(bash('npm test', {
      exitCode: 2, is_error: false, isCheck: true, checkFailed: true,
    }));
    expect(modern.failed).toBe(true);
    const [derived] = collectTurnToolEvents(bash('npm test', { exitCode: 2, is_error: false, isCheck: true }));
    expect(derived.failed).toBe(true);
  });

  it('passes a check that exits zero', () => {
    const [event] = collectTurnToolEvents(bash('npm test', {
      exitCode: 0, is_error: false, isCheck: true, checkFailed: false,
    }, 'verifying'));
    expect(event.failed).toBe(false);
  });

  it('does not infer a check from the command text', () => {
    const [event] = collectTurnToolEvents(bash('npm test', { exitCode: 1, is_error: false, isCheck: false }));
    expect(event.failed).toBe(false);
  });

  it('fails a command that could not run', () => {
    const [failedStatus] = collectTurnToolEvents(bash('make', { status: 'failed' }));
    expect(failedStatus.failed).toBe(true);
    const [declined] = collectTurnToolEvents(bash('make', { status: 'declined' }));
    expect(declined.failed).toBe(true);
    const [noExit] = collectTurnToolEvents(bash('make', { is_error: true }));
    expect(noExit.failed).toBe(true);
    const [modernCannotRun] = collectTurnToolEvents(bash('make', { is_error: true, isCheck: false }));
    expect(modernCannotRun.failed).toBe(true);
  });

  it('reads the exit code under either spelling', () => {
    const [snake] = collectTurnToolEvents([
      use({ toolCallId: 'g1', name: 'execute', transport: 'acp' }),
      result({ toolCallId: 'g1', status: 'completed', is_error: true, exit_code: 2, transport: 'acp' }),
    ]);
    expect(snake.exitCode).toBe(2);
    expect(snake.failed).toBe(false);
  });

  it('fails an edit or write that errored, on every provider shape', () => {
    const codex = collectTurnToolEvents([
      use({ id: 'f1', name: 'Edit', input: { file_path: '/repo/a.ts' }, streaming: true }),
      result({ id: 'f1', name: 'Edit', path: '/repo/a.ts', status: 'failed', is_error: true }, 'File change failed: a.ts'),
    ], { cwd: '/repo' });
    expect(codex[0]).toMatchObject({ kind: 'edit', failed: true, paths: ['a.ts'] });
    const acp = collectTurnToolEvents([
      use({ toolCallId: 'a1', name: 'edit', transport: 'acp' }),
      result({ toolCallId: 'a1', status: 'failed', is_error: true, transport: 'acp' }, 'denied'),
    ]);
    expect(acp[0]).toMatchObject({ kind: 'edit', failed: true });
  });

  it('does not count a failed read, search or other tool as a failure', () => {
    const events = collectTurnToolEvents([
      use({ id: 'r1', name: 'Read', input: { file_path: 'missing.ts' } }),
      result({ id: 'r1', name: 'Read', is_error: true }, 'File does not exist'),
      use({ id: 's1', name: 'Grep', input: { pattern: 'x' } }),
      result({ id: 's1', name: 'Grep', is_error: true }),
      use({ id: 'o1', name: 'mcp__x__y' }),
      result({ id: 'o1', name: 'mcp__x__y', is_error: true }),
    ]);
    expect(events.every((event) => !event.failed)).toBe(true);
    expect(countFailedToolCalls([
      use({ id: 'r1', name: 'Read' }), result({ id: 'r1', name: 'Read', is_error: true }),
    ])).toBe(0);
  });

  it('counts failed calls across a whole message list', () => {
    const failingBash = [
      use({ id: 'c1', name: 'Bash', input: { command: 'x' } }),
      result({ id: 'c1', name: 'Bash', status: 'failed', is_error: true }),
    ];
    expect(countFailedToolCalls([
      use({ id: 'e1', name: 'Edit', input: { file_path: 'a.ts' } }),
      message('tool_outcome', { tool_use_id: 'e1', is_error: true }, 'nope'),
      use({ id: 'e2', name: 'Write', input: { file_path: 'b.ts' } }),
      message('tool_outcome', { tool_use_id: 'e2', is_error: false }),
      ...failingBash,
    ])).toBe(2);
  });
});

describe('collectTurnToolEvents — paths and lines', () => {
  it('reads the path for each provider spelling', () => {
    const events = collectTurnToolEvents([
      use({ id: '1', name: 'Write', input: { file_path: '/repo/new.ts', content: 'a\nb\n' } }),
      use({ id: '2', name: 'NotebookEdit', input: { notebook_path: '/repo/n.ipynb' } }),
      use({ id: '3', name: 'write_file', input: { path: 'p.ts' } }),
      use({ id: '4', name: 'editFile', input: { filePath: 'q.ts' } }),
      use({ id: '5', name: 'Edit', input: { changes: [{ path: 'x.ts' }, { path: 'y.ts', kind: 'add' }] } }),
      use({ id: '6', name: 'apply_patch', input: { patch: '*** Begin Patch\n--- a/old.ts\n+++ b/src/patched.ts\n@@\n-a\n+b\n' } }),
    ], { cwd: '/repo' });
    expect(events.map((event) => event.paths)).toEqual([
      ['new.ts'], ['n.ipynb'], ['p.ts'], ['q.ts'], ['x.ts', 'y.ts'], ['src/patched.ts'],
    ]);
  });

  it('collects every file a MultiEdit touches', () => {
    const [event] = collectTurnToolEvents([
      use({ id: 'm', name: 'MultiEdit', input: { file_path: 'a.ts', edits: [{ old_string: 'a', new_string: 'b' }] } }),
    ]);
    expect(event.paths).toEqual(['a.ts']);
  });

  it('takes a path from the result when the start carried none', () => {
    const [event] = collectTurnToolEvents([
      use({ id: 'x', name: 'Edit', streaming: true }),
      result({ id: 'x', name: 'Edit', path: '/repo/late.ts', status: 'completed', is_error: false }, 'File modified: late.ts'),
    ], { cwd: '/repo' });
    expect(event.paths).toEqual(['late.ts']);
  });

  it('counts the lines of an exact Edit replacement, ignoring unchanged context lines', () => {
    const [event] = collectTurnToolEvents([
      use({
        id: 'e', name: 'Edit',
        input: { file_path: 'a.ts', old_string: 'ctx1\nold line\nctx2', new_string: 'ctx1\nnew line\nextra\nctx2' },
      }),
    ]);
    expect(event).toMatchObject({ added: 2, removed: 1 });
  });

  it('sums the exact replacements inside a MultiEdit', () => {
    const [event] = collectTurnToolEvents([
      use({
        id: 'me', name: 'MultiEdit',
        input: {
          file_path: 'a.ts',
          edits: [
            { old_string: 'one', new_string: 'uno' },
            { old_string: 'two\nthree', new_string: 'dos' },
          ],
        },
      }),
    ]);
    expect(event).toMatchObject({ added: 2, removed: 3 });
  });

  it('gives no line counts for a Write, because its input does not say whether it replaced a file', () => {
    const [event] = collectTurnToolEvents([
      use({ id: 'w', name: 'Write', input: { file_path: 'n.ts', content: 'a\nb\nc\n' } }),
    ]);
    expect(event.added).toBeUndefined();
    expect(event.removed).toBeUndefined();
  });

  it('counts plus and minus lines in the unified diffs Codex attaches to file changes', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '@@ -1,3 +1,4 @@', ' keep', '-gone', '+one', '+two', ' keep'].join('\n');
    const [event] = collectTurnToolEvents([
      use({ id: 'cx', name: 'Edit', input: { changes: [{ path: 'x.ts', kind: 'update', diff }] } }),
    ]);
    expect(event).toMatchObject({ added: 2, removed: 1 });
  });

  it('gives no line counts when a call has no diff to count from', () => {
    const [event] = collectTurnToolEvents([use({ toolCallId: 'a', name: 'edit', transport: 'acp' })]);
    expect(event.added).toBeUndefined();
  });

  it('keeps the command text and tolerates a command-less tool', () => {
    const events = collectTurnToolEvents([
      use({ id: 'c', name: 'Bash', input: { command: 'npm run lint' } }),
      use({ id: 'd', name: 'Bash' }),
    ]);
    expect(events[0].command).toBe('npm run lint');
    expect(events[1].command).toBeUndefined();
  });

  it('bounds the failure text it keeps', () => {
    const [event] = collectTurnToolEvents([
      use({ id: 'big', name: 'Edit', input: { file_path: 'a.ts' } }),
      result({ id: 'big', name: 'Edit', is_error: true }, `bad ${'x'.repeat(5_000)}`),
    ]);
    expect(event.failureText!.length).toBeLessThanOrEqual(600);
  });
});
