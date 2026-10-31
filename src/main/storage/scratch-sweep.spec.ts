import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, lutimesSync, renameSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { defaultActivityTimeMs, scanActivitySince, sweepScratchFolders } from './scratch-sweep';

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

/** Make a test tree deletable again, including folders sealed without read permission. */
function wipeTree(target: string): void {
  try {
    chmodSync(target, 0o700);
    for (const entry of readdirSync(target, { withFileTypes: true })) {
      if (entry.isDirectory()) wipeTree(join(target, entry.name));
    }
  } catch {
    // Best effort: rmSync below reports anything still stuck.
  }
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
      wipeTree(base);
      rmSync(base, { recursive: true, force: true });
    }
  });

  function sweep(retentionDays = 14) {
    return sweepScratchFolders({ projectRoots: [project], retentionDays, now: NOW, activityTimeMs: byMtime });
  }

  /** Let the project keep none of its own objects and read them from `store` (or a chain reaching it). */
  function makeProjectReadObjectsFrom(store: string): void {
    const objects = join(project, '.git', 'objects');
    mkdirSync(join(objects, 'info'), { recursive: true });
    rmSync(join(objects, 'pack'), { recursive: true, force: true });
    for (const name of readdirSync(objects)) {
      if (/^[0-9a-f]{2}$/.test(name)) rmSync(join(objects, name), { recursive: true, force: true });
    }
    writeFileSync(join(objects, 'info', 'alternates'), `${store}\n`);
  }

  /**
   * Move the project's own objects out to `durable` (outside `_scratch`) and
   * leave the store folder empty, so the project can only read its history
   * back through an alternates list the test places.
   */
  function moveProjectObjectsTo(durable: string): string {
    const objects = join(project, '.git', 'objects');
    mkdirSync(durable);
    mkdirSync(join(objects, 'info'), { recursive: true });
    for (const name of readdirSync(objects)) {
      if (name !== 'info') renameSync(join(objects, name), join(durable, name));
    }
    return objects;
  }

  /** Sweep with the default activity times and `now` advanced 30 days: every entry is old. */
  function sweepAllOld() {
    return sweepScratchFolders({ projectRoots: [project], retentionDays: 14, now: NOW + 30 * DAY_MS });
  }

  /**
   * Git's C-style quoting of a path (git's own `quote_c_style`): printable
   * ASCII stays raw, every other byte — a UTF-8 continuation byte included —
   * becomes a three-digit octal escape. Git writes records like this and reads
   * them back as BYTES: `café` is spelled `caf\303\251`, not `cafÃ©`.
   */
  function gitCQuote(target: string): string {
    let quoted = '"';
    for (const byte of Buffer.from(target, 'utf8')) {
      quoted += byte >= 0x20 && byte <= 0x7e && byte !== 0x22 && byte !== 0x5c
        ? String.fromCharCode(byte)
        : `\\${byte.toString(8).padStart(3, '0')}`;
    }
    return `${quoted}"`;
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

  it('removes an old top-level file entry', async () => {
    const dump = join(scratch, 'old-dump.bin');
    writeFileSync(dump, 'binary dump\n');
    ageTree(dump, OLD);

    const decisions = await sweep();

    expect(decisions).toEqual([{ kind: 'removed', path: dump }]);
    expect(existsSync(dump)).toBe(false);
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

  it('keeps an old clone whose remote is gone even though its commits sit on remote-tracking refs', async () => {
    const source = join(base, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'unique.ts'), 'export {};\n');
    git(source, 'add', 'unique.ts');
    git(source, 'commit', '-q', '-m', 'only in the source');
    const clone = join(scratch, 'orphan-gate');
    git(base, 'clone', '-q', source, clone);
    rmSync(source, { recursive: true, force: true });
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('1 commit(s)') });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone whose history the owning project has only in part', async () => {
    const source = join(base, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(source, `${name}.ts`), 'export {};\n');
      git(source, 'add', `${name}.ts`);
      git(source, 'commit', '-q', '-m', name);
    }
    // A depth-1 owner holds only the tip; the older commits exist solely in the
    // scratch copy, and the remote that made them is gone.
    const shallowProject = join(base, 'shallow-project');
    git(base, 'clone', '-q', '--depth', '1', `file://${source}`, shallowProject);
    const shallowScratch = join(shallowProject, 'apps', 'desk', '_scratch');
    mkdirSync(shallowScratch, { recursive: true });
    const clone = join(shallowScratch, 'full-history');
    git(base, 'clone', '-q', source, clone);
    rmSync(source, { recursive: true, force: true });
    ageTree(clone, OLD);

    const decisions = await sweepScratchFolders({
      projectRoots: [shallowProject], retentionDays: 14, now: NOW, activityTimeMs: byMtime,
    });

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: clone, reason: expect.stringContaining('2 commit(s)') },
    ]);
    expect(existsSync(clone)).toBe(true);
  });

  it('removes an old clone whose whole history the owning project also has', async () => {
    const source = join(base, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(source, `${name}.ts`), 'export {};\n');
      git(source, 'add', `${name}.ts`);
      git(source, 'commit', '-q', '-m', name);
    }
    const fullProject = join(base, 'full-project');
    git(base, 'clone', '-q', `file://${source}`, fullProject);
    const projectScratch = join(fullProject, 'apps', 'desk', '_scratch');
    mkdirSync(projectScratch, { recursive: true });
    const clone = join(projectScratch, 'full-history');
    git(base, 'clone', '-q', source, clone);
    rmSync(source, { recursive: true, force: true });
    ageTree(clone, OLD);

    const decisions = await sweepScratchFolders({
      projectRoots: [fullProject], retentionDays: 14, now: NOW, activityTimeMs: byMtime,
    });

    expect(decisions).toEqual([{ kind: 'removed', path: clone }]);
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone that holds the last copy of a blob the project is missing', async () => {
    const source = join(base, 'source');
    mkdirSync(source);
    git(source, 'init', '-q', '-b', 'main');
    writeFileSync(join(source, 'draft.txt'), 'draft one\n');
    git(source, 'add', 'draft.txt');
    git(source, 'commit', '-q', '-m', 'first draft');
    writeFileSync(join(source, 'draft.txt'), 'draft two\n');
    git(source, 'add', 'draft.txt');
    git(source, 'commit', '-q', '-m', 'second draft');
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    // A --filter=blob:none project has every commit but only fetched the blobs
    // its checkout needed; the historical draft exists solely in the full copy.
    const partialProject = join(base, 'partial-project');
    git(base, 'clone', '-q', '--filter=blob:none', `file://${source}`, partialProject);
    const partialScratch = join(partialProject, 'apps', 'desk', '_scratch');
    mkdirSync(partialScratch, { recursive: true });
    const clone = join(partialScratch, 'full-history');
    git(base, 'clone', '-q', source, clone);
    rmSync(source, { recursive: true, force: true });
    ageTree(clone, OLD);
    expect(git(partialProject, 'rev-list', '--objects', '--all', '--missing=print')
      .split('\n').some((line) => line.startsWith('?'))).toBe(true);

    const decisions = await sweepScratchFolders({
      projectRoots: [partialProject], retentionDays: 14, now: NOW, activityTimeMs: byMtime,
    });

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: clone, reason: expect.stringContaining('last copy') },
    ]);
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone the project reads its objects from', async () => {
    const clone = join(scratch, 'object-source');
    git(base, 'clone', '-q', project, clone);
    // The project keeps no objects of its own: its history is readable only
    // through the clone's store, named by objects/info/alternates. Removing the
    // clone would break the project with `fatal: bad object HEAD`.
    makeProjectReadObjectsFrom(join(clone, '.git', 'objects'));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old clone the project reaches through a chain of object stores', async () => {
    const clone = join(scratch, 'chained-object-source');
    git(base, 'clone', '-q', project, clone);
    const middle = join(base, 'middle-store', 'objects');
    mkdirSync(join(middle, 'info'), { recursive: true });
    writeFileSync(join(middle, 'info', 'alternates'), `${join(clone, '.git', 'objects')}\n`);
    makeProjectReadObjectsFrom(middle);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old clone when it cannot read the project object store links', async () => {
    const clone = join(scratch, 'unreadable-links');
    git(base, 'clone', '-q', project, clone);
    const alternates = join(project, '.git', 'objects', 'info', 'alternates');
    mkdirSync(join(project, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(alternates, `${join(base, 'nowhere', 'objects')}\n`);
    ageTree(clone, OLD);
    chmodSync(alternates, 0o000);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not read the object stores'),
    });
    expect(existsSync(clone)).toBe(true);
  });

  it('removes an old clone when the project shares objects only with stores outside the folder', async () => {
    const clone = join(scratch, 'outside-share');
    git(base, 'clone', '-q', project, clone);
    const outside = join(base, 'outside-store', 'objects');
    mkdirSync(join(outside, 'info'), { recursive: true });
    writeFileSync(join(project, '.git', 'objects', 'info', 'alternates'), `${outside}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone the project names through a C-quoted object store path', async () => {
    const clone = join(scratch, 'quoted object source');
    git(base, 'clone', '-q', project, clone);
    // The project keeps no objects of its own and names the clone's store the
    // way git spells paths that need quoting (C-style, as git's own unquote
    // reads it). A reader that takes the line literally names a path with
    // quote characters in it, misses the store, and deletes the project's only
    // objects — the ENOENT under the invented name ends the chain as normal.
    makeProjectReadObjectsFrom(JSON.stringify(join(clone, '.git', 'objects')));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old clone the project names through a C-quoted path with escapes', async () => {
    const clone = join(scratch, 'we\\ird "clone"');
    git(base, 'clone', '-q', project, clone);
    makeProjectReadObjectsFrom(JSON.stringify(join(clone, '.git', 'objects')));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old clone the project reaches through a C-quoted chain of object stores', async () => {
    const clone = join(scratch, 'quoted-chain-source');
    git(base, 'clone', '-q', project, clone);
    const middle = join(base, 'middle store', 'objects');
    mkdirSync(join(middle, 'info'), { recursive: true });
    writeFileSync(join(middle, 'info', 'alternates'), `${join(clone, '.git', 'objects')}\n`);
    // The quoted name is the first link of the chain: read as a plain path it
    // invents one that does not exist, and the ENOENT under that name ends the
    // chain right there — the store the chain ends in is never seen.
    makeProjectReadObjectsFrom(JSON.stringify(middle));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work' });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old clone when an object store link record cannot be decoded', async () => {
    const clone = join(scratch, 'undecodable-links');
    git(base, 'clone', '-q', project, clone);
    // A record git's quoting cannot decode — a truncated write naming the
    // clone's store here — may name any store at all. Reading it as a plain
    // path invents one that does not exist and ends the chain as if it were
    // over, so the independence of every entry stays unproven.
    const alternates = join(project, '.git', 'objects', 'info', 'alternates');
    mkdirSync(join(project, '.git', 'objects', 'info'), { recursive: true });
    writeFileSync(alternates, `"${join(clone, '.git', 'objects')}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not read the object stores'),
    });
    expect(existsSync(clone)).toBe(true);
  });

  it('removes an old clone when a C-quoted object store link names only stores outside the folder', async () => {
    const clone = join(scratch, 'quoted-outside');
    git(base, 'clone', '-q', project, clone);
    const outside = join(base, 'outside store', 'objects');
    mkdirSync(join(outside, 'info'), { recursive: true });
    writeFileSync(join(project, '.git', 'objects', 'info', 'alternates'), `${JSON.stringify(outside)}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone the project names through octal byte escapes in a C-quoted object store path', async () => {
    const clone = join(scratch, 'café-source');
    git(base, 'clone', '-q', project, clone);
    // Git spells a path's non-ASCII bytes as octal escapes inside a C-quoted
    // record (verified against git on this Mac): `café` is written
    // `caf\303\251` — the two UTF-8 bytes of `é`. Those escapes decode BYTES
    // with the filesystem encoding; read as characters instead, the record
    // names `cafÃ©-source`, a path that does not exist, and the ENOENT under
    // that invented name ends the chain as if it were over: the store the
    // record really names is never seen and the project's only objects are
    // deleted.
    makeProjectReadObjectsFrom(gitCQuote(join(clone, '.git', 'objects')));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(clone)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('removes an old clone when an octal-escaped C-quoted link names only stores outside the folder', async () => {
    const clone = join(scratch, 'octal-outside');
    git(base, 'clone', '-q', project, clone);
    const outside = join(base, 'outside-café-store', 'objects');
    mkdirSync(join(outside, 'info'), { recursive: true });
    writeFileSync(join(project, '.git', 'objects', 'info', 'alternates'), `${gitCQuote(outside)}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('removes an old plain folder even when the project is missing objects', async () => {
    writeFileSync(join(project, 'extra.txt'), 'export {};\n');
    git(project, 'add', 'extra.txt');
    git(project, 'commit', '-q', '-m', 'second');
    const blob = git(project, 'rev-parse', 'HEAD~1:README.md');
    rmSync(join(project, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    expect(git(project, 'rev-list', '--objects', '--all', '--missing=print')
      .split('\n').some((line) => line.startsWith('?'))).toBe(true);
    const report = join(scratch, 'old-report');
    mkdirSync(report);
    writeFileSync(join(report, 'report.json'), '{}');
    ageTree(report, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: report });
    expect(existsSync(report)).toBe(false);
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

  it('removes an old bare repository whose commits are all in the project', async () => {
    git(base, 'clone', '-q', '--bare', project, join(scratch, 'mirror.git'));
    ageTree(join(scratch, 'mirror.git'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: join(scratch, 'mirror.git') });
    expect(existsSync(join(scratch, 'mirror.git'))).toBe(false);
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

  it('removes an old clone whose git folder sits elsewhere in the entry when its commits are all in the project', async () => {
    const entry = join(scratch, 'separate-clean');
    mkdirSync(entry);
    git(base, 'clone', '-q', '--separate-git-dir', join(entry, 'gitdir'), project, join(entry, 'tree'));
    ageTree(entry, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: entry });
    expect(existsSync(entry)).toBe(false);
  });

  it('keeps an old git folder whose checkout lives outside the folder', async () => {
    const entry = join(scratch, 'separate-store');
    mkdirSync(entry);
    const outside = join(base, 'outside-checkout');
    git(base, 'clone', '-q', '--separate-git-dir', join(entry, 'gitdir'), project, outside);
    ageTree(entry, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not find the checkout'),
    });
    expect(existsSync(join(entry, 'gitdir'))).toBe(true);
    expect(git(outside, 'status', '--porcelain')).toBe('');
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

  it('checks a checkout nested inside node_modules', async () => {
    const dep = join(scratch, 'bundle', 'node_modules', 'local-dep');
    mkdirSync(join(scratch, 'bundle', 'node_modules'), { recursive: true });
    git(base, 'clone', '-q', project, dep);
    writeFileSync(join(dep, 'fix.ts'), 'export {};\n');
    git(dep, 'add', 'fix.ts');
    git(dep, 'commit', '-q', '-m', 'only in the nested dependency checkout');
    ageTree(join(scratch, 'bundle'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining(dep) });
    expect(existsSync(join(scratch, 'bundle'))).toBe(true);
  });

  it('removes an old entry whose nested dependency checkout is a clean copy of the project', async () => {
    const dep = join(scratch, 'bundle', 'node_modules', 'local-dep');
    mkdirSync(join(scratch, 'bundle', 'node_modules'), { recursive: true });
    git(base, 'clone', '-q', project, dep);
    ageTree(join(scratch, 'bundle'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed' });
    expect(existsSync(join(scratch, 'bundle'))).toBe(false);
  });

  it('removes an old gate copy that includes an installed dependency tree', async () => {
    mkdirSync(join(scratch, 'old-gate', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(scratch, 'old-gate', 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
    writeFileSync(join(scratch, 'old-gate', 'report.json'), '{}');
    ageTree(join(scratch, 'old-gate'), OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed' });
    expect(existsSync(join(scratch, 'old-gate'))).toBe(false);
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

  it('keeps an old symlink entry the project object store chain runs through', async () => {
    const target = join(base, 'object-store-target');
    git(base, 'clone', '-q', project, target);
    symlinkSync(target, join(scratch, 'store-link'));
    // The project keeps no objects of its own and names the target's store
    // through the symlink entry. Every git command re-resolves that name, so
    // unlinking the link strands the project with `fatal: bad object HEAD`
    // even though the objects themselves live outside the entry.
    makeProjectReadObjectsFrom(join(scratch, 'store-link', '.git', 'objects'));
    ageTree(target, OLD);
    lutimesSync(join(scratch, 'store-link'), OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(join(scratch, 'store-link'))).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old symlink entry the project object store chain cannot fully resolve', async () => {
    const entry = join(scratch, 'hop-link');
    symlinkSync(join(base, 'unplugged', 'objects'), entry);
    symlinkSync(entry, join(base, 'alias'));
    // The entry is a hop of a name whose next hop — the unplugged drive the
    // link points at — cannot be resolved right now. The independence of the
    // entry from the name is then unproven (the drive may come back and the
    // name may run through here), so the entry is kept instead of unlinked.
    writeFileSync(join(project, '.git', 'objects', 'info', 'alternates'), `${join(base, 'alias')}\n`);
    // The link dangles (its target is unplugged), so age it by hand — ageTree
    // follows links and would fail on the missing target.
    lutimesSync(entry, OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not resolve the object stores'),
    });
    // existsSync follows the link and its unplugged target; lstat sees the link itself.
    expect(lstatSync(entry).isSymbolicLink()).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old folder the project object store name resolves through', async () => {
    const entry = join(scratch, 'hop-entry');
    mkdirSync(entry);
    const durable = join(base, 'durable-store');
    git(base, 'clone', '-q', project, durable);
    symlinkSync(join(durable, '.git', 'objects'), join(entry, 'ln'));
    symlinkSync(join(entry, 'ln'), join(base, 'alias'));
    // The project names the store through `alias`, a symlink outside the entry
    // whose target spelling runs through the entry's own `ln` link before it
    // lands on the durable store outside: alias to entry to symlink to durable
    // store. Neither the name's lexical spelling nor its final realpath touches
    // the entry, but every git command re-resolves the name through `ln`, so
    // removing the entry strands the project (`unable to normalize alternate
    // object path` and its objects become unreadable).
    makeProjectReadObjectsFrom(join(base, 'alias'));
    ageTree(entry, OLD);
    lutimesSync(join(entry, 'ln'), OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old folder whose symlink the project object store chain runs through', async () => {
    const entry = join(scratch, 'linked-store');
    mkdirSync(entry);
    const target = join(base, 'outside-target');
    git(base, 'clone', '-q', project, target);
    symlinkSync(target, join(entry, 'objects-link'));
    // The chain names the store through the symlink the entry holds: the
    // objects resolve outside the entry, but the name the project re-resolves
    // on every git command runs through the entry and dies with it.
    makeProjectReadObjectsFrom(join(entry, 'objects-link', '.git', 'objects'));
    ageTree(entry, OLD);
    lutimesSync(join(entry, 'objects-link'), OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('reads objects from inside this folder'),
    });
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('removes an old folder whose symlink the project object stores do not run through', async () => {
    const entry = join(scratch, 'plain-link-dir');
    mkdirSync(entry);
    mkdirSync(join(base, 'link-target'));
    symlinkSync(join(base, 'link-target'), join(entry, 'sub'));
    ageTree(entry, OLD);
    lutimesSync(join(entry, 'sub'), OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: entry });
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(join(base, 'link-target'))).toBe(true);
  });

  it('keeps an old file the project reads its alternates list through', async () => {
    const durable = join(base, 'durable-objects');
    const objects = moveProjectObjectsTo(durable);
    const list = join(scratch, 'alternate-list');
    writeFileSync(list, `${durable}\n`);
    symlinkSync(list, join(objects, 'info', 'alternates'));
    // The project keeps no objects of its own and reads its alternates list
    // through the entry: the list is the metadata its whole object graph hangs
    // on. Removing the file leaves the project's own link dangling and
    // `git log` fails with `fatal: bad object HEAD` even though the objects
    // themselves live outside the entry.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: list, reason: expect.stringContaining('object store links') },
    ]);
    expect(existsSync(list)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old folder the project reads its alternates list through', async () => {
    const durable = join(base, 'durable-objects');
    const objects = moveProjectObjectsTo(durable);
    const entry = join(scratch, 'alternate-list');
    mkdirSync(entry);
    writeFileSync(join(entry, 'alternates'), `${durable}\n`);
    symlinkSync(join(entry, 'alternates'), join(objects, 'info', 'alternates'));
    // The same metadata sits in a plain folder entry: `objects/info/alternates`
    // is a symlink to `_scratch/alternate-list/alternates`, so the folder is
    // what the project's link resolves through and it must outlive the sweep.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store links') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old file a chained store of the project reads its alternates list through', async () => {
    const durable = join(base, 'durable-objects');
    const objects = moveProjectObjectsTo(durable);
    const middle = join(base, 'middle-store', 'objects');
    mkdirSync(join(middle, 'info'), { recursive: true });
    const list = join(scratch, 'chain-list');
    writeFileSync(list, `${durable}\n`);
    symlinkSync(list, join(middle, 'info', 'alternates'));
    writeFileSync(join(objects, 'info', 'alternates'), `${middle}\n`);
    // The link that runs through the entry is not the project's own but the
    // chained store's: the project names `middle`, `middle`'s own
    // `info/alternates` resolves through the entry to the list that names the
    // durable store. Breaking that hop ends the chain and the project loses
    // its last objects.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: list, reason: expect.stringContaining('object store links') },
    ]);
    expect(existsSync(list)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old folder the project alternates list resolves through', async () => {
    const durable = join(base, 'durable-objects');
    const objects = moveProjectObjectsTo(durable);
    const entry = join(scratch, 'hop-entry');
    mkdirSync(entry);
    const list = join(base, 'alternate-list');
    writeFileSync(list, `${durable}\n`);
    symlinkSync(list, join(entry, 'ln'));
    symlinkSync(join(entry, 'ln'), join(objects, 'info', 'alternates'));
    // The project's link resolves through the entry at an intermediate hop
    // (alias to entry to symlink to the list) and lands outside it: neither
    // the name as spelled nor where it lands touches the entry, but the
    // resolution runs through `ln` inside it and dies with the folder.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store links') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old symlink entry the project alternates list runs through', async () => {
    const durable = join(base, 'durable-objects');
    const objects = moveProjectObjectsTo(durable);
    const list = join(base, 'alternate-list');
    writeFileSync(list, `${durable}\n`);
    symlinkSync(list, join(scratch, 'list-link'));
    symlinkSync(join(scratch, 'list-link'), join(objects, 'info', 'alternates'));
    // The entry is the symlink the project's own link resolves through to the
    // list. Unlinking the entry breaks the project's resolution even though
    // the list itself lives outside the folder.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: join(scratch, 'list-link'), reason: expect.stringContaining('object store links') },
    ]);
    expect(lstatSync(join(scratch, 'list-link')).isSymbolicLink()).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('removes old file and folder entries when the project alternates list does not run through the folder', async () => {
    const durable = join(base, 'durable-objects');
    moveProjectObjectsTo(durable);
    const list = join(base, 'alternate-list');
    writeFileSync(list, `${durable}\n`);
    symlinkSync(list, join(project, '.git', 'objects', 'info', 'alternates'));
    const dump = join(scratch, 'old-dump.bin');
    writeFileSync(dump, 'binary dump\n');
    const report = join(scratch, 'old-report');
    mkdirSync(report);
    writeFileSync(join(report, 'report.json'), '{}');
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions.map((decision) => [decision.kind, decision.path]).sort()).toEqual([
      ['removed', dump],
      ['removed', report],
    ]);
    expect(existsSync(dump)).toBe(false);
    expect(existsSync(report)).toBe(false);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old entry holding the project object store pack folder', async () => {
    git(project, 'gc', '-q');
    const objects = join(project, '.git', 'objects');
    const entry = join(scratch, 'moved-pack');
    mkdirSync(entry);
    renameSync(join(objects, 'pack'), join(entry, 'pack'));
    symlinkSync(join(entry, 'pack'), join(objects, 'pack'));
    // Every reachable object now lives in the pack folder the entry holds
    // behind a link: removing the entry leaves `objects/pack` dangling and
    // `git log` fails with `cannot read commit object` even though the pack
    // itself is untouched.
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store contents') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');
  });

  it('keeps an old entry holding a pack file the project object store pack folder links to', async () => {
    git(project, 'gc', '-q');
    const packDir = join(project, '.git', 'objects', 'pack');
    const entry = join(scratch, 'moved-pack-file');
    mkdirSync(entry);
    for (const name of readdirSync(packDir).filter((file) => file.endsWith('.pack'))) {
      renameSync(join(packDir, name), join(entry, name));
      symlinkSync(join(entry, name), join(packDir, name));
    }
    // One `.pack` of the store is read through the entry: the index stays in
    // place but the objects themselves only answer through the link, so
    // removing the entry strands the owner's whole history.
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store contents') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');
  });

  it('keeps an old entry holding the project loose-object fanouts', async () => {
    const objects = join(project, '.git', 'objects');
    const entry = join(scratch, 'moved-loose');
    mkdirSync(entry);
    for (const name of readdirSync(objects)) {
      if (!/^[0-9a-f]{2}$/.test(name)) continue;
      renameSync(join(objects, name), join(entry, name));
      symlinkSync(join(entry, name), join(objects, name));
    }
    // The project's only loose objects — its commit, tree and README blob —
    // sit in the entry behind links: removing it leaves the fanouts dangling
    // and `git log` fails with `bad object HEAD`.
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store contents') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');
  });

  it('keeps an old folder the project object store contents resolve through', async () => {
    git(project, 'gc', '-q');
    const objects = join(project, '.git', 'objects');
    const durable = join(base, 'durable-pack');
    mkdirSync(durable);
    renameSync(join(objects, 'pack'), join(durable, 'pack'));
    const entry = join(scratch, 'hop-entry');
    mkdirSync(entry);
    symlinkSync(join(durable, 'pack'), join(entry, 'ln'));
    symlinkSync(join(entry, 'ln'), join(objects, 'pack'));
    // `objects/pack` resolves through the entry at an intermediate hop (alias
    // to entry to symlink to the durable pack) and lands outside it: removing
    // the folder leaves the name unable to normalize and the pack unreadable
    // even though the objects themselves are untouched.
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store contents') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
  });

  it('keeps an old pack file entry the project object store links to', async () => {
    git(project, 'gc', '-q');
    const packDir = join(project, '.git', 'objects', 'pack');
    const moved = readdirSync(packDir).find((file) => file.endsWith('.pack'));
    expect(moved).toBeDefined();
    const entry = join(scratch, 'moved.pack');
    renameSync(join(packDir, moved!), entry);
    symlinkSync(entry, join(packDir, moved!));
    // The entry is the moved `.pack` itself: a plain file, the only copy of
    // every packed object, reached only through the store's link into it.
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('object store contents') },
    ]);
    expect(existsSync(entry)).toBe(true);
    expect(git(project, 'log', '--oneline')).not.toBe('');
    expect(git(project, 'show', 'HEAD:README.md')).toBe('hello');
  });

  it('keeps entries when it cannot read the project object store contents', async () => {
    git(project, 'gc', '-q');
    // A folder below the store root that cannot be read may hold links to the
    // only copy of the owner's objects, so its contents are unproven and every
    // entry must outlive the sweep.
    const locked = join(project, '.git', 'objects', 'pack', 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'note.txt'), 'unproven\n');
    chmodSync(locked, 0o100);
    const entry = join(scratch, 'old-gate');
    mkdirSync(entry);
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([
      { kind: 'kept-unsaved-work', path: entry, reason: expect.stringContaining('could not read the object stores') },
    ]);
    expect(existsSync(entry)).toBe(true);
  });

  it('removes old entries when the project object store contents sit outside the folder', async () => {
    git(project, 'gc', '-q');
    const objects = join(project, '.git', 'objects');
    const durable = join(base, 'durable-pack');
    mkdirSync(durable);
    renameSync(join(objects, 'pack'), join(durable, 'pack'));
    symlinkSync(join(durable, 'pack'), join(objects, 'pack'));
    const dump = join(scratch, 'old-dump.bin');
    writeFileSync(dump, 'binary dump\n');
    expect(git(project, 'log', '--oneline')).not.toBe('');

    const decisions = await sweepAllOld();

    expect(decisions).toEqual([{ kind: 'removed', path: dump }]);
    expect(existsSync(dump)).toBe(false);
    expect(git(project, 'log', '--oneline')).not.toBe('');
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

  it('keeps an old clone whose worktree registry points at a checkout it cannot read', async () => {
    const clone = join(scratch, 'sealed-registry');
    git(base, 'clone', '-q', project, clone);
    const sealed = join(base, 'sealed');
    mkdirSync(sealed);
    git(clone, 'worktree', 'add', '-q', '--detach', join(sealed, 'checkout'), 'HEAD');
    ageTree(clone, OLD);
    chmodSync(sealed, 0o000);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not resolve the worktree'),
    });
    expect(existsSync(clone)).toBe(true);
    chmodSync(sealed, 0o700);
    expect(git(clone, 'worktree', 'list')).toContain('checkout');
  });

  it('keeps an old clone whose worktree registration it cannot read', async () => {
    const clone = join(scratch, 'broken-registry');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'worktree', 'add', '-q', '--detach', join(base, 'registry-worktree'), 'HEAD');
    writeFileSync(join(clone, '.git', 'worktrees', 'registry-worktree', 'gitdir'), '');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('could not read the worktree registration'),
    });
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

  it('keeps an old clone whose deinitialized submodule holds a commit the project does not have', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'deinit-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    const submodule = join(clone, 'lib');
    writeFileSync(join(submodule, 'fix.ts'), 'export {};\n');
    git(submodule, 'add', 'fix.ts');
    git(submodule, 'commit', '-q', '-m', 'submodule-only work');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('1 commit(s)'),
    });
    expect(decision).toMatchObject({
      reason: expect.stringContaining(join(clone, '.git', 'modules', 'lib')),
    });
    expect(existsSync(join(clone, '.git', 'modules', 'lib'))).toBe(true);
  });

  it('removes an old clone whose deinitialized submodule only holds commits the project also has', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'deinit-clean');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone whose deinitialized submodule staged work it never committed', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'deinit-staged');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    const submodule = join(clone, 'lib');
    writeFileSync(join(submodule, 'staged.ts'), 'export {};\n');
    git(submodule, 'add', 'staged.ts');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(decision).toMatchObject({
      reason: expect.stringContaining(join(clone, '.git', 'modules', 'lib')),
    });
    expect(existsSync(join(clone, '.git', 'modules', 'lib'))).toBe(true);
  });

  it('keeps an old clone whose deinitialized nested submodule holds a commit the project does not have', async () => {
    const inner = join(base, 'inner');
    mkdirSync(inner);
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'inner.ts'), 'export {};\n');
    git(inner, 'add', 'inner.ts');
    git(inner, 'commit', '-q', '-m', 'inner');
    const outer = join(base, 'outer');
    mkdirSync(outer);
    git(outer, 'init', '-q', '-b', 'main');
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'deep');
    git(outer, 'commit', '-q', '-m', 'outer with deep');
    const clone = join(scratch, 'nested-deinit-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', outer, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', outer, 'main:outer-main');
    git(project, 'fetch', '-q', inner, 'main:inner-main');
    const deep = join(clone, 'lib', 'deep');
    writeFileSync(join(deep, 'fix.ts'), 'export {};\n');
    git(deep, 'add', 'fix.ts');
    git(deep, 'commit', '-q', '-m', 'deep-only work');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('modules/lib/modules/deep'),
    });
    expect(existsSync(join(clone, '.git', 'modules', 'lib', 'modules', 'deep'))).toBe(true);
    // Nested `submodule update --init --recursive` setup is inherently slow.
  }, 20_000);

  it('keeps an old clone whose deinitialized submodule is stored under a slash name', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'slash-name-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', '--name', 'vendor/lib', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add named submodule');
    git(project, 'fetch', '-q', clone, 'main:with-named-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    const submodule = join(clone, 'lib');
    writeFileSync(join(submodule, 'fix.ts'), 'export {};\n');
    git(submodule, 'add', 'fix.ts');
    git(submodule, 'commit', '-q', '-m', 'submodule-only work');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('1 commit(s)'),
    });
    expect(decision).toMatchObject({
      reason: expect.stringContaining(join(clone, '.git', 'modules', 'vendor', 'lib')),
    });
    expect(existsSync(join(clone, '.git', 'modules', 'vendor', 'lib'))).toBe(true);
  });

  it('keeps an old clone whose deinitialized submodule is configured to a checkout outside the folder', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'external-checkout-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    const store = join(clone, '.git', 'modules', 'lib');
    const outside = join(base, 'external-checkout');
    mkdirSync(outside);
    writeFileSync(join(outside, '.git'), `gitdir: ${store}\n`);
    writeFileSync(join(outside, 'lib.ts'), 'export {};\n');
    git(base, 'config', '--file', join(store, 'config'), 'core.worktree', outside);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('the configured checkout'),
    });
    expect(decision).toMatchObject({
      reason: expect.stringContaining(join(clone, '.git', 'modules', 'lib')),
    });
    expect(existsSync(store)).toBe(true);
    expect(git(outside, 'status', '--porcelain')).toBe('');
  });

  it('keeps an old clone whose deinitialized nested submodule is configured to a checkout outside the folder', async () => {
    const inner = join(base, 'inner');
    mkdirSync(inner);
    git(inner, 'init', '-q', '-b', 'main');
    writeFileSync(join(inner, 'inner.ts'), 'export {};\n');
    git(inner, 'add', 'inner.ts');
    git(inner, 'commit', '-q', '-m', 'inner');
    const outer = join(base, 'outer');
    mkdirSync(outer);
    git(outer, 'init', '-q', '-b', 'main');
    git(outer, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'deep');
    git(outer, 'commit', '-q', '-m', 'outer with deep');
    const clone = join(scratch, 'nested-external-checkout-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', outer, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', outer, 'main:outer-main');
    git(project, 'fetch', '-q', inner, 'main:inner-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    const store = join(clone, '.git', 'modules', 'lib', 'modules', 'deep');
    const outside = join(base, 'nested-external-checkout');
    mkdirSync(outside);
    writeFileSync(join(outside, '.git'), `gitdir: ${store}\n`);
    writeFileSync(join(outside, 'inner.ts'), 'export {};\n');
    git(base, 'config', '--file', join(store, 'config'), 'core.worktree', outside);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('the configured checkout'),
    });
    expect(decision).toMatchObject({
      reason: expect.stringContaining(join(clone, '.git', 'modules', 'lib', 'modules', 'deep')),
    });
    expect(existsSync(store)).toBe(true);
    expect(git(outside, 'status', '--porcelain')).toBe('');
    // Nested `submodule update --init --recursive` setup is inherently slow.
  }, 20_000);

  it('keeps a submodule store that serves an outside checkout configured through worktree config', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'worktree-config-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    const store = join(clone, '.git', 'modules', 'lib');
    const outside = join(base, 'worktree-config-checkout');
    mkdirSync(outside);
    writeFileSync(join(outside, '.git'), `gitdir: ${store}\n`);
    writeFileSync(join(outside, 'lib.ts'), 'export {};\n');
    // `core.worktree` lives in the worktree-specific config, where `git config
    // --local` never looks — only the effective configuration sees it.
    git(base, 'config', '--file', join(store, 'config'), 'extensions.worktreeConfig', 'true');
    writeFileSync(join(store, 'config.worktree'), `[core]\n\tworktree = ${outside}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('the configured checkout'),
    });
    expect(existsSync(store)).toBe(true);
    expect(git(outside, 'status', '--porcelain')).toBe('');
  });

  it('removes a submodule store configured to an inside checkout through worktree config', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'worktree-config-clean');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    const store = join(clone, '.git', 'modules', 'lib');
    git(base, 'config', '--file', join(store, 'config'), 'extensions.worktreeConfig', 'true');
    writeFileSync(join(store, 'config.worktree'), `[core]\n\tworktree = ${join(clone, 'lib')}\n`);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('removes an old clone whose deinitialized submodule is configured to a checkout inside the folder', async () => {
    const library = join(base, 'library');
    mkdirSync(library);
    git(library, 'init', '-q', '-b', 'main');
    writeFileSync(join(library, 'lib.ts'), 'export {};\n');
    git(library, 'add', 'lib.ts');
    git(library, 'commit', '-q', '-m', 'library');
    const clone = join(scratch, 'internal-checkout-clean');
    git(base, 'clone', '-q', project, clone);
    git(clone, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'lib');
    git(clone, 'commit', '-q', '-m', 'add submodule');
    git(project, 'fetch', '-q', clone, 'main:with-submodule');
    git(project, 'fetch', '-q', library, 'main:library-main');
    git(clone, 'submodule', 'deinit', '-q', '-f', '--all');
    git(base, 'config', '--file', join(clone, '.git', 'modules', 'lib', 'config'), 'core.worktree', join(clone, 'lib'));
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone whose configured work tree lies outside the folder', async () => {
    const clone = join(scratch, 'external-worktree-gate');
    git(base, 'clone', '-q', project, clone);
    const outside = join(base, 'external-worktree');
    mkdirSync(outside);
    writeFileSync(join(outside, 'README.md'), 'hello\n');
    git(clone, 'config', 'core.worktree', outside);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('the configured checkout'),
    });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old store whose in-entry configured checkout holds work but has no .git pointer', async () => {
    const entry = join(scratch, 'checkout-work-gate');
    mkdirSync(entry);
    git(base, 'clone', '-q', '--separate-git-dir', join(entry, 'gitdir'), project, join(entry, 'tree'));
    // The checkout loses its `.git` pointer, so nothing inspects it as a
    // repository of its own; only the store knows it is the working tree.
    rmSync(join(entry, 'tree', '.git'));
    git(base, 'config', '--file', join(entry, 'gitdir', 'config'), 'core.worktree', join(entry, 'tree'));
    writeFileSync(join(entry, 'tree', 'README.md'), 'edited but never committed\n');
    writeFileSync(join(entry, 'tree', 'draft.ts'), 'export {};\n');
    ageTree(entry, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(existsSync(join(entry, 'tree', 'draft.ts'))).toBe(true);
    expect(existsSync(join(entry, 'gitdir'))).toBe(true);
  });

  it('keeps an old clone whose skip-worktree file hides uncommitted edits', async () => {
    const clone = join(scratch, 'skip-worktree-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'update-index', '--skip-worktree', 'README.md');
    writeFileSync(join(clone, 'README.md'), 'edited but hidden from status\n');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(decision).toMatchObject({ reason: expect.stringContaining('README.md') });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone whose assume-unchanged file hides uncommitted edits', async () => {
    const clone = join(scratch, 'assume-unchanged-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'update-index', '--assume-unchanged', 'README.md');
    writeFileSync(join(clone, 'README.md'), 'edited but hidden from status\n');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(decision).toMatchObject({ reason: expect.stringContaining('README.md') });
    expect(existsSync(clone)).toBe(true);
  });

  it('removes an old clone whose flagged files are unmodified', async () => {
    const clone = join(scratch, 'flagged-clean');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'update-index', '--skip-worktree', 'README.md');
    git(clone, 'update-index', '--assume-unchanged', 'README.md');
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'removed', path: clone });
    expect(existsSync(clone)).toBe(false);
  });

  it('keeps an old clone whose skip-worktree file hides an executable-bit change', async () => {
    const clone = join(scratch, 'skip-mode-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'update-index', '--skip-worktree', 'README.md');
    chmodSync(join(clone, 'README.md'), 0o755);
    ageTree(clone, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(decision).toMatchObject({ reason: expect.stringContaining('README.md') });
    expect(existsSync(clone)).toBe(true);
  });

  it('keeps an old clone whose assume-unchanged file hides a type change', async () => {
    const clone = join(scratch, 'assume-type-gate');
    git(base, 'clone', '-q', project, clone);
    git(clone, 'update-index', '--assume-unchanged', 'README.md');
    ageTree(clone, OLD);
    rmSync(join(clone, 'README.md'));
    symlinkSync(join(project, 'README.md'), join(clone, 'README.md'));
    // ageTree follows symlinks, so age the fresh link and its folder by hand.
    lutimesSync(join(clone, 'README.md'), OLD, OLD);
    utimesSync(clone, OLD, OLD);

    const [decision] = await sweep();

    expect(decision).toMatchObject({
      kind: 'kept-unsaved-work',
      reason: expect.stringContaining('uncommitted changes'),
    });
    expect(decision).toMatchObject({ reason: expect.stringContaining('README.md') });
    expect(existsSync(clone)).toBe(true);
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

  it('keeps an entry it cannot read instead of treating it as empty', async () => {
    const clone = join(scratch, 'locked-gate');
    git(base, 'clone', '-q', project, clone);
    mkdirSync(join(clone, 'src'));
    writeFileSync(join(clone, 'src', 'draft.ts'), 'export {};\n');
    ageTree(clone, OLD);
    chmodSync(join(clone, 'src'), 0o100);

    const [decision] = await sweep();

    expect(decision).toMatchObject({ kind: 'kept-unsaved-work', reason: expect.stringContaining('could not read') });
    expect(existsSync(clone)).toBe(true);
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

describe('scanActivitySince', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'scratch-activity-'));
  });

  afterEach(() => {
    if (existsSync(base)) {
      wipeTree(base);
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('notices recent changes inside dependency folders', async () => {
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(base, 'node_modules', 'pkg', 'index.js'), '');
    writeFileSync(join(base, 'report.json'), '{}');
    ageTree(join(base, 'report.json'), OLD);
    utimesSync(base, OLD, OLD);

    expect(await scanActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toEqual({ kind: 'recent' });
  });

  it('stays quiet when dependency folders are as old as the rest', async () => {
    mkdirSync(join(base, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(base, 'node_modules', 'pkg', 'index.js'), '');
    ageTree(base, OLD);

    expect(await scanActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toEqual({ kind: 'quiet' });
  });

  it('reports a folder it cannot read instead of treating it as empty', async () => {
    mkdirSync(join(base, 'locked'), { recursive: true });
    writeFileSync(join(base, 'locked', 'draft.md'), 'work in progress');
    ageTree(base, OLD);
    chmodSync(join(base, 'locked'), 0o100);

    expect(await scanActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toEqual({
      kind: 'blocked',
      reason: expect.stringContaining('could not read'),
    });
  });

  it('notices a recently changed file deep inside', async () => {
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    ageTree(base, OLD);
    writeFileSync(join(base, 'a', 'b', 'new.log'), 'x');
    utimesSync(join(base, 'a', 'b'), OLD, OLD);

    expect(await scanActivitySince(base, NOW - 14 * DAY_MS, byMtime)).toEqual({ kind: 'recent' });
  });

  it('counts a fresh copy that kept old modification times as recent', () => {
    expect(defaultActivityTimeMs({ mtimeMs: NOW - 400 * DAY_MS, ctimeMs: NOW - 1_000 })).toBe(NOW - 1_000);
    expect(defaultActivityTimeMs({ mtimeMs: NOW - 2_000, ctimeMs: NOW - 400 * DAY_MS })).toBe(NOW - 2_000);
  });

  it('treats a real copy made just now as recent by default', async () => {
    writeFileSync(join(base, 'copied.json'), '{}');
    utimesSync(join(base, 'copied.json'), OLD, OLD);
    utimesSync(base, OLD, OLD);

    expect(await scanActivitySince(base, NOW - 14 * DAY_MS)).toEqual({ kind: 'recent' });
  });
});
