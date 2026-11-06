import { isToolResultFailed } from '../../../shared/tool-outcome';
import { describe, expect, it } from 'vitest';
import {
  ACP_RAW_OUTPUT_MAX_CHARS,
  buildAcpToolCallArguments,
  buildAcpToolOutcomeFallback,
  buildAcpToolResultMessage,
  isAcpTerminalToolStatus,
  renderAcpRawOutput,
} from './acp-tool-call-material';

describe('buildAcpToolCallArguments', () => {
  it('drops an empty or missing rawInput and keeps a populated one', () => {
    expect(buildAcpToolCallArguments('search', {})).toEqual({ kind: 'search' });
    expect(buildAcpToolCallArguments('read', undefined)).toEqual({ kind: 'read' });
    expect(buildAcpToolCallArguments('execute', { command: 'ls' })).toEqual({
      kind: 'execute',
      rawInput: { command: 'ls' },
    });
  });
});

describe('renderAcpRawOutput', () => {
  it('returns empty text when there is nothing to render', () => {
    expect(renderAcpRawOutput(undefined)).toBe('');
    expect(renderAcpRawOutput({})).toBe('');
    expect(renderAcpRawOutput('text')).toBe('');
  });

  it('prefers a string content field (Cursor Read File)', () => {
    expect(renderAcpRawOutput({ content: 'alpha\nbeta\n' })).toBe('alpha\nbeta\n');
  });

  it('renders execute output with stderr and a non-zero exit code', () => {
    expect(renderAcpRawOutput({ exitCode: 0, stdout: '2 notes.txt\n', stderr: '' })).toBe('2 notes.txt\n');
    expect(renderAcpRawOutput({ exitCode: 1, stdout: '', stderr: 'boom' })).toBe('--- stderr ---\nboom\n(exit code 1)');
  });

  it('falls back to JSON for structured results (Cursor grep)', () => {
    expect(renderAcpRawOutput({ totalMatches: 2, truncated: false })).toBe('{"totalMatches":2,"truncated":false}');
  });

  it('truncates oversized renderings with a marker', () => {
    const rendered = renderAcpRawOutput({ content: 'x'.repeat(ACP_RAW_OUTPUT_MAX_CHARS + 10) });
    expect(rendered.startsWith('x'.repeat(ACP_RAW_OUTPUT_MAX_CHARS))).toBe(true);
    expect(rendered.endsWith('[truncated 10 chars]')).toBe(true);
  });
});

describe('isAcpTerminalToolStatus', () => {
  it('treats only completed, failed and cancelled as settled', () => {
    expect(['completed', 'failed', 'cancelled'].map(isAcpTerminalToolStatus)).toEqual([true, true, true]);
    expect(['pending', 'in_progress', ''].map(isAcpTerminalToolStatus)).toEqual([false, false, false]);
  });
});

