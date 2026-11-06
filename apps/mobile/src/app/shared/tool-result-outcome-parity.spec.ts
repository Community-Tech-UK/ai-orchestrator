/**
 * The phone cannot import `src/shared` at run time, so `tool-result-outcome.ts` keeps
 * a small mirror of the desktop's rule for which tool results count as failed. This
 * spec is what keeps the mirror honest: it runs the real rule and the mirror over the
 * same grid of tools and results and fails when they disagree.
 */
import { describe, expect, it } from 'vitest';
import { describeExitStatus, isToolResultFailed } from '../../../../../src/shared/tool-outcome';
import { exitStatusLine, toolResultFailed } from './tool-result-outcome';

const TOOL_NAMES: (string | undefined)[] = [
  undefined, '', '  ', 'Bash', 'bash', 'shell', 'execute', 'command_execution', 'Edit', 'Write', 'MultiEdit', 'apply_patch',
  'file_change', 'EditFile', 'lookup', 'Read', 'mcp__server__tool',
];

const RESULTS: (Record<string, unknown> | undefined)[] = [
  undefined,
  {},
  { is_error: true },
  { isError: true },
  { is_error: false },
  { is_error: 'true' },
  { exitCode: 0 },
  { exitCode: 1 },
  { exitCode: 127 },
  { exitCode: '1', isCheck: true },
  { isCheck: true },
  { isCheck: true, exitCode: 0 },
  { isCheck: true, exitCode: 1 },
  { isCheck: true, exitCode: 1, checkFailed: false },
  { isCheck: true, exitCode: 1, checkFailed: true },
  { isCheck: false, exitCode: 1, checkFailed: true },
  { isCheck: true, exitCode: 0, checkFailed: true },
  { checkFailed: true },
  { checkFailed: 'yes', isCheck: true, exitCode: 2 },
  { is_error: false, exitCode: 1, isCheck: false, checkFailed: false },
  { is_error: true, exitCode: 1, isCheck: true, checkFailed: true },
  { is_error: false, exitCode: 124, isCheck: true, checkFailed: false },
];

describe('the phone reads a tool result as failed exactly as the desktop does', () => {
  for (const toolName of TOOL_NAMES) {
    it(`for the tool ${JSON.stringify(toolName)}`, () => {
      for (const metadata of RESULTS) {
        expect(toolResultFailed(toolName, metadata), JSON.stringify(metadata)).toBe(isToolResultFailed(toolName, metadata));
      }
    });
  }

  it('keeps the grid honest: it contains failures and non-failures of every kind', () => {
    const outcomes = new Set(TOOL_NAMES.flatMap((name) => RESULTS.map((metadata) => isToolResultFailed(name, metadata))));
    expect(outcomes).toEqual(new Set([true, false]));
    // A failed check that is not an error, and a non-zero exit that is neither.
    expect(isToolResultFailed('Bash', { is_error: false, isCheck: true, exitCode: 1, checkFailed: true })).toBe(true);
    expect(isToolResultFailed('Bash', { is_error: false, isCheck: false, exitCode: 1, checkFailed: false })).toBe(false);
  });
});

describe('the phone words a non-zero exit as the desktop does', () => {
  it.each([1, 2, 124, 127, 137, 255, -1])('status %i', (exitCode) => {
    expect(exitStatusLine({ exitCode })).toBe(describeExitStatus(exitCode));
  });

  it('says nothing for a clean exit, none reported, or something that is not a status', () => {
    expect(exitStatusLine({ exitCode: 0 })).toBeUndefined();
    expect(exitStatusLine({})).toBeUndefined();
    expect(exitStatusLine(undefined)).toBeUndefined();
    expect(exitStatusLine({ exitCode: '1' })).toBeUndefined();
    expect(exitStatusLine({ exitCode: null })).toBeUndefined();
  });
});
