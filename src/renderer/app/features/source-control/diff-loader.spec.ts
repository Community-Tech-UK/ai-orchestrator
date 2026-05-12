import { describe, it, expect, vi } from 'vitest';
import { DiffLoader, classifyHunks } from './diff-loader';
import type { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { DiffFile, DiffResult } from './source-control.types';

// ---------------------------------------------------------------------------
// classifyHunks — pure
// ---------------------------------------------------------------------------

describe('classifyHunks', () => {
  function makeFile(hunkContents: string[]): DiffFile {
    return {
      path: 'x.ts',
      status: 'modified',
      additions: 0,
      deletions: 0,
      hunks: hunkContents.map(content => ({
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        content,
      })),
    };
  }

  it('classifies headers, adds, removes, and context lines', () => {
    const file = makeFile([
      [
        '@@ -1,3 +1,4 @@',
        ' context-line',
        '+added-line',
        '-removed-line',
        ' another-context',
      ].join('\n'),
    ]);

    expect(classifyHunks(file)).toEqual([
      { kind: 'header', text: '@@ -1,3 +1,4 @@' },
      { kind: 'context', text: ' context-line' },
      { kind: 'add', text: '+added-line' },
      { kind: 'remove', text: '-removed-line' },
      { kind: 'context', text: ' another-context' },
    ]);
  });

  it('classifies `+++` and `---` metadata lines as meta (not add/remove)', () => {
    const file = makeFile([['--- a/x.ts', '+++ b/x.ts', '@@ -1 +1 @@'].join('\n')]);
    const lines = classifyHunks(file);
    expect(lines[0]).toEqual({ kind: 'meta', text: '--- a/x.ts' });
    expect(lines[1]).toEqual({ kind: 'meta', text: '+++ b/x.ts' });
    expect(lines[2]).toEqual({ kind: 'header', text: '@@ -1 +1 @@' });
  });

  it('skips empty lines', () => {
    const file = makeFile([['@@ -1 +1 @@', '', '+added', ''].join('\n')]);
    expect(classifyHunks(file)).toEqual([
      { kind: 'header', text: '@@ -1 +1 @@' },
      { kind: 'add', text: '+added' },
    ]);
  });

  it('handles multi-hunk files in document order', () => {
    const file = makeFile([
      ['@@ -1 +1 @@', '+a'].join('\n'),
      ['@@ -10 +10 @@', '-b'].join('\n'),
    ]);
    expect(classifyHunks(file)).toEqual([
      { kind: 'header', text: '@@ -1 +1 @@' },
      { kind: 'add', text: '+a' },
      { kind: 'header', text: '@@ -10 +10 @@' },
      { kind: 'remove', text: '-b' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// DiffLoader
// ---------------------------------------------------------------------------

function makeResult(additions = 0, deletions = 0, isBinary = false, hunkContent?: string): DiffResult {
  return {
    files: [{
      path: 'x.ts',
      status: 'modified',
      additions,
      deletions,
      isBinary,
      hunks: hunkContent ? [{ oldStart: 1, oldLines: 1, newStart: 42, newLines: 1, content: hunkContent }] : [],
    }],
    totalAdditions: additions,
    totalDeletions: deletions,
  };
}

interface PendingDiff {
  resolve: (result: DiffResult) => void;
  rejectAsError: (msg: string) => void;
}

function makeVcsMock() {
  const pending: PendingDiff[] = [];
  const vcsGetDiff = vi.fn(() => {
    let resolveFn!: PendingDiff['resolve'];
    let rejectAsError!: PendingDiff['rejectAsError'];
    const promise = new Promise<{ success: boolean; data?: unknown; error?: { message: string } }>(resolve => {
      resolveFn = data => resolve({ success: true, data: { diff: data } });
      rejectAsError = msg => resolve({ success: false, error: { message: msg } });
    });
    pending.push({ resolve: resolveFn, rejectAsError });
    return promise;
  });
  return {
    mock: { vcsGetDiff } as unknown as VcsIpcService,
    pending,
  };
}

describe('DiffLoader', () => {
  it('starts un-loaded', () => {
    const { mock } = makeVcsMock();
    const loader = new DiffLoader(mock);
    expect(loader.isLoading()).toBe(false);
    expect(loader.errorMessage()).toBeNull();
    expect(loader.file()).toBeNull();
    expect(loader.renderedLines()).toEqual([]);
  });

  it('load() sets loading, then resolves diff', async () => {
    const { mock, pending } = makeVcsMock();
    const loader = new DiffLoader(mock);
    const promise = loader.load('/wd', 'x.ts', false);
    expect(loader.isLoading()).toBe(true);

    pending[0].resolve(makeResult(3, 1, false, '@@ -1 +1 @@\n+added'));
    await promise;

    expect(loader.isLoading()).toBe(false);
    expect(loader.errorMessage()).toBeNull();
    expect(loader.file()?.additions).toBe(3);
    expect(loader.renderedLines().length).toBe(2);
  });

  it('surfaces ipc-failure errors', async () => {
    const { mock, pending } = makeVcsMock();
    const loader = new DiffLoader(mock);
    const promise = loader.load('/wd', 'x.ts', false);
    pending[0].rejectAsError('git failed');
    await promise;
    expect(loader.errorMessage()).toBe('git failed');
    expect(loader.file()).toBeNull();
  });

  it('drops stale responses when load() is called twice rapidly', async () => {
    const { mock, pending } = makeVcsMock();
    const loader = new DiffLoader(mock);

    const first = loader.load('/wd', 'a.ts', false);
    const second = loader.load('/wd', 'b.ts', false);

    // Resolve the FIRST (stale) call with one result, the SECOND with another.
    pending[0].resolve(makeResult(99, 0, false, '@@ -1 +1 @@\n+stale'));
    pending[1].resolve(makeResult(1, 0, false, '@@ -1 +1 @@\n+fresh'));
    await Promise.all([first, second]);

    expect(loader.file()?.additions).toBe(1); // fresh wins
    expect(loader.isLoading()).toBe(false);
  });

  it('jumpLine() picks the first hunk\'s newStart, falls back to 1', () => {
    const { mock } = makeVcsMock();
    const loader = new DiffLoader(mock);
    expect(loader.jumpLine()).toBe(1); // no file loaded

    // Manually seed a result and check
    loader.diffResult.set(makeResult(1, 0, false, '@@ -1 +1 @@\n+a'));
    expect(loader.jumpLine()).toBe(42);

    // No hunks → 1
    loader.diffResult.set(makeResult(0, 0, false));
    expect(loader.jumpLine()).toBe(1);
  });

  it('returns empty renderedLines for binary files', async () => {
    const { mock, pending } = makeVcsMock();
    const loader = new DiffLoader(mock);
    const promise = loader.load('/wd', 'image.png', false);
    pending[0].resolve(makeResult(0, 0, true));
    await promise;
    expect(loader.file()?.isBinary).toBe(true);
    expect(loader.renderedLines()).toEqual([]);
  });
});