describe('buildAcpToolResultMessage', () => {
  const base = { toolCallId: 'c1', title: 'Run tests', sessionUpdate: 'tool_call_update', output: '12 passing' };

  it('builds a correlated tool_result carrying is_error only for a success or failure', () => {
    expect(buildAcpToolResultMessage({ ...base, status: 'failed' }, 'm1', 5)).toEqual({
      id: 'm1',
      timestamp: 5,
      type: 'tool_result',
      content: '12 passing',
      metadata: {
        sessionUpdate: 'tool_call_update', toolCallId: 'c1', title: 'Run tests',
        status: 'failed', transport: 'acp', is_error: true,
      },
    });
    expect(buildAcpToolResultMessage({ ...base, status: 'completed' }, 'm2', 6).metadata)
      .toMatchObject({ is_error: false });
    expect(buildAcpToolResultMessage({ ...base, status: 'cancelled' }, 'm3', 7).metadata).not.toHaveProperty('is_error');
    expect(buildAcpToolResultMessage({ ...base, status: 'in_progress' }, 'm4', 8).metadata).not.toHaveProperty('is_error');
  });

  // U1 step 5: the exit status of a command that ran is recorded, not judged. (This
  // case used to assert `is_error: true` for any non-zero exit.)
  it('records a completed command exit status without calling a non-zero one an error', () => {
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: { exitCode: 2 } }, 'm5', 9).metadata)
      .toMatchObject({ is_error: false, exitCode: 2, isCheck: false, checkFailed: false });
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: { exitCode: 0 } }, 'm6', 10).metadata)
      .toMatchObject({ is_error: false, exitCode: 0 });
    expect(buildAcpToolResultMessage({ ...base, status: 'cancelled', rawOutput: { exitCode: 2 } }, 'm7', 11).metadata)
      .not.toHaveProperty('is_error');
    expect(buildAcpToolResultMessage({ ...base, status: 'cancelled', rawOutput: { exitCode: 2 } }, 'm7', 11).metadata)
      .not.toHaveProperty('exitCode');
  });

  // LT-612 wire capture, 2026-09-24: `grok agent stdio`'s terminal `tool_call_update`
  // for a failing `execute` reports the exit status as `rawOutput.exit_code` (snake_case),
  // never `rawOutput.exitCode` (camelCase, which is what cursor-agent sends). The shape
  // below is a trimmed, path-anonymised copy of the real payload for
  // `/usr/bin/grep --bogus-flag needle haystack.txt` (exit 2) and
  // `/usr/bin/grep -F needle haystack.txt` (exit 0). Grok also reports `signal` and
  // `timed_out` explicitly, which is the only evidence this layer accepts for "killed".
  const grokFailedRawOutput = {
    type: 'Bash',
    output_for_prompt: "exit: 2\ngrep: unrecognized option `--bogus-flag'\n",
    exit_code: 2,
    command: '/usr/bin/grep --bogus-flag needle haystack.txt',
    truncated: false,
    signal: null,
    timed_out: false,
    current_dir: '/tmp/lt0924-grok-acp/ws1',
  };
  const grokSucceededRawOutput = {
    type: 'Bash',
    output_for_prompt: 'exit: 0\nneedle here\n',
    exit_code: 0,
    command: '/usr/bin/grep -F needle haystack.txt',
    truncated: false,
    signal: null,
    timed_out: false,
    current_dir: '/tmp/lt0924-grok-acp/ws2',
  };

  it('records a completed Grok command snake_case exit_code and leaves a non-zero one neutral', () => {
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: grokFailedRawOutput }, 'm8', 14).metadata)
      .toMatchObject({ is_error: false, exitCode: 2, isCheck: false, checkFailed: false });
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: grokSucceededRawOutput }, 'm9', 15).metadata)
      .toMatchObject({ is_error: false, exitCode: 0 });
    const cancelled = buildAcpToolResultMessage({ ...base, status: 'cancelled', rawOutput: grokFailedRawOutput }, 'm10', 16).metadata;
    expect(cancelled).not.toHaveProperty('is_error');
    expect(cancelled).not.toHaveProperty('exitCode');
  });

  describe('shared command outcome rule (Cursor, Grok, Copilot, OpenCode)', () => {
    const execute = { ...base, kind: 'execute' as const };

    it('marks a red test run a failed check, still not a transport error', () => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawInput: { command: 'npm test' }, rawOutput: { exitCode: 1, stdout: '', stderr: '1 failing' },
      }, 'c1', 1).metadata;
      expect(metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: true });
    });

    it('leaves a search that found nothing neutral', () => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawInput: { command: 'rg missing src' }, rawOutput: { exitCode: 1, stdout: '', stderr: '' },
      }, 'c2', 1).metadata;
      expect(metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: false, checkFailed: false });
    });

    it('takes the command from the Grok rawOutput when the call carries no rawInput', () => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawOutput: { ...grokFailedRawOutput, command: 'npx vitest run', exit_code: 1 },
      }, 'c3', 1).metadata;
      expect(metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: true });
    });

    it('does not blame a failing earlier step in the chain on the test run', () => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawInput: { command: 'git pull && npm test' }, rawOutput: { exitCode: 1 },
      }, 'c4', 1).metadata;
      expect(metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: false });
    });

    it.each([124, 127, 137])('keeps a voluntary exit %i neutral', (exitCode) => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'completed', rawInput: { command: './deploy.sh' }, rawOutput: { exitCode },
      }, 'c5', 1).metadata;
      expect(metadata).toMatchObject({ is_error: false, exitCode });
    });

    it('calls a command an error when the server reports a timeout or a signal', () => {
      expect(buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawOutput: { ...grokFailedRawOutput, exit_code: 124, timed_out: true },
      }, 'c6', 1).metadata).toMatchObject({ is_error: true, exitCode: 124 });
      expect(buildAcpToolResultMessage({
        ...execute, status: 'completed',
        rawOutput: { ...grokFailedRawOutput, exit_code: 137, signal: 'SIGKILL' },
      }, 'c7', 1).metadata).toMatchObject({ is_error: true, exitCode: 137 });
    });

    it('calls a failed command with no exit status an error, and one with an exit status neutral', () => {
      expect(buildAcpToolResultMessage({ ...execute, status: 'failed', rawInput: { command: 'ls' } }, 'c8', 1).metadata)
        .toMatchObject({ is_error: true, isCheck: false, checkFailed: false });
      const withExit = buildAcpToolResultMessage({
        ...execute, status: 'failed', rawInput: { command: 'ls' }, rawOutput: { exitCode: 2 },
      }, 'c9', 1).metadata;
      expect(withExit).toMatchObject({ is_error: false, exitCode: 2 });
    });

    it('treats a call as a command by its exit status or command string even when the kind is unhelpful', () => {
      expect(buildAcpToolResultMessage({
        ...base, kind: 'other', status: 'completed', rawOutput: { exit_code: 3 },
      }, 'c10', 1).metadata).toMatchObject({ is_error: false, exitCode: 3 });
      expect(buildAcpToolResultMessage({
        ...base, kind: 'other', status: 'completed', rawInput: { command: ['npm', 'run', 'lint'] },
      }, 'c11', 1).metadata).toMatchObject({ is_error: false, isCheck: true, checkFailed: false });
    });

    it('keeps genuine failed edits and other non-command failures as errors, with no command fields', () => {
      const editFailed = buildAcpToolResultMessage({ ...base, kind: 'edit', status: 'failed', rawInput: { path: 'a.ts' } }, 'c12', 1).metadata;
      expect(editFailed).toMatchObject({ is_error: true });
      expect(editFailed).not.toHaveProperty('exitCode');
      expect(editFailed).not.toHaveProperty('isCheck');
      const searchFailed = buildAcpToolResultMessage({ ...base, kind: 'search', status: 'failed' }, 'c13', 1).metadata;
      expect(searchFailed).toMatchObject({ is_error: true });
      expect(buildAcpToolResultMessage({ ...base, kind: 'edit', status: 'completed' }, 'c14', 1).metadata)
        .toMatchObject({ is_error: false });
    });

    it('records nothing for an unsettled call', () => {
      const metadata = buildAcpToolResultMessage({
        ...execute, status: 'in_progress', rawInput: { command: 'npm test' }, rawOutput: { exitCode: 0 },
      }, 'c15', 1).metadata;
      expect(metadata).not.toHaveProperty('is_error');
      expect(metadata).not.toHaveProperty('exitCode');
    });
  });
});

