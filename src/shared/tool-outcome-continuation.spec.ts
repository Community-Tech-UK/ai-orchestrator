import { describe, expect, it } from 'vitest';
import { classifyCommandOutcome } from './tool-outcome';
import { extractToolInvocations } from '../main/learning/correction-miner';

describe('command evidence continuation regressions', () => {
  it.each(['cd /missing && npm test', 'pushd /missing && npm test', 'npm test; exit 1', 'rtk proxy rg test src', 'cat /missing | npm test', "'rg' test src"])('does not blame a noncheck failure on tests: %s', command => {
    expect(classifyCommandOutcome({ command, exitCode: 1 }).checkFailed).toBe(false);
  });
  it('does not infer command failure from provider output text and a voluntary exit', () => {
    const [attempt] = extractToolInvocations([
      { type: 'tool_use', content: '', metadata: { id: 'c1', name: 'Bash', input: { command: './example.sh' } } },
      { type: 'tool_result', content: 'example: command not found', metadata: { id: 'c1', is_error: false, exitCode: 127, checkFailed: false } },
    ]);
    expect(attempt.isError).toBe(false);
  });
});
