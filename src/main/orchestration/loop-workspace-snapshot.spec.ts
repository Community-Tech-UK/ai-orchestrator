import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  diffFileChangeSnapshots,
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

  it('prioritizes nested source repos over large archive directories before the snapshot cap', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-'));
    const testSnapshotCap = 10;
    for (let i = 0; i < 12; i++) {
      write(workspace, `aaa-archive/live-${i}.log`, `log ${i}`);
    }
    write(workspace, 'unstablepvp/.git/HEAD', 'ref: refs/heads/main');
    write(workspace, 'unstablepvp/pom.xml', '<project />');
    write(workspace, 'unstablepvp/src/main/java/Main.java', 'class Main {}');

    const before = snapshotWorkspaceFiles(workspace, { maxFiles: testSnapshotCap });
    write(workspace, 'unstablepvp/src/main/java/Main.java', 'class Main { void run() {} }');

    const changes = snapshotFileChangesViaWorkspace(before, workspace, { maxFiles: testSnapshotCap });
    expect(changes.map((c) => c.path)).toContain('unstablepvp/src/main/java/Main.java');
  }, 30_000);

  it('does not let generated Xcode build-device output exhaust the snapshot before source files', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-'));
    const testSnapshotCap = 10;
    for (let i = 0; i < 12; i++) {
      write(
        workspace,
        `apps/mobile/ios/build-device/Build/Intermediates.noindex/object-${i}.o`,
        `object ${i}`,
      );
    }
    write(workspace, 'src/main/orchestration/loop-coordinator.ts', 'export const version = 1;');

    const before = snapshotWorkspaceFiles(workspace, { maxFiles: testSnapshotCap });
    write(workspace, 'src/main/orchestration/loop-coordinator.ts', 'export const version = 2;');

    const changes = snapshotFileChangesViaWorkspace(before, workspace, { maxFiles: testSnapshotCap });
    expect(changes.map((change) => change.path)).toContain(
      'src/main/orchestration/loop-coordinator.ts',
    );
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

  it('does not whole-file read large git-changed files while hashing', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-snap-git-'));
    const relPath = 'src/huge.md';
    const absPath = join(workspace, relPath);
    write(workspace, relPath, 'x'.repeat(6 * 1024 * 1024));
    const runner = () => ({
      status: 0,
      stdout: `1\t1\t${relPath}\n`,
    });
    vi.resetModules();
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.doMock('fs', () => ({
      ...realFs,
      readFileSync: (pathLike: Parameters<typeof realFs.readFileSync>[0], ...args: unknown[]) => {
        if (pathLike === absPath) {
          throw new Error('unexpected whole-file read');
        }
        return realFs.readFileSync(pathLike, ...(args as []));
      },
    }));
    const { snapshotFileChangesViaGit: snapshotWithMockedFs } = await import('./loop-workspace-snapshot');

    try {
      const changes = snapshotWithMockedFs(workspace, runner);

      expect(changes).toEqual([
        {
          path: relPath,
          additions: 1,
          deletions: 1,
          contentHash: expect.any(String),
        },
      ]);
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });
});

describe('diffFileChangeSnapshots', () => {
  it('reports a tracked file changed during the iteration even when it was already dirty', () => {
    const before = [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'before' }];
    const after = [{ path: 'src/app.ts', additions: 2, deletions: 0, contentHash: 'after' }];

    expect(diffFileChangeSnapshots(before, after)).toEqual(after);
  });

  it('does not report unchanged pre-existing git dirt', () => {
    const dirty = [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'same' }];

    expect(diffFileChangeSnapshots(dirty, dirty)).toEqual([]);
  });
});
