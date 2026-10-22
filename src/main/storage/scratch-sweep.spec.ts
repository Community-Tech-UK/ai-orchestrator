import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, lutimesSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { defaultActivityTimeMs, hasActivitySince, sweepScratchFolders } from './scratch-sweep';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - 30 * DAY_MS);
// utimes can move mtime back but always sets ctime to now, so the tests judge
// activity by mtime alone; defaultActivityTimeMs is tested on its own below.
const byMtime = (stat: { mtimeMs: number }) => stat.mtimeMs;

const gitEnv = {
  ...hermeticGitEnv(),
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8' }).trim();
}

/** Set every file and folder under `target` (including it) to `when`. */
function ageTree(target: string, when: Date): void {
  if (statSync(target).isDirectory()) {
    for (const name of readdirSync(target)) ageTree(join(target, name), when);
  }
  utimesSync(target, when, when);
}

describe('sweepScratchFolders', () => {
  let base: string;
  let project: string;
  let scratch: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'scratch-sweep-'));
    project = join(base, 'project');
    mkdirSync(project);
    git(project, 'init', '-q', '-b', 'main');
    writeFileSync(join(project, 'README.md'), 'hello\n');
    git(project, 'add', 'README.md');
    git(project, 'commit', '-q', '-m', 'initial');
    scratch = join(project, 'apps', 'desk', '_scratch');
    mkdirSync(scratch, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(base)) {
      execFileSync('chmod', ['-R', 'u+w', base]);
      rmSync(base, { recursive: true, force: true });
    }
  });

  function sweep(retentionDays = 14) {
    return sweepScratchFolders({ projectRoots: [project], retentionDays, now: NOW, activityTimeMs: byMtime });
  }

  it('removes old entries in nested _scratch folders and keeps recent ones', async () => {
    mkdirSync(join(scratch, 'old-gate'));
    writeFileSync(join(scratch, 'old-gate', 'report.json'), '{}');
    ageTree(join(scratch, 'old-gate'), OLD);
    mkdirSync(join(scratch, 'current-gate'));
    writeFileSync(join(scratch, 'current-gate', 'report.json'), '{}');

    const decisions = await sweep();

    expect(decisions.map((decision) => [decision.kind, decision.path]).sort()).toEqual([
      ['kept-recent', join(scratch, 'current-gate')],
      ['removed', join(scratch, 'old-gate')],
    ]);
    expect(existsSync(join(scratch, 'old-gate'))).toBe(false);
    expect(existsSync(join(scratch, 'current-gate'))).toBe(true);
  });

  it('does nothing when retention is turned off', async () => {
    mkdirSync(join(scratch, 'old-gate'));
    ageTree(join(scratch, 'old-gate'), OLD);

    expect(await sweep(0)).toEqual([]);
    expect(existsSync(join(scratch, 'old-gate'))).toBe(true);
  });

  it('removes an old clone whose commits are all in the project', async () => {
    const clone = join(scratch, 'fresh-gate', 'repo');
    mkdirSync(join(scratch, 'fresh-gate'));
    git(base, 'clone', '-q', project, clone);
    ageTree(join(scratch, 'fresh-gate'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed' });
    expect(existsSync(join(scratch, 'fresh-gate'))).toBe(false);
  });

  it('keeps an old clone holding a commit the project does not have', async () => {
    const clone = join(scratch, 'review-gate', 'repo');
    mkdirSync(join(scratch, 'review-gate'));
    git(base, 'clone', '-q', project, clone);
    writeFileSync(join(clone, 'fix.ts'), 'export const fixed = true;\n');
    git(clone, 'add', 'fix.ts');
    git(clone, 'commit', '-q', '-m', 'fix only made in the copy');
    ageTree(join(scratch, 'review-gate'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('1 commit(s)') });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone with uncommitted edits', async () => {
    const clone = join(scratch, 'dirty-gate');
    git(base, 'clone', '-q', project, clone);
    writeFileSync(join(clone, 'README.md'), 'edited in the copy\n');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('uncommitted changes') });
  });

  it('keeps an old clone with a new file that was never added to git', async () => {
    const clone = join(scratch, 'untracked-gate');
    git(base, 'clone', '-q', project, clone);
    writeFileSync(join(clone, 'new-module.ts'), 'export {};\n');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('uncommitted changes') });
  });

  it('keeps an old detached worktree holding a commit on no branch', async () => {
    const worktree = join(scratch, 'detached-gate');
    git(project, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    writeFileSync(join(worktree, 'fix.ts'), 'export const fixed = true;\n');
    git(worktree, 'add', 'fix.ts');
    git(worktree, 'commit', '-q', '-m', 'fix made only in the detached worktree');
    ageTree(worktree, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('on no branch') });
    expect(existsSync(worktree)).toBe(true);
  });

  it('removes an old detached worktree whose commit is on a branch, and prunes it', async () => {
    const worktree = join(scratch, 'clean-gate');
    git(project, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD');
    ageTree(worktree, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed' });
    expect(git(project, 'worktree', 'list')).not.toContain('clean-gate');
  });

  it('finds a checkout nested inside an _archive folder within an entry', async () => {
    const nested = join(scratch, 'bundle', '_archive', 'repo');
    mkdirSync(join(scratch, 'bundle', '_archive'), { recursive: true });
    git(base, 'clone', '-q', project, nested);
    writeFileSync(join(nested, 'README.md'), 'edited\n');
    ageTree(join(scratch, 'bundle'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
  });

  it('keeps an old bare repository holding a commit the project does not have', async () => {
    const work = join(base, 'work');
    git(base, 'clone', '-q', project, work);
    writeFileSync(join(work, 'fix.ts'), 'export {};\n');
    git(work, 'add', 'fix.ts');
    git(work, 'commit', '-q', '-m', 'only in the bare copy');
    git(base, 'clone', '-q', '--bare', work, join(scratch, 'bare-copy.git'));
    ageTree(join(scratch, 'bare-copy.git'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', path: join(scratch, 'bare-copy.git') });
  });

  it('keeps an old clone whose git folder sits elsewhere in the entry', async () => {
    const entry = join(scratch, 'separate-gate');
    mkdirSync(entry);
    git(base, 'clone', '-q', '--separate-git-dir', join(entry, 'gitdir'), project, join(entry, 'tree'));
    writeFileSync(join(entry, 'tree', 'fix.ts'), 'export {};\n');
    git(join(entry, 'tree'), 'add', 'fix.ts');
    git(join(entry, 'tree'), 'commit', '-q', '-m', 'only in the separate-git-dir clone');
    ageTree(entry, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
  });

  it('keeps an old clone whose commit the project has only as an unreachable object', async () => {
    const clone = join(scratch, 'fetched-gate');
    git(base, 'clone', '-q', project, clone);
    writeFileSync(join(clone, 'fix.ts'), 'export {};\n');
    git(clone, 'add', 'fix.ts');
    git(clone, 'commit', '-q', '-m', 'fetched into the project but on no branch');
    git(project, 'fetch', '-q', clone, 'main');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('not on any branch') });
  });

  it('counts untracked files even when the clone hides them in its config', async () => {
    const clone = join(scratch, 'hidden-untracked');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'config', 'status.showUntrackedFiles', 'no');
    writeFileSync(join(clone, 'new-module.ts'), 'export {};\n');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
  });

  it('leaves other temporarily missing worktrees registered', async () => {
    const elsewhere = join(base, 'on-unplugged-drive');
    git(project, 'worktree', 'add', '-q', '--detach', elsewhere, 'HEAD');
    execFileSync('mv', [elsewhere, `${elsewhere}-away`]);
    mkdirSync(join(scratch, 'old-gate'));
    ageTree(join(scratch, 'old-gate'), OLD);

    await sweep();

    expect(git(project, 'worktree', 'list')).toContain('on-unplugged-drive');
  });

  it('does nothing when the retention setting is not a number', async () => {
    mkdirSync(join(scratch, 'old-gate'));
    ageTree(join(scratch, 'old-gate'), OLD);

    expect(await sweepScratchFolders({ projectRoots: [project], retentionDays: Number.NaN, now: NOW })).toEqual([]);
    expect(existsSync(join(scratch, 'old-gate'))).toBe(true);
  });

  it('checks a repository nested inside an ignored folder of another checkout', async () => {
    const outer = join(scratch, 'outer-gate');
    git(base, 'clone', '-q', project, outer);
    writeFileSync(join(outer, '.gitignore'), 'vendor/\n');
    git(outer, 'add', '.gitignore');
    git(outer, 'commit', '-q', '-m', 'ignore vendor');
    git(project, 'fetch', '-q', outer, 'main:outer-main');
    const inner = join(outer, 'vendor', 'lib');
    mkdirSync(join(outer, 'vendor'));
    git(base, 'clone', '-q', project, inner);
    writeFileSync(join(inner, 'fix.ts'), 'export {};\n');
    git(inner, 'add', 'fix.ts');
    git(inner, 'commit', '-q', '-m', 'only in the nested clone');
    ageTree(outer, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining(inner) });
  });

  it('checks repositories however deeply they are nested', async () => {
    const deep = join(scratch, 'deep-gate', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'repo');
    mkdirSync(join(scratch, 'deep-gate', 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { recursive: true });
    git(base, 'clone', '-q', project, deep);
    writeFileSync(join(deep, 'fix.ts'), 'export {};\n');
    git(deep, 'add', 'fix.ts');
    git(deep, 'commit', '-q', '-m', 'deep commit');
    ageTree(join(scratch, 'deep-gate'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
  });

  it('removes only the link when an entry is a symlink to a real worktree', async () => {
    const realWorktree = join(base, 'real-worktree');
    git(project, 'worktree', 'add', '-q', '--detach', realWorktree, 'HEAD');
    symlinkSync(realWorktree, join(scratch, 'latest'));
    ageTree(realWorktree, OLD);
    lutimesSync(join(scratch, 'latest'), OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: join(scratch, 'latest') });
    expect(existsSync(join(scratch, 'latest'))).toBe(false);
    expect(existsSync(join(realWorktree, 'README.md'))).toBe(true);
    expect(git(project, 'worktree', 'list')).toContain('real-worktree');
  });

  it('keeps an old clone that a worktree outside the folder still depends on', async () => {
    const clone = join(scratch, 'shared-clone');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'worktree', 'add', '-q', '--detach', join(base, 'outside-worktree'), 'HEAD');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('outside this folder') });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone whose submodule has a branch the project does not have', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'submodule-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    const submodule = join(clone, 'lib');
    git(submodule, 'checkout', '-q', '-b', 'mywork');
    writeFileSync(join(submodule, 'fix.ts'), 'export {};\n');
    git(submodule, 'add', 'fix.ts');
    git(submodule, 'commit', '-q', '-m', 'submodule-only work');
    git(submodule, 'checkout', '-q', '--detach', 'HEAD~1');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
  });

  it('removes old entries that agents sealed read-only', async () => {
    const sealed = join(scratch, 'sealed-evidence');
    mkdirSync(join(sealed, 'drafts'), { recursive: true });
    writeFileSync(join(sealed, 'drafts', 'plan.md'), 'draft');
    ageTree(sealed, OLD);
    chmodSync(join(sealed, 'drafts'), 0o500);
    chmodSync(sealed, 0o500);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed' });
    expect(existsSync(sealed)).toBe(false);
  });

  it('reports what it would remove without deleting in a dry run', async () => {
    mkdirSync(join(scratch, 'old-gate'));
    ageTree(join(scratch, 'old-gate'), OLD);

    const decisions = await sweepScratchFolders({
      projectRoots: [project], retentionDays: 14, now: NOW, dryRun: true, activityTimeMs: byMtime,
    });

    expect(decisions).toEqual([{ kind: 'removed', path: join(scratch, 'old-gate') }]);
    expect(existsSync(join(scratch, 'old-gate'))).toBe(true);
  });

  it('never sweeps broad roots such as the filesystem root', async () => {
    expect(await sweepScratchFolders({ projectRoots: ['/'], retentionDays: 14, now: NOW })).toEqual([]);
  });
});

