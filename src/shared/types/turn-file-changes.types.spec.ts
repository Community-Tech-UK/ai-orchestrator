import { describe, expect, it } from 'vitest';
import { readTurnBaselineResult } from './turn-file-changes.types';

describe('readTurnBaselineResult', () => {
  it('passes a well-formed ready answer through', () => {
    const answer = {
      state: 'ready', total: 2, truncated: false, baselineCompletedAt: 10, endedAt: 20,
      files: [
        { path: 'a.ts', status: 'modified', added: 3, deleted: 1 },
        { path: 'img.png', status: 'added', added: null, deleted: null },
      ],
    };
    expect(readTurnBaselineResult(answer)).toEqual(answer);
  });

  it('reads running and unavailable answers', () => {
    expect(readTurnBaselineResult({ state: 'running' })).toEqual({ state: 'running' });
    expect(readTurnBaselineResult({ state: 'unavailable', reason: 'not-git' }))
      .toEqual({ state: 'unavailable', reason: 'not-git' });
  });

  it.each([
    undefined,
    null,
    'ready',
    42,
    {},
    { state: 'nonsense' },
    { state: 'unavailable', reason: 'because' },
    { state: 'ready', total: 'two', files: [], truncated: false, baselineCompletedAt: 1, endedAt: 2 },
    { state: 'ready', total: -1, files: [], truncated: false, baselineCompletedAt: 1, endedAt: 2 },
    { state: 'ready', total: 1, files: 'a.ts', truncated: false, baselineCompletedAt: 1, endedAt: 2 },
    { state: 'ready', total: 1, files: [{ path: 3, status: 'added' }], truncated: false, baselineCompletedAt: 1, endedAt: 2 },
    { state: 'ready', total: 1, files: [{ path: 'a', status: 'renamed' }], truncated: false, baselineCompletedAt: 1, endedAt: 2 },
    { state: 'ready', total: 1, files: [], truncated: false, baselineCompletedAt: '1', endedAt: 2 },
  ])('rejects %j', (answer) => {
    expect(readTurnBaselineResult(answer)).toBeNull();
  });

  it('treats a missing line count as unknown, not zero', () => {
    const result = readTurnBaselineResult({
      state: 'ready', total: 1, truncated: false, baselineCompletedAt: 1, endedAt: 2,
      files: [{ path: 'a', status: 'added' }],
    });
    expect(result).toMatchObject({ files: [{ added: null, deleted: null }] });
  });
});
