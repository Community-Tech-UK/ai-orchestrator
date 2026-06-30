import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  captureLoopRepoBaseline,
  compareLoopRepoState,
} from './loop-repo-state';

let workspace: string;

const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const maybe = gitOk ? it : it.skip;

function write(relPath: string, content: string): void {
  const absPath = join(workspace, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
}

function git(...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}

function initRepo(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  write('src/a.ts', 'export const a = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-repo-state-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('captureLoopRepoBaseline', () => {
  maybe('captures a clean git baseline', () => {
    initRepo();

    const baseline = captureLoopRepoBaseline(workspace);

    expect(baseline.source).toBe('git');
    expect(baseline.headRef).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.dirtyAtStart).toBe(false);
    expect(baseline.trackedDirtyAtStart).toEqual([]);
    expect(baseline.untrackedAtStart).toEqual([]);
  });

  it('returns source none outside git', () => {
    const baseline = captureLoopRepoBaseline(workspace);

    expect(baseline.source).toBe('none');
    expect(baseline.headRef).toBeNull();
    expect(baseline.dirtyAtStart).toBe(false);
  });

  maybe('records dirty tracked and untracked files at baseline time', () => {
    initRepo();
    write('src/a.ts', 'export const a = 2;\n');
    write('src/new.ts', 'export const n = 1;\n');

    const baseline = captureLoopRepoBaseline(workspace);

    expect(baseline.dirtyAtStart).toBe(true);
    expect(baseline.trackedDirtyAtStart).toEqual(['src/a.ts']);
    expect(baseline.untrackedAtStart).toEqual(['src/new.ts']);
  });
});

describe('compareLoopRepoState', () => {
  maybe('compares tracked and untracked files against the captured baseline', () => {
    initRepo();
    const baseline = captureLoopRepoBaseline(workspace);

    write('src/a.ts', 'export const a = 2;\n');
    write('src/new.ts', 'console.log("new debug");\nexport const n = 1;\n');
    const comparison = compareLoopRepoState(workspace, baseline);

    expect(comparison.source).toBe('git');
    expect(comparison.changedFiles).toEqual(['src/a.ts', 'src/new.ts']);
    expect(comparison.trackedDiff).toContain('git diff');
    expect(comparison.trackedDiff).toContain('+console.log("new debug");');
    expect(comparison.untrackedFiles).toEqual(['src/new.ts']);
  });

  maybe('does not count unchanged dirty-baseline files as loop deliverables', () => {
    initRepo();
    write('src/a.ts', 'console.log("pre-existing debug");\nexport const a = 2;\n');
    write('src/new.ts', 'export const n = 1;\n');
    const baseline = captureLoopRepoBaseline(workspace);

    const comparison = compareLoopRepoState(workspace, baseline);

    expect(comparison.changedFiles).toEqual([]);
    expect(comparison.trackedDiff).not.toContain('pre-existing debug');
    expect(comparison.dirtyAtStartCarriedForward).toBe(false);
  });

  maybe('counts dirty-baseline files when they change again after capture', () => {
    initRepo();
    write('src/a.ts', 'export const a = 2;\n');
    write('src/new.ts', 'export const n = 1;\n');
    const baseline = captureLoopRepoBaseline(workspace);

    write('src/a.ts', 'export const a = 3;\n');
    write('src/new.ts', 'export const n = 2;\n');
    const comparison = compareLoopRepoState(workspace, baseline);

    expect(comparison.changedFiles).toEqual(['src/a.ts', 'src/new.ts']);
    expect(comparison.dirtyAtStartCarriedForward).toBe(true);
  });

  maybe('ignores loop state, control, attachments, git, and node_modules paths', () => {
    initRepo();
    const baseline = captureLoopRepoBaseline(workspace);

    write('.aio-loop-state/loop-1/NOTES.md', 'state');
    write('.aio-loop-control/loop-1/token', 'secret');
    write('.aio-loop-attachments/loop-1/file.txt', 'attachment');
    write('node_modules/pkg/index.js', 'module');

    const comparison = compareLoopRepoState(workspace, baseline);

    expect(comparison.changedFiles).toEqual([]);
    expect(comparison.untrackedFiles).toEqual([]);
  });
});
