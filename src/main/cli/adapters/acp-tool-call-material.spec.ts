import { describe, expect, it } from 'vitest';
import {
  ACP_RAW_OUTPUT_MAX_CHARS,
  buildAcpToolCallArguments,
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
});
