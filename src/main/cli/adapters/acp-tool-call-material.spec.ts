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

  it('marks a completed command with a nonzero exit code as failed', () => {
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: { exitCode: 2 } }, 'm5', 9).metadata)
      .toMatchObject({ is_error: true });
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: { exitCode: 0 } }, 'm6', 10).metadata)
      .toMatchObject({ is_error: false });
    expect(buildAcpToolResultMessage({ ...base, status: 'cancelled', rawOutput: { exitCode: 2 } }, 'm7', 11).metadata)
      .not.toHaveProperty('is_error');
  });

  // LT-612 wire capture, 2026-09-24: `grok agent stdio`'s terminal `tool_call_update`
  // for a failing `execute` reports the exit status as `rawOutput.exit_code` (snake_case),
  // never `rawOutput.exitCode` (camelCase, which is what cursor-agent sends). The shape
  // below is a trimmed, path-anonymised copy of the real payload for
  // `/usr/bin/grep --bogus-flag needle haystack.txt` (exit 2) and
  // `/usr/bin/grep -F needle haystack.txt` (exit 0).
  it('marks a completed Grok command with a nonzero snake_case exit_code as failed', () => {
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
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: grokFailedRawOutput }, 'm8', 14).metadata)
      .toMatchObject({ is_error: true });
    expect(buildAcpToolResultMessage({ ...base, status: 'completed', rawOutput: grokSucceededRawOutput }, 'm9', 15).metadata)
      .toMatchObject({ is_error: false });
    expect(buildAcpToolResultMessage({ ...base, status: 'cancelled', rawOutput: grokFailedRawOutput }, 'm10', 16).metadata)
      .not.toHaveProperty('is_error');
  });
});

describe('buildAcpToolOutcomeFallback', () => {
  it('records a completed command with no rendered output and a nonzero exit code as failed', () => {
    const outcome = buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'completed', hasRenderedOutput: false,
      rawOutput: { exitCode: 2 },
    }, 'm1', 12);
    expect(outcome?.metadata).toMatchObject({ tool_use_id: 'c1', is_error: true });
    expect(buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'cancelled', hasRenderedOutput: false,
      rawOutput: { exitCode: 2 },
    }, 'm2', 13)).toBeNull();
  });

  it('records a completed Grok command (snake_case exit_code, no rendered output) as failed', () => {
    const outcome = buildAcpToolOutcomeFallback({
      toolCallId: 'c1', title: 'Run tests', status: 'completed', hasRenderedOutput: false,
      rawOutput: { exit_code: 2 },
    }, 'm3', 17);
    expect(outcome?.metadata).toMatchObject({ tool_use_id: 'c1', is_error: true });
  });
});
