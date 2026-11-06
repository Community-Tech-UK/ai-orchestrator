import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BOUNDARY_UNCERTAINTY_MS, diffTrees, snapshotWorkingTree } from './turn-snapshot-git';

const run = promisify(execFile);
async function setConfig(repo: string, key: string, value: string): Promise<void> {
  const fields = key.split('.');
  const section = fields.shift()!;
  const name = fields.pop()!;
  const subsection = fields.join('.');
  const header = subsection ? `${section} ${JSON.stringify(subsection)}` : section;
  await fs.appendFile(path.join(repo, '.git', 'config'), `\n[${header}]\n ${name} = ${JSON.stringify(value)}\n`);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-repo-')));
  await git(dir, 'init', '-q');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'bee\n');
  await fs.writeFile(path.join(dir, 'tracked.dat'), 'first\n');
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.log\n');
  await git(dir, 'add', '-A');
  await git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

async function looseObjectCount(repo: string): Promise<number> {
  const root = path.join(repo, '.git', 'objects');
  let count = 0;
  for (const entry of await fs.readdir(root)) {
    if (entry === 'info' || entry === 'pack') continue;
    count += (await fs.readdir(path.join(root, entry))).length;
  }
  return count;
}

/**
 * Fixture writes are settled before this boundary, including their recorded filesystem times
 * and the margin inside which a file time cannot be told apart from an edit made after it.
 */