describe('buildAcpToolOutcomeFallback', () => {
  it('records a silent non-zero command exit as a neutral outcome, not a failure', () => {
    const outcome = buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'completed', hasRenderedOutput: false,
      rawOutput: { exitCode: 2 },
    }, 'm1', 12);
    expect(outcome?.metadata).toMatchObject({ tool_use_id: 'c1', is_error: false });
    expect(buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'cancelled', hasRenderedOutput: false,
      rawOutput: { exitCode: 2 },
    }, 'm2', 13)).toBeNull();
  });

  it('records a silent red test run as failed, so the miner never mistakes it for a fix', () => {
    const outcome = buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'completed', hasRenderedOutput: false,
      kind: 'execute', rawInput: { command: 'npm test' }, rawOutput: { exit_code: 2 },
    }, 'm3', 17);
    expect(outcome?.metadata).toMatchObject({ tool_use_id: 'c1', is_error: false, exitCode: 2, isCheck: true, checkFailed: true });
    expect(isToolResultFailed('execute', outcome?.metadata)).toBe(true);
  });

  it('records a silent command that the server says failed without an exit status as failed', () => {
    const outcome = buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run it', status: 'failed', hasRenderedOutput: false,
      kind: 'execute', rawInput: { command: 'ls' },
    }, 'm4', 18);
    expect(outcome?.metadata).toMatchObject({ tool_use_id: 'c1', is_error: true });
  });

  it('stays out of the way when the visible result already covered the call', () => {
    expect(buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'completed', hasRenderedOutput: true,
    }, 'm5', 19)).toBeNull();
  });
});
