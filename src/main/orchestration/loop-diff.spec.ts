import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkspaceDiff, type GitRunner } from './loop-diff';

let workspace: string | null = null;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

/** Build a fake git runner from a small response table keyed by intent. */
function fakeRunner(responses: {
  insideRepo?: boolean;
  stat?: string;
  trackedDiff?: string;
  untracked?: string;
}): GitRunner {
  return (args) => {
    if (args.includes('--is-inside-work-tree')) {
      return responses.insideRepo === false
        ? { status: 1, stdout: '' }
        : { status: 0, stdout: 'true\n' };
    }
    if (args[0] === 'ls-files') {
      return { status: 0, stdout: responses.untracked ?? '' };
    }
    if (args.includes('--stat')) {
      return { status: 0, stdout: responses.stat ?? '' };
    }
    // diff HEAD
    return { status: 0, stdout: responses.trackedDiff ?? '' };
  };
}

describe('collectWorkspaceDiff', () => {
  it('reports source "none" when the workspace is not a git repo', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-diff-'));
    const out = collectWorkspaceDiff(workspace, {}, fakeRunner({ insideRepo: false }));
    expect(out.source).toBe('none');
    expect(out.diff).toBe('');
    expect(out.changedFiles).toEqual([]);
  });

  it('includes the stat header, tracked diff, and parses changed files', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-diff-'));
    const trackedDiff = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 111..222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1 +1 @@',
      '-const x = BUG;',
      '+const x = 1;',
    ].join('\n');
    const out = collectWorkspaceDiff(
      workspace,
      {},
      fakeRunner({ stat: ' src/app.ts | 2 +-', trackedDiff }),
    );
    expect(out.source).toBe('git');
    expect(out.diff).toContain('Change summary');
    expect(out.diff).toContain('Tracked changes');
    expect(out.diff).toContain('const x = 1;');
    expect(out.changedFiles).toEqual(['src/app.ts']);
    expect(out.truncated).toBe(false);
  });

  it('includes untracked file contents verbatim', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-diff-'));
    writeFileSync(join(workspace, 'newfile.ts'), 'export const created = true;\n');
    const out = collectWorkspaceDiff(workspace, {}, fakeRunner({ untracked: 'newfile.ts\n' }));
    expect(out.diff).toContain('New (untracked) files');
    expect(out.diff).toContain('+++ new file: newfile.ts');
    expect(out.diff).toContain('export const created = true;');
    expect(out.changedFiles).toContain('newfile.ts');
  });

  it('excludes the loop-control dir (secret token) and other internal noise from untracked output', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-diff-'));
    mkdirSync(join(workspace, '.aio-loop-control'), { recursive: true });
    writeFileSync(join(workspace, '.aio-loop-control', 'control.json'), '{"secret":"do-not-leak"}\n');
    writeFileSync(join(workspace, 'real.ts'), 'export const ok = 1;\n');
    const out = collectWorkspaceDiff(
      workspace,
      {},
      fakeRunner({ untracked: '.aio-loop-control/control.json\nreal.ts\n' }),
    );
    expect(out.diff).not.toContain('do-not-leak');
    expect(out.diff).toContain('real.ts');
    expect(out.changedFiles).toEqual(['real.ts']);
  });

  it('truncates when the combined diff exceeds maxChars', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-diff-'));
    const huge = 'x'.repeat(5_000);
    const out = collectWorkspaceDiff(
      workspace,
      { maxChars: 1_000 },
      fakeRunner({ trackedDiff: huge }),
    );
    expect(out.truncated).toBe(true);
    expect(out.diff.length).toBeLessThanOrEqual(1_000 + 64);
    expect(out.diff).toContain('diff truncated for review');
  });
});
