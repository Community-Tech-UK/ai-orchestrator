import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../../../shared/types/instance.types';
import { CodexExecOutput } from './exec-output';

/** Feed one completed `codex exec --json` command item and return its tool_result message. */
function completedCommand(item: Record<string, unknown>): OutputMessage {
  const messages: OutputMessage[] = [];
  const output = new CodexExecOutput((message) => messages.push(message));
  const full = { id: 'cmd-1', type: 'command_execution', ...item };
  output.accept(JSON.stringify({ type: 'item.started', item: full }), { type: 'item.started', item: full });
  output.accept(JSON.stringify({ type: 'item.completed', item: full }), { type: 'item.completed', item: full });
  const result = messages.find((message) => message.type === 'tool_result');
  if (!result) throw new Error('no tool_result was published');
  return result;
}

describe('CodexExecOutput command results (U1 step 5: a non-zero exit is not automatically an error)', () => {
  it('keeps the exit status without an error flag when an ordinary command exits non-zero', () => {
    const result = completedCommand({ command: 'rg missing src', aggregated_output: '', exit_code: 1, status: 'completed' });
    expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: false, checkFailed: false });
    expect(result.content).toBe('Exited with status 1');
  });

  it('marks a failing check as a failed check, not a transport error', () => {
    const result = completedCommand({ command: 'local-check', aggregated_output: 'Check failed', exit_code: 2, status: 'completed' });
    expect(result.metadata).toMatchObject({ is_error: false, exitCode: 2, isCheck: true, checkFailed: true });
    expect(result.content).toBe('Check failed');
  });

  it('records a clean exit as a success', () => {
    const result = completedCommand({ command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' });
    expect(result.metadata).toMatchObject({ is_error: false, exitCode: 0, isCheck: true, checkFailed: false });
  });

  it('calls a command that never reported an exit status an error', () => {
    const result = completedCommand({ command: 'ls', status: 'failed' });
    expect(result.metadata).toMatchObject({ is_error: true });
    expect(result.content).toBe('Command failed');
  });

  it.each([124, 127, 137])('keeps a voluntary exit %i neutral, since a number alone is no evidence', (exit_code) => {
    const result = completedCommand({ command: './deploy.sh', aggregated_output: 'stopping', exit_code, status: 'completed' });
    expect(result.metadata).toMatchObject({ is_error: false, exitCode: exit_code, isCheck: false, checkFailed: false });
  });

  it('calls a command an error only when the item reports a timeout or a signal', () => {
    expect(completedCommand({ command: './deploy.sh', exit_code: 124, status: 'completed', timed_out: true }).metadata)
      .toMatchObject({ is_error: true, exitCode: 124 });
    expect(completedCommand({ command: './deploy.sh', exit_code: 137, status: 'completed', signal: 'SIGKILL' }).metadata)
      .toMatchObject({ is_error: true, exitCode: 137 });
  });

  it('does not call a failed check that ran after another failing step a failed test', () => {
    const result = completedCommand({ command: 'git pull && npm test', aggregated_output: 'conflict', exit_code: 1, status: 'completed' });
    expect(result.metadata).toMatchObject({ is_error: false, exitCode: 1, isCheck: true, checkFailed: false });
  });

  it('honours an explicit is_error flag on the item', () => {
    const result = completedCommand({ command: 'ls', exit_code: 0, status: 'completed', is_error: true });
    expect(result.metadata).toMatchObject({ is_error: true, exitCode: 0 });
  });

  it('honours an explicit isCheck from the caller', () => {
    const result = completedCommand({ command: './ci.sh', exit_code: 3, status: 'completed', isCheck: true });
    expect(result.metadata).toMatchObject({ is_error: false, isCheck: true, checkFailed: true });
  });

  it('still fails a file change that errored', () => {
    const messages: OutputMessage[] = [];
    const output = new CodexExecOutput((message) => messages.push(message));
    const item = { id: 'edit-1', type: 'file_change', status: 'failed', changes: [{ path: 'example.css', kind: 'update', diff: 'x' }] };
    output.accept(JSON.stringify({ type: 'item.completed', item }), { type: 'item.completed', item });
    expect(messages.find((message) => message.type === 'tool_result')?.metadata).toMatchObject({ is_error: true });
  });
});