async function fixtureSettlement(...files: string[]): Promise<number> {
  const stats = await Promise.all(files.map(file => fs.lstat(file)));
  return Math.max(performance.timeOrigin + performance.now(), ...stats.flatMap(stat => [stat.mtimeMs, stat.ctimeMs]))
    + BOUNDARY_UNCERTAINTY_MS;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

describe('snapshotWorkingTree and diffTrees', () => {
  let repo: string;
  let objects: string;

  beforeEach(async () => {
    repo = await makeRepo();
    objects = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-objects-'));
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(objects, { recursive: true, force: true });
  });

  it('reports modified, added and deleted files with exact line counts', async () => {
    const before = await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'c.txt'), 'new\nfile\n');
    await fs.rm(path.join(repo, 'b.txt'));
    const after = await snapshotWorkingTree(repo, objects);

    const { files, total } = await diffTrees(before, after);
    expect(total).toBe(3);
    expect(files.sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a.txt', status: 'modified', added: 2, deleted: 1 },
      { path: 'b.txt', status: 'deleted', added: 0, deleted: 1 },
      { path: 'c.txt', status: 'added', added: 2, deleted: 0 },
    ]);
  });

  it('says nothing changed when nothing did', async () => {
    const before = await snapshotWorkingTree(repo, objects);
    const after = await snapshotWorkingTree(repo, objects);
    expect(after.tree).toBe(before.tree);
    expect(await diffTrees(before, after)).toEqual({ files: [], total: 0 });
  });

  it('sees a change to a file that was already modified before the turn began', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo edited by hand\nthree\n');
    const before = await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo edited again\nthree\n');
    const after = await snapshotWorkingTree(repo, objects);
    expect((await diffTrees(before, after)).files.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('sees a change to an untracked file, and leaves out ignored files', async () => {
    await fs.writeFile(path.join(repo, 'scratch.txt'), 'draft\n');
    const before = await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'scratch.txt'), 'draft\nmore\n');
    await fs.writeFile(path.join(repo, 'ignored.log'), 'noise\n');
    const after = await snapshotWorkingTree(repo, objects);
    expect((await diffTrees(before, after)).files).toEqual([
      { path: 'scratch.txt', status: 'modified', added: 1, deleted: 0 },
    ]);
  });

  it('counts staged and unstaged changes alike', async () => {
    const before = await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'a.txt'), 'staged\n');
    await git(repo, 'add', 'a.txt');
    await fs.writeFile(path.join(repo, 'b.txt'), 'unstaged\n');
    const after = await snapshotWorkingTree(repo, objects);
    expect((await diffTrees(before, after)).files.map((file) => file.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('reports a binary file without invented line counts', async () => {
    const before = await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'image.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    const after = await snapshotWorkingTree(repo, objects);
    expect((await diffTrees(before, after)).files).toEqual([
      { path: 'image.bin', status: 'added', added: null, deleted: null },
    ]);
  });

  it('works from a subfolder of the repository and covers the whole repository', async () => {
    await fs.mkdir(path.join(repo, 'sub'));
    const before = await snapshotWorkingTree(path.join(repo, 'sub'), objects);
    await fs.writeFile(path.join(repo, 'a.txt'), 'changed outside the subfolder\n');
    const after = await snapshotWorkingTree(path.join(repo, 'sub'), objects);
    expect((await diffTrees(before, after)).files.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('diffs snapshots that keep their objects in separate folders', async () => {
    const otherObjects = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-objects-'));
    try {
      await fs.writeFile(path.join(repo, 'scratch.txt'), 'draft\n');
      const before = await snapshotWorkingTree(repo, objects);
      await fs.writeFile(path.join(repo, 'scratch.txt'), 'draft\nmore\n');
      const after = await snapshotWorkingTree(repo, otherObjects);
      expect((await diffTrees(before, after)).files).toEqual([
        { path: 'scratch.txt', status: 'modified', added: 1, deleted: 0 },
      ]);
    } finally {
      await fs.rm(otherObjects, { recursive: true, force: true });
    }
  });

  it('leaves its private scratch space empty when it is done', async () => {
    await snapshotWorkingTree(repo, objects);
    expect((await fs.readdir(objects)).filter((name) => name.startsWith('.scratch-'))).toEqual([]);
  });

  it.each([
    { ignored: false, settled: false }, { ignored: true, settled: false },
    { ignored: false, settled: true }, { ignored: true, settled: true },
  ])('never copies outside bytes through a linked ancestor ($ignored ignored, $settled settled)', async ({ ignored, settled }) => {
    const nested = path.join(repo, 'nested');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'note.txt'), 'inside\n');
    await git(repo, 'add', 'nested/note.txt');
    const outside = path.join(objects, 'outside');
    await fs.mkdir(outside);
    const body = Buffer.from('harmless outside fixture\n');
    await fs.writeFile(path.join(outside, 'note.txt'), body);
    if (ignored) await fs.appendFile(path.join(repo, '.gitignore'), 'nested\n');
    await fs.rm(nested, { recursive: true });
    await fs.symlink(outside, nested, 'dir');

    // Ignoring the replacement must not make its tracked descendants readable.
    const boundary = settled ? await fixtureSettlement(repo, nested, path.join(repo, '.gitignore')) : undefined;
    await snapshotWorkingTree(repo, objects, undefined, boundary);
    const hash = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest('hex');
    expect(await fs.stat(path.join(objects, hash.slice(0, 2), hash.slice(2))).then(() => true, () => false)).toBe(false);
  });

  it.each(['deleted', 'file', 'link'] as const)('reports a directory replaced by %s without following descendants', async (replacement) => {
    const nested = path.join(repo, 'nested');
    await fs.mkdir(path.join(nested, 'deep'), { recursive: true });
    await fs.writeFile(path.join(nested, 'deep', 'note.txt'), 'inside\n');
    await git(repo, 'add', 'nested/deep/note.txt');
    const before = await snapshotWorkingTree(repo, path.join(objects, 'before'));
    await fs.rm(nested, { recursive: true });
    if (replacement === 'file') await fs.writeFile(nested, 'replacement\n');
    if (replacement === 'link') await fs.symlink(objects, nested, 'dir');
    const boundary = await fixtureSettlement(repo, ...(replacement === 'deleted' ? [] : [nested]));
    const after = await snapshotWorkingTree(repo, path.join(objects, 'after'), undefined, boundary, before.paths);
    const { files } = await diffTrees(before, after);
    expect(files).toContainEqual({ path: 'nested/deep/note.txt', status: 'deleted', added: 0, deleted: 1 });
    expect(files).toHaveLength(replacement === 'deleted' ? 1 : 2);
    if (replacement !== 'deleted') expect(files).toContainEqual({ path: 'nested', status: 'added', added: 1, deleted: 0 });
    if (replacement === 'link') {
      const { stdout } = await run('git', ['ls-tree', after.tree, 'nested'], {
        cwd: repo, env: { ...process.env, GIT_DIR: path.join(after.objectDir, '.repo'), GIT_OBJECT_DIRECTORY: after.objectDir },
      });
      expect(stdout).toMatch(/^120000 blob /);
    }
  });

  // Linux stamps files from a coarse kernel clock that runs behind the JS clock (7 to 18 ms on the
  // WSL2 test machine, none on macOS), so an edit made just after the boundary can carry a time
  // before it. Such an edit cannot be told from the agent's last one, so nothing close to the
  // boundary is attributed to the agent.
  it('refuses to count a file stamped within the boundary margin as the agent\'s', async () => {
    await sleep(BOUNDARY_UNCERTAINTY_MS + 20);
    await fs.writeFile(path.join(repo, 'a.txt'), 'edited\n');
    const tooClose = Date.now() + 10;
    await expect(snapshotWorkingTree(repo, objects, undefined, tooClose)).rejects.toThrow('folder changed after settlement');
    const clear = Date.now() + BOUNDARY_UNCERTAINTY_MS + 10;
    await expect(snapshotWorkingTree(repo, objects, undefined, clear)).resolves.toMatchObject({ repoRoot: repo });
  });

  it('refuses to count a folder stamped within the boundary margin as unchanged', async () => {
    await sleep(BOUNDARY_UNCERTAINTY_MS + 20);
    await fs.rm(path.join(repo, 'b.txt'));
    const tooClose = Date.now() + 10;
    await expect(snapshotWorkingTree(repo, objects, undefined, tooClose)).rejects.toThrow('folder changed after settlement');
    const clear = Date.now() + BOUNDARY_UNCERTAINTY_MS + 10;
    await expect(snapshotWorkingTree(repo, objects, undefined, clear)).resolves.toMatchObject({ repoRoot: repo });
  });

  it('does not change the repository: no new objects, no index changes, no status changes', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'dirty\n');
    await fs.writeFile(path.join(repo, 'new.txt'), 'untracked\n');
    const objectsBefore = await looseObjectCount(repo);
    const statusBefore = await git(repo, 'status', '--porcelain=v1');
    const indexBefore = await fs.readFile(path.join(repo, '.git', 'index'));

    await snapshotWorkingTree(repo, objects);
    await fs.writeFile(path.join(repo, 'a.txt'), 'dirty again\n');
    await snapshotWorkingTree(repo, objects);

    expect(await looseObjectCount(repo)).toBe(objectsBefore);
    expect((await git(repo, 'status', '--porcelain=v1')).replace(/a\.txt/g, 'A')).toBe(statusBefore.replace(/a\.txt/g, 'A'));
    expect((await fs.readFile(path.join(repo, '.git', 'index'))).equals(indexBefore)).toBe(true);
  });

  it('rejects a folder that is not in a repository', async () => {
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-plain-'));
    try {
      await expect(snapshotWorkingTree(plain, objects)).rejects.toThrow(/not a git repository/);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});

/**
 * Every path under `root` with its size, modified time and content hash.
 * Shared-index modified times are included too: enumeration reads private copies.
 */
async function digestTree(root: string): Promise<string[]> {
  const lines: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      const relative = path.relative(root, full);
      if (entry.isDirectory()) {
        lines.push(`dir ${relative} ${stat.mtimeMs}`);
        await walk(full);
      } else {
        const content = entry.isFile() ? createHash('sha1').update(await fs.readFile(full)).digest('hex') : '-';
        const modified = stat.mtimeMs;
        lines.push(`file ${relative} ${stat.size} ${modified} ${content}`);
      }
    }
  };
  await walk(root);
  return lines;
}

