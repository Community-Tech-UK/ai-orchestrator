import { describe, expect, it } from 'vitest';
import { buildChangesRows, statusLetter } from './source-control-rows';
import type { FileChange, GitStatusResponse } from './source-control.types';

function change(path: string, status: FileChange['status'], staged = false): FileChange {
  return { path, status, staged };
}

function status(overrides: Partial<GitStatusResponse> = {}): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    hasChanges: true,
    isClean: false,
    ...overrides,
  };
}

describe('buildChangesRows', () => {
  it('merges unstaged + untracked into one name-sorted list, untracked interleaved', () => {
    const rows = buildChangesRows(
      status({
        unstaged: [change('src/beta.ts', 'modified'), change('src/delta.ts', 'deleted')],
        untracked: ['src/alpha.ts', 'src/charlie.ts'],
      }),
    );
    expect(rows.map((r) => r.path)).toEqual([
      'src/alpha.ts',   // untracked
      'src/beta.ts',    // modified
      'src/charlie.ts', // untracked
      'src/delta.ts',   // deleted
    ]);
  });

  it('maps untracked paths to synthetic FileChange rows', () => {
    const rows = buildChangesRows(status({ untracked: ['new.txt'] }));
    expect(rows).toEqual([{ path: 'new.txt', status: 'untracked', staged: false }]);
  });

  it('sorts case-insensitively by basename, not by full path', () => {
    const rows = buildChangesRows(
      status({
        unstaged: [change('z/Apple.ts', 'modified')],
        untracked: ['a/banana.ts', 'a/Cherry.ts'],
      }),
    );
    expect(rows.map((r) => r.path)).toEqual(['z/Apple.ts', 'a/banana.ts', 'a/Cherry.ts']);
  });

  it('returns an empty list when there are no unstaged or untracked changes', () => {
    expect(buildChangesRows(status())).toEqual([]);
  });

  it('preserves the original unstaged FileChange objects (including status)', () => {
    const modified = change('m.ts', 'modified');
    const renamed = change('r.ts', 'renamed');
    const rows = buildChangesRows(status({ unstaged: [modified, renamed] }));
    expect(rows).toContain(modified);
    expect(rows).toContain(renamed);
  });
});

describe('statusLetter', () => {
  it('maps each status to its VS Code letter (U for untracked, ! for ignored)', () => {
    expect(statusLetter('modified')).toBe('M');
    expect(statusLetter('added')).toBe('A');
    expect(statusLetter('deleted')).toBe('D');
    expect(statusLetter('renamed')).toBe('R');
    expect(statusLetter('copied')).toBe('C');
    expect(statusLetter('untracked')).toBe('U');
    expect(statusLetter('ignored')).toBe('!');
  });
});
