import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildObservedAttemptEvidence,
  createAttemptDeltaObserver,
} from './loop-attempt-observation';

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

function write(root: string, relPath: string, content: string): void {
  const absPath = join(root, relPath);
  mkdirSync(join(absPath, '..'), { recursive: true });
  writeFileSync(absPath, content);
}

function initRepo(root: string): void {
  mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  write(root, 'tracked.ts', 'export const value = 1;\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: root });
}

describe('createAttemptDeltaObserver', () => {
  it('merges two nested Git repositories with uncovered root files', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-observation-'));
    const first = join(workspace, 'packages', 'first');
    const second = join(workspace, 'services', 'second');
    initRepo(first);
    initRepo(second);
    write(first, 'existing-untracked.txt', 'before');

    const observer = createAttemptDeltaObserver(workspace);

    write(workspace, 'deliverable.md', 'root result');
    write(first, 'existing-untracked.txt', 'after');
    write(first, 'tracked.ts', 'export const value = 2;\n');
    write(second, 'tracked.ts', 'export const value = 3;\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: second });

    const observation = observer.observe();
    expect(observation.coverage).toBe('complete');
    expect(observation.sources).toEqual(expect.arrayContaining(['nested-git', 'filesystem']));
    expect(observation.changes.map((change) => change.path)).toEqual([
      'deliverable.md',
      'packages/first/existing-untracked.txt',
      'packages/first/tracked.ts',
      'services/second/tracked.ts',
    ]);
  });

  it('applies the existing evidence path bound after deterministic multi-repository merge', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-observation-'));
    const first = join(workspace, 'packages', 'first');
    const second = join(workspace, 'services', 'second');
    initRepo(first);
    initRepo(second);
    const observer = createAttemptDeltaObserver(workspace);

    for (let index = 0; index < 30; index += 1) {
      const name = `new-${String(index).padStart(2, '0')}.ts`;
      write(first, name, `export const first${index} = true;\n`);
      write(second, name, `export const second${index} = true;\n`);
    }

    const observation = observer.observe();

    expect(observation.coverage).toBe('complete');
    expect(observation.changes).toHaveLength(50);
    expect(observation.changes[0]?.path).toBe('packages/first/new-00.ts');
    expect(observation.changes[49]?.path).toBe('services/second/new-19.ts');
    expect(observation.reason).toMatch(/10 additional changed path/i);
  });

  it('marks a truncated zero-change fallback as partial and evidence as unknown', () => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-observation-'));
    write(workspace, 'a.txt', 'a');
    write(workspace, 'b.txt', 'b');
    const observer = createAttemptDeltaObserver(workspace, { maxFiles: 1 });

    const observation = observer.observe();
    const evidence = buildObservedAttemptEvidence({
      outcome: 'failed',
      outputOrError: 'transport failed',
      observation,
      providerThreadReusable: false,
    });

    expect(observation.coverage).toBe('partial');
    expect(observation.changes).toEqual([]);
    expect(evidence.workspaceEffect).toBe('unknown');
    expect(evidence.reason).toMatch(/limit/i);
  });

  it('keeps known writes when coverage is partial', () => {
    const evidence = buildObservedAttemptEvidence({
      outcome: 'failed',
      outputOrError: 'transport failed',
      observation: {
        changes: [{ path: 'known.ts', additions: 1, deletions: 0, contentHash: 'hash' }],
        coverage: 'partial',
        sources: ['filesystem'],
        reason: 'scan limit reached',
      },
      providerThreadReusable: false,
    });

    expect(evidence.workspaceEffect).toBe('writes-observed');
    expect(evidence.filesChanged.map((change) => change.path)).toEqual(['known.ts']);
    expect(evidence.reason).toBe('scan limit reached');
  });

  it('reports failed coverage when the selected workspace cannot be read', () => {
    workspace = join(tmpdir(), `loop-observation-missing-${Date.now()}`);

    const observation = createAttemptDeltaObserver(workspace).observe();

    expect(observation.coverage).toBe('failed');
    expect(observation.changes).toEqual([]);
    expect(observation.reason).toMatch(/could not be read/i);
  });

  // LT-065: `git rev-parse --show-toplevel` always returns the REAL
  // (symlink-resolved) path. When the caller's own workspaceCwd reaches the
  // observer through a symlink (macOS: everything under /tmp, i.e.
  // /private/tmp) the discovered "authoritative root" and the observer's own
  // `workspace` diverge by exactly the symlink prefix, so
  // `toWorkspaceFileChange`'s `path.relative(workspace, absolutePath)` starts
  // with `../` for every file and is silently dropped — a real write reports
  // as `changes: []` / `writesObserved: false`, defeating the WS5 replay
  // guard this module exists to provide.
  it('still observes a new file when workspaceDir is reached through a symlink', () => {
    const realTarget = mkdtempSync(join(tmpdir(), 'loop-observation-real-'));
    const symlinkParent = mkdtempSync(join(tmpdir(), 'loop-observation-link-'));
    const symlinkPath = join(symlinkParent, 'repo');
    try {
      initRepo(realTarget);
      symlinkSync(realTarget, symlinkPath, 'dir');

      const observer = createAttemptDeltaObserver(symlinkPath);
      write(symlinkPath, 'write1.txt', 'first');

      const observation = observer.observe();
      expect(observation.coverage).toBe('complete');
      expect(observation.changes.map((change) => change.path)).toEqual(['write1.txt']);

      const evidence = buildObservedAttemptEvidence({
        outcome: 'completed',
        outputOrError: 'wrote write1.txt',
        observation,
        providerThreadReusable: false,
      });
      expect(evidence.workspaceEffect).toBe('writes-observed');
    } finally {
      rmSync(symlinkParent, { recursive: true, force: true });
      rmSync(realTarget, { recursive: true, force: true });
    }
  });
});