/**
 * A repository set up the way a real developer's can be: a clean/smudge filter
 * for `*.dat`, a long-running filter for `*.big` (Git LFS style, armed only by
 * tests that want it), a file-system monitor, a text converter and an external
 * diff tool for `*.txt`, an index hook, and a split index. Every program writes
 * its name to one log, so a test can tell whether anything ran.
 */
async function makeHostileRepo(): Promise<{
  repo: string;
  /** A clean filter program, for tests that wire up further drivers. */
  cleanProgram: string;
  armLongRunningFilter: () => Promise<void>;
  ran: () => Promise<string[]>;
  cleanup: () => Promise<void>;
}> {
  const repo = await makeRepo();
  const marks = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-marks-'));
  const log = path.join(marks, 'ran.log');
  const program = async (name: string, body: string): Promise<string> => {
    const file = path.join(marks, `${name}.sh`);
    await fs.writeFile(file, `#!/bin/sh\necho ${name} >> '${log}'\n${body}\n`, { mode: 0o755 });
    return file;
  };

  await fs.writeFile(path.join(repo, '.gitattributes'), '*.dat filter=marker\n*.big filter=lfs\n*.txt diff=marker\n');
  await fs.writeFile(path.join(repo, 'tracked.big'), 'large\n');
  await git(repo, 'add', '.gitattributes', 'tracked.big');
  await git(repo, 'commit', '-q', '-m', 'attributes');

  const clean = await program('clean', 'cat');
  const smudge = await program('smudge', 'cat');
  const longRunning = await program('process', 'exit 1');
  // Answers the file-system monitor protocol with "a new token; anything may have changed".
  const fsmonitor = await program('fsmonitor', "printf 'token\\0/\\0'");
  const textconv = await program('textconv', 'cat "$1"');
  const externalDiff = await program('external-diff', 'exit 0');
  const hook = path.join(repo, '.git', 'hooks', 'post-index-change');
  await fs.mkdir(path.dirname(hook), { recursive: true });
  await fs.writeFile(hook, `#!/bin/sh\necho hook >> '${log}'\n`, { mode: 0o755 });

  await setConfig(repo, 'core.fsmonitor', fsmonitor);
  await setConfig(repo, 'diff.marker.textconv', textconv);
  await setConfig(repo, 'diff.external', externalDiff);
  await setConfig(repo, 'core.splitIndex', 'true');
  await git(repo, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'update-index', '--split-index');
  // A simple clean/smudge pair for *.dat. Required, so git fails loudly if it cannot run it.
  await setConfig(repo, 'filter.marker.clean', clean);
  await setConfig(repo, 'filter.marker.smudge', smudge);
  await setConfig(repo, 'filter.marker.required', 'true');
  // Setting the repository up must not count as the snapshot running anything.
  await fs.rm(log, { force: true });

  return {
    repo,
    cleanProgram: clean,
    /**
     * A long-running filter (the Git LFS shape) for *.big. This stand-in cannot
     * complete the handshake, so once armed any git command that reaches a *.big
     * file fails: it is armed only by tests that expect that file to be left alone.
     */
    armLongRunningFilter: async () => {
      await setConfig(repo, 'filter.lfs.process', longRunning);
      await setConfig(repo, 'filter.lfs.required', 'true');
    },
    ran: async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    cleanup: async () => {
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(marks, { recursive: true, force: true });
    },
  };
}

