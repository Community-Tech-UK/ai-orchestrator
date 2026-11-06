import { describe, expect, it } from 'vitest';
import type { MobileMessageDto } from '../core/models';
import { buildDisplayItems, isLoopTranscriptMessage, toolLabel, toolDetails } from './transcript-items';

function msg(overrides: Partial<MobileMessageDto>): MobileMessageDto {
  return {
    id: 'm1',
    timestamp: 0,
    type: 'assistant',
    content: '',
    ...overrides,
  };
}

describe('toolLabel', () => {
  it('prefers the tool name from metadata', () => {
    expect(toolLabel(msg({ metadata: { toolName: 'Bash' }, content: 'raw' }))).toBe('Bash');
    expect(toolLabel(msg({ metadata: { tool_name: 'Read' }, content: 'raw' }))).toBe('Read');
  });

  it('falls back to content, then a generic label', () => {
    expect(toolLabel(msg({ content: 'ls -la' }))).toBe('ls -la');
    expect(toolLabel(msg({}))).toBe('tool');
  });
});

describe('toolDetails', () => {
  it('retains full command input and result text without turning metadata into HTML', () => {
    const command = 'preview-command\n'.repeat(40);
    const details = toolDetails(msg({ content: '<result>\nfull output', metadata: { tool_name: 'Bash', tool_input: { command }, is_error: true } }));
    expect(details).toContain('<result>\nfull output');
    expect(details).toContain(JSON.stringify({ command }, null, 2));
    expect(details).toContain('Error');
  });

  // What the desktop writes on a command's result (`src/main/cli/adapters/codex/*`):
  // `is_error` only means "could not run"; the exit status and check verdict ride beside it.
  const result = (content: string, metadata: Record<string, unknown>): MobileMessageDto =>
    msg({ type: 'tool_result', content, metadata: { name: 'Bash', ...metadata } });

  it('still shows a real failed test as an error, though the command ran', () => {
    const details = toolDetails(result('3 tests failed', { is_error: false, exitCode: 1, isCheck: true, checkFailed: true }));

    expect(details.startsWith('Error')).toBe(true);
    expect(details).toContain('3 tests failed');
    expect(details).toContain('Exited with status 1');
  });

  it('does not call a search that found nothing an error', () => {
    const details = toolDetails(result('Exited with status 1', { is_error: false, exitCode: 1, isCheck: false, checkFailed: false }));

    expect(details).toBe('Exited with status 1');
  });

  it('adds the exit status after the output instead of calling it an error', () => {
    const details = toolDetails(result('stopping on purpose', { is_error: false, exitCode: 127, isCheck: false, checkFailed: false }));

    expect(details).toBe('stopping on purpose\n\nExited with status 127');
  });

  it('leaves a clean exit, and a result with no status, as they were', () => {
    expect(toolDetails(result('all green', { is_error: false, exitCode: 0, isCheck: true, checkFailed: false }))).toBe('all green');
    expect(toolDetails(result('ok', {}))).toBe('ok');
  });

  it('still shows a command that could not run as an error', () => {
    const details = toolDetails(result('Command declined', { is_error: true, isCheck: false, checkFailed: false }));

    expect(details.startsWith('Error')).toBe(true);
  });

  it('keeps showing an older result that was marked an error for its exit status', () => {
    const details = toolDetails(result('boom', { is_error: true, exitCode: 2 }));

    expect(details.startsWith('Error')).toBe(true);
    expect(details).toContain('Exited with status 2');
  });

  it('does not let a stray check flag turn a file edit into a failure', () => {
    const details = toolDetails(msg({ type: 'tool_result', content: 'patched', metadata: { name: 'apply_patch', isCheck: true, checkFailed: true, exitCode: 1 } }));

    expect(details.startsWith('Error')).toBe(false);
  });
});

describe('isLoopTranscriptMessage', () => {
  it('identifies loop transcript system and assistant messages from metadata', () => {
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-iteration' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-summary' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-start' } }))).toBe(true);
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'loop-intervene' } }))).toBe(true);
  });

  it('does not classify ordinary transcript messages as loop output', () => {
    expect(isLoopTranscriptMessage(msg({ metadata: { kind: 'permission' } }))).toBe(false);
    expect(isLoopTranscriptMessage(msg({ metadata: {} }))).toBe(false);
    expect(isLoopTranscriptMessage(msg({}))).toBe(false);
  });
});

describe('buildDisplayItems', () => {
  it('groups consecutive tool messages and keeps prose separate', () => {
    const now = Date.parse('2026-07-07T12:00:00Z');
    const items = buildDisplayItems(
      [
        msg({ id: 'a', type: 'user', content: 'do it', timestamp: now }),
        msg({ id: 'b', type: 'tool_use', content: 'Bash', timestamp: now }),
        msg({ id: 'c', type: 'tool_result', content: 'ok', timestamp: now }),
        msg({ id: 'd', type: 'assistant', content: 'done', timestamp: now }),
      ],
      now,
    );

    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(['stamp', 'msg', 'tools', 'msg']);
    const tools = items.find((i) => i.kind === 'tools');
    expect(tools?.kind === 'tools' && tools.items).toHaveLength(2);
  });
});
