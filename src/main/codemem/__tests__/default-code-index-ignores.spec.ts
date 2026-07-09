import { describe, expect, it } from 'vitest';
import { DEFAULT_CODE_INDEX_IGNORES } from '../code-index-watcher';

describe('DEFAULT_CODE_INDEX_IGNORES', () => {
  it('includes the scratch and archive convention directories', () => {
    expect(DEFAULT_CODE_INDEX_IGNORES).toContain('_scratch/');
    expect(DEFAULT_CODE_INDEX_IGNORES).toContain('_archive/');
  });

  it('excludes linked git worktrees from parent-workspace indexing', () => {
    expect(DEFAULT_CODE_INDEX_IGNORES).toContain('.worktrees/');
  });

  it('still includes the existing common build and cache outputs', () => {
    // Sanity check that we didn't accidentally remove existing entries.
    for (const expected of ['node_modules/', 'dist/', 'build/', '.git/']) {
      expect(DEFAULT_CODE_INDEX_IGNORES).toContain(expected);
    }
  });
});