describe.skipIf(process.platform === 'win32')('a snapshot of a repository with programs wired into it', () => {
  let fixture: Awaited<ReturnType<typeof makeHostileRepo>>;
  let startObjects: string;
  let endObjects: string;

  beforeEach(async () => {
    fixture = await makeHostileRepo();
    startObjects = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-objects-'));
    endObjects = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-snapshot-objects-'));
  });

  afterEach(async () => {
    await fixture.cleanup();
    await fs.rm(startObjects, { recursive: true, force: true });
    await fs.rm(endObjects, { recursive: true, force: true });
  });

  async function snapshotAndCompareAround(edit: () => Promise<void>) {
    const start = await snapshotWorkingTree(fixture.repo, startObjects);
    await edit();
    const end = await snapshotWorkingTree(fixture.repo, endObjects);
    return diffTrees(start, end);
  }

  it('arms executable marker programs without invoking them during fixture setup', async () => {
    expect(await fs.readFile(path.join(fixture.repo, '.gitattributes'), 'utf8')).toContain('filter=marker');
    expect(await fs.readFile(path.join(fixture.repo, '.git', 'config'), 'utf8')).toContain('fsmonitor');
    expect((await fs.stat(fixture.cleanProgram)).mode & 0o111).not.toBe(0);
    expect(await fixture.ran()).toEqual([]);
  });

  it('runs no clean filter, file-system monitor, text converter or external diff', async () => {
    const result = await snapshotAndCompareAround(async () => {
      await fs.writeFile(path.join(fixture.repo, 'tracked.dat'), 'changed\n');
      await fs.writeFile(path.join(fixture.repo, 'new.dat'), 'untracked\n');
      await fs.writeFile(path.join(fixture.repo, 'a.txt'), 'one\nTWO\nthree\n');
    });

    expect(await fixture.ran()).toEqual([]);
    expect(result.files.map((file) => file.path).sort()).toEqual(['a.txt', 'new.dat', 'tracked.dat']);
  });

  it('also switches off a filter whose name contains dots', async () => {
    await fs.appendFile(path.join(fixture.repo, '.gitattributes'), '*.dotted filter=my.driver\n');
    await setConfig(fixture.repo, 'filter.my.driver.clean', fixture.cleanProgram);
    await setConfig(fixture.repo, 'filter.my.driver.required', 'true');
    const result = await snapshotAndCompareAround(async () => {
      await fs.writeFile(path.join(fixture.repo, 'file.dotted'), 'content\n');
    });
    expect(await fixture.ran()).toEqual([]);
    expect(result.files.map((file) => file.path)).toEqual(['file.dotted']);
  });

  it('does not need to enumerate or disable unusually named filter drivers', async () => {
    // `-c name=value` splits at the first "=", so a driver name holding one cannot be named safely.
    await setConfig(fixture.repo, 'filter.odd=name.clean', fixture.cleanProgram);
    await snapshotWorkingTree(fixture.repo, startObjects);
    expect(await fixture.ran()).toEqual([]);
  });

  it('runs no long-running filter either', async () => {
    await fixture.armLongRunningFilter();
    let failure: unknown;
    const result = await snapshotAndCompareAround(async () => {
      await fs.writeFile(path.join(fixture.repo, 'tracked.dat'), 'changed\n');
      await fs.writeFile(path.join(fixture.repo, 'tracked.big'), 'changed\n');
      await fs.writeFile(path.join(fixture.repo, 'new.dat'), 'untracked\n');
      await fs.writeFile(path.join(fixture.repo, 'new.big'), 'untracked\n');
      await fs.writeFile(path.join(fixture.repo, 'a.txt'), 'one\nTWO\nthree\n');
    }).catch((error: unknown) => { failure = error; return undefined; });

    // Checked first: when this fails, the list says which programs ran.
    expect(await fixture.ran()).toEqual([]);
    expect(failure).toBeUndefined();
    expect(result?.files.map((file) => file.path).sort()).toEqual(['a.txt', 'new.big', 'new.dat', 'tracked.big', 'tracked.dat']);
  });

  it('leaves everything under .git exactly as it was, split index included', async () => {
    const before = await digestTree(path.join(fixture.repo, '.git'));
    await snapshotAndCompareAround(async () => {
      await fs.writeFile(path.join(fixture.repo, 'tracked.dat'), 'changed\n');
      await fs.writeFile(path.join(fixture.repo, 'brand-new.txt'), 'untracked\n');
    });
    expect(await digestTree(path.join(fixture.repo, '.git'))).toEqual(before);
  });

  it('still honours .gitignore, and still sees tracked and untracked files', async () => {
    await fs.writeFile(path.join(fixture.repo, 'scratch.txt'), 'draft\n');
    const result = await snapshotAndCompareAround(async () => {
      await fs.writeFile(path.join(fixture.repo, 'scratch.txt'), 'draft\nmore\n');
      await fs.writeFile(path.join(fixture.repo, 'ignored.log'), 'noise\n');
      await fs.writeFile(path.join(fixture.repo, 'tracked.dat'), 'changed\nagain\n');
    });
    expect(result.files).toEqual([
      { path: 'scratch.txt', status: 'modified', added: 1, deleted: 0 },
      { path: 'tracked.dat', status: 'modified', added: 2, deleted: 1 },
    ]);
  });
});
