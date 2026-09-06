import { describe, expect, it } from 'vitest';
import {
  ACP_RAW_OUTPUT_MAX_CHARS,
  buildAcpToolCallArguments,
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