describe('hasActivitySince', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'scratch-activity-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('ignores dependency folders when judging activity', async () => {
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(base, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(base, 'report.json'), '{}');
    ageTree(join(base, 'report.json'), OLD);
    utimesSync(base, OLD, OLD);

    expect(await hasActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toBe(false);
  });

  it('notices a recently changed file deep inside', async () => {
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    ageTree(base, OLD);
    writeFileSync(join(base, 'a', 'b', 'new.log'), 'x');
    utimesSync(join(base, 'a', 'b'), OLD, OLD);

    expect(await hasActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toBe(true);
  });

  it('counts a fresh copy that kept old modification times as recent', () => {
    expect(defaultActivityTimeMs({ mtimeMs: NOW - 400 * DAY_MS, ctimeMs: NOW - 1_000 })).toBe(NOW - 1_000);
    expect(defaultActivityTimeMs({ mtimeMs: NOW - 2_000, ctimeMs: NOW - 400 * DAY_MS })).toBe(NOW - 2_000);
  });

  it('treats a real copy made just now as recent by default', async () => {
    writeFileSync(join(base, 'copied.json'), '{}');
    utimesSync(join(base, 'copied.json'), OLD, OLD);
    utimesSync(base, OLD, OLD);

    expect(await hasActivitySince(base, NOW - 14 * DAY_MS)).toBe(true);
  });
});
