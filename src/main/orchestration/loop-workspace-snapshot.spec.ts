import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshotFileChangesViaGit,
  snapshotFileChangesViaWorkspace,
  snapshotWorkspaceFiles,
} from './loop-workspace-snapshot';

let workspace: string | null = null;
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function write(root: string, rel: string, contents: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, contents);
}

describe('snapshotWorkspaceFiles (filesystem walk)', () => {
  it('ignores JVM build artifacts and the loop state dir', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-'));
    write(workspace, 'src/Main.java', 'class Main {}');
    write(workspace, '.gradle/8.12/fileHashes/fileHashes.bin', 'binary');
    write(workspace, '.kotlin/sessions/x.bin', 'binary');
    write(workspace, 'build/classes/Main.class', 'compiled');
    write(workspace, 'target/foo.jar', 'jar');
    write(workspace, 'bin/Main.class', 'compiled');
    write(workspace, '.aio-loop-state/loop-1/NOTES.md', 'notes');

    const snap = snapshotWorkspaceFiles(workspace);
    const paths = [...snap.keys()];

    expect(paths).toContain('src/Main.java');
    expect(paths.some((p) => p.startsWith('.gradle/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.kotlin/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('build/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('target/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('bin/'))).toBe(false);
    expect(paths.some((p) => p.startsWith('.aio-loop-state/'))).toBe(false);
  });

  it('does not report churn inside ignored dirs as a file change', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-'));
    write(workspace, 'src/Main.java', 'class Main {}');
    write(workspace, '.gradle/cache.bin', 'v1');
    write(workspace, '.aio-loop-state/loop-1/NOTES.md', 'v1');

    const before = snapshotWorkspaceFiles(workspace);

    // Simulate an iteration that only churned build cache + loop state — the
    // exact failure mode that masked a genuine stall in the one-more-floor run.
    write(workspace, '.gradle/cache.bin', 'v2-rebuilt');
    write(workspace, '.aio-loop-state/loop-1/NOTES.md', 'v2-rewritten');

    const changes = snapshotFileChangesViaWorkspace(before, workspace);
    expect(changes).toEqual([]);
  });

  it('still reports real production file changes', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-'));
    write(workspace, 'src/Main.java', 'class Main {}');
    const before = snapshotWorkspaceFiles(workspace);
    write(workspace, 'src/Main.java', 'class Main { void run() {} }');
    write(workspace, '.gradle/cache.bin', 'rebuilt');

    const changes = snapshotFileChangesViaWorkspace(before, workspace);
    expect(changes.map((c) => c.path)).toEqual(['src/Main.java']);
  });
});

describe('snapshotFileChangesViaGit', () => {
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  const maybe = gitOk ? it : it.skip;

  maybe('filters tracked build/loop-state artifacts out of git diff', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-git-'));
    const git = (...args: string[]) =>
      spawnSync('git', args, { cwd: workspace as string, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');

    // A repo that mistakenly committed a gradle cache file alongside source.
    write(workspace, 'src/Main.java', 'class Main {}');
    write(workspace, '.gradle/cache.bin', 'v1');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');

    // Both change; only the source change should be reported.
    write(workspace, 'src/Main.java', 'class Main { void run() {} }');
    write(workspace, '.gradle/cache.bin', 'v2');

    const changes = snapshotFileChangesViaGit(workspace);
    expect(changes.map((c) => c.path)).toEqual(['src/Main.java']);
  });
});
