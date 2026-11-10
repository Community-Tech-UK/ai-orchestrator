/**
 * ignored-file-guard against a real temp repo: which files Git ignores would a
 * move from HEAD to another tree replace, and what does the reason say.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ignoredFilesBlockReason, ignoredFilesInTheWay, mergeResultTree } from './ignored-file-guard';
import { IGNORED_FILES_UNCHECKED_REASON, ignoredFilesReason } from '../../../shared/copy/ignored-files-copy';
import { hermeticGitEnv } from './git-env';
import { MAX_LOG_ARRAY_ITEMS } from '../../logging/logger';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../logging/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logging/logger')>()),
  getLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: hermeticGitEnv(), encoding: 'utf-8' }).trim();
}

const caseInsensitiveDisk = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'ignored-guard-case-'));
  try {
    writeFileSync(join(probe, 'probe'), '');
    return existsSync(join(probe, 'PROBE'));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let repo: string;

function write(file: string, content: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), content);
}

/** Commit `files` on a new branch off main, return to main, and give the branch tip. */
function branchAdding(name: string, files: Record<string, string>): string {
  git(repo, 'switch', '-q', '-c', name);
  for (const [file, content] of Object.entries(files)) write(file, content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', name);
  const tip = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'switch', '-q', 'main');
  return tip;
}

function ignoreInRoot(...patterns: string[]): void {
  writeFileSync(join(repo, '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ignored-guard-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write('base.txt', 'base\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('ignoredFilesInTheWay', () => {
  it('names an ignored file at an added path, one where a folder goes, and a folder of them where a file goes', async () => {
    const tip = branchAdding('adds', { 'promoted.txt': 'p\n', 'out/report.txt': 'r\n', cache: 'c\n' });
    ignoreInRoot('promoted.txt', 'out', 'cache/');
    write('promoted.txt', 'mine\n');
    write('out', 'mine\n');
    write('cache/local.bin', 'mine\n');

    await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual(['cache/', 'out', 'promoted.txt']);
  });

  it('leaves out untracked files Git does not ignore, ignored files beside added ones, and tracked files', async () => {
    const tip = branchAdding('adds', { 'notes.txt': 'n\n', 'logs/new.txt': 'l\n', 'base.txt': 'changed\n' });
    ignoreInRoot('*.log');
    write('notes.txt', 'untracked, not ignored\n');
    write('logs/old.log', 'ignored beside an added file\n');

    await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual([]);
  });

  it('reads nothing from disk beyond what the target adds', async () => {
    const tip = branchAdding('adds', { 'fresh/file.txt': 'f\n' });
    ignoreInRoot('*');
    write('elsewhere.txt', 'ignored, untouched by the move\n');

    await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual([]);
  });

  it.runIf(caseInsensitiveDisk)('matches an ignored file whose name differs only in case', async () => {
    const tip = branchAdding('adds', { 'Notes.md': 'n\n' });
    ignoreInRoot('notes.md');
    write('notes.md', 'mine\n');

    await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual(['Notes.md']);
  });

  it('names a place inside an ignored nested repository', async () => {
    const tip = branchAdding('adds', { 'vendor/lib/x.c': 'x\n' });
    ignoreInRoot('vendor/');
    git(repo, 'init', '-q', join(repo, 'vendor', 'lib'));
    write('vendor/lib/x.c', 'mine\n');

    await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual(['vendor/lib/x.c']);
  });

  it('still finds them when the environment tells Git to read pathspecs literally', async () => {
    const tip = branchAdding('adds', { 'p.txt': 'p\n' });
    ignoreInRoot('p.txt');
    write('p.txt', 'mine\n');
    vi.stubEnv('GIT_LITERAL_PATHSPECS', '1');
    try {
      await expect(ignoredFilesInTheWay(repo, tip)).resolves.toEqual(['p.txt']);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails rather than answering for a target that does not exist', async () => {
    await expect(ignoredFilesInTheWay(repo, 'no-such-branch')).rejects.toThrow();
  });
});

describe('ignoredFilesBlockReason', () => {
  it('gives no reason when nothing Git ignores is in the way', async () => {
    const tip = branchAdding('adds', { 'fresh.txt': 'f\n' });

    await expect(ignoredFilesBlockReason(repo, tip)).resolves.toBeNull();
  });

  it('names what is in the way, and logs every place', async () => {
    const tip = branchAdding('adds', { 'notes.md': 'n\n' });
    ignoreInRoot('notes.md');
    write('notes.md', 'mine\n');
    warn.mockClear();

    await expect(ignoredFilesBlockReason(repo, tip)).resolves.toBe(ignoredFilesReason(['notes.md']));
    expect(warn).toHaveBeenCalledWith('Files Git ignores are in the way', {
      checkout: repo, target: tip, total: 1, places: ['notes.md'],
    });
  });

  it('logs every place of a long list, in parts the logger keeps whole', async () => {
    const names = Array.from({ length: 30 }, (_, index) => `p${String(index).padStart(2, '0')}.txt`);
    const tip = branchAdding('adds', Object.fromEntries(names.map((name) => [name, 'p\n'])));
    ignoreInRoot('p*.txt');
    for (const name of names) write(name, 'mine\n');
    warn.mockClear();

    await expect(ignoredFilesBlockReason(repo, tip)).resolves.toBe(ignoredFilesReason(names));
    const logged = warn.mock.calls.filter(([message]) => message === 'Files Git ignores are in the way')
      .map(([, data]) => data as { total: number; places: string[] });
    expect(logged.every(({ total, places }) => total === 30 && places.length <= MAX_LOG_ARRAY_ITEMS)).toBe(true);
    expect(logged.flatMap(({ places }) => places)).toEqual(names);
  });

  it('blocks, and logs why, when Git cannot answer', async () => {
    warn.mockClear();

    await expect(ignoredFilesBlockReason(repo, 'no-such-branch')).resolves.toBe(IGNORED_FILES_UNCHECKED_REASON);
    expect(warn).toHaveBeenCalledWith('Could not check for files Git ignores', expect.objectContaining({
      checkout: repo,
      target: 'no-such-branch',
      message: expect.stringContaining('no-such-branch'),
    }));
  });
});

describe('mergeResultTree', () => {
  it('gives the merged tree of a clean merge', async () => {
    const tip = branchAdding('side', { 'side.txt': 's\n' });
    write('main.txt', 'm\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'main work');

    const tree = await mergeResultTree(repo, tip);

    expect(git(repo, 'ls-tree', '--name-only', tree).split('\n')).toEqual(['base.txt', 'main.txt', 'side.txt']);
  });

  it('gives the tree of a conflicting merge instead of failing', async () => {
    const tip = branchAdding('side', { 'base.txt': 'side\n', 'side.txt': 's\n' });
    write('base.txt', 'main\n');
    git(repo, 'commit', '-q', '-am', 'main edit');

    const tree = await mergeResultTree(repo, tip);

    expect(git(repo, 'ls-tree', '--name-only', tree).split('\n')).toEqual(['base.txt', 'side.txt']);
    expect(git(repo, 'show', `${tree}:base.txt`)).toContain('<<<<<<<');
  });

  it('fails for a branch that does not exist', async () => {
    await expect(mergeResultTree(repo, 'no-such-branch')).rejects.toThrow();
  });
});
