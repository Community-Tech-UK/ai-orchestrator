import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TurnFileBaselineService,
  diffTrees,
  snapshotWorkingTree,
  type TurnBaselineResult,
} from './turn-file-baseline';

import * as snapshotGit from './turn-snapshot-git';

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd });
  return stdout;
}

async function makeRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'turn-baseline-repo-')));
  await git(dir, 'init', '-q');
  await fs.writeFile(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await fs.writeFile(path.join(dir, 'b.txt'), 'bee\n');
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

describe('snapshotWorkingTree and diffTrees', () => {
  let repo: string;
  let objects: string;

  beforeEach(async () => {
    repo = await makeRepo();
    objects = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-baseline-objects-'));
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
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-baseline-plain-'));
    try {
      await expect(snapshotWorkingTree(plain, objects)).rejects.toThrow(/not a git repository/);
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
  });
});

describe('TurnFileBaselineService', () => {
  let repo: string;
  let events: EventEmitter;
  let service: TurnFileBaselineService;
  let location: { type: string } | undefined;
  let workingDirectory: string;

  const userInput = (id: string, messageType = 'user', metadata?: Record<string, unknown>) =>
    events.emit('provider:normalized-event', {
      instanceId: 'inst-1',
      eventId: `ev-${id}`,
      timestamp: Date.now(),
      event: { kind: 'output', content: 'do the thing', messageType, messageId: id, timestamp: Date.now(), metadata },
    });
  const complete = () =>
    events.emit('provider:normalized-event', { instanceId: 'inst-1', timestamp: Date.now(), event: { kind: 'complete' } });
  const status = (value: string) =>
    events.emit('instance:batch-update', { updates: [{ instanceId: 'inst-1', status: value }] });
  const ready = (result: TurnBaselineResult) => {
    if (result.state !== 'ready') throw new Error(`expected a ready result, got ${JSON.stringify(result)}`);
    return result;
  };

  beforeEach(async () => {
    TurnFileBaselineService._resetForTesting();
    repo = await makeRepo();
    workingDirectory = repo;
    location = { type: 'local' };
    events = new EventEmitter();
    service = TurnFileBaselineService.getInstance();
    service.attach(events, () => ({ workingDirectory, executionLocation: location }));
  });

  afterEach(async () => {
    TurnFileBaselineService._resetForTesting();
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('compares the folder at the start of a turn with the folder when it finished', async () => {
    userInput('u1');
    await service.beforeDispatch('inst-1', { workingDirectory: repo, outputBuffer: [{ id: 'u1', type: 'user', content: 'go', timestamp: Date.now() }] });
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'generated.txt'), 'made by a shell command\n');
    await service.getResult('inst-1', 'u1');
    complete();

    const result = ready(await service.getResult('inst-1', 'u1'));
    expect(result.files.map(file => file.path).sort()).toEqual(['a.txt', 'generated.txt']);
    expect(result.total).toBe(result.files.length);
    expect(result.truncated).toBe(false);
    expect(result.baselineCompletedAt).toBeLessThanOrEqual(result.endedAt);
  });

  it('records only what changed after the baseline was taken', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\nfour\n');
    await fs.writeFile(path.join(repo, 'generated.txt'), 'made by a shell command\n');
    complete();

    const result = ready(await service.getResult('inst-1', 'u1'));
    expect(result.files.map((file) => file.path).sort()).toEqual(['a.txt', 'generated.txt']);
    expect(result.files.find((file) => file.path === 'a.txt')).toMatchObject({ status: 'modified', added: 1, deleted: 0 });
  });

  it('gives a zero count, not a guess, when the turn changed nothing', async () => {
    userInput('u1');
    complete();
    expect(ready(await service.getResult('inst-1', 'u1'))).toMatchObject({ total: 0, files: [] });
  });

  it('also settles on the status change from busy to idle', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    status('busy');
    await fs.writeFile(path.join(repo, 'b.txt'), 'bee changed\n');
    status('idle');
    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['b.txt']);
  });

  it('answers running while the turn has not ended', async () => {
    userInput('u1');
    expect(await service.getResult('inst-1', 'u1')).toEqual({ state: 'running' });
  });

  it('keeps the first end snapshot when the same turn settles a second time', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'first\n');
    complete();
    const first = ready(await service.getResult('inst-1', 'u1'));
    expect(first.files.map((file) => file.path)).toEqual(['a.txt']);

    await fs.writeFile(path.join(repo, 'b.txt'), 'second\n');
    complete();
    const second = ready(await service.getResult('inst-1', 'u1'));
    expect(second).toEqual(first);
  });

  it('ends a running turn at the moment a new input arrives, and starts the next one there', async () => {
    userInput('u1');
    status('busy');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'before the steer\n');
    userInput('steer');
    await service.getResult('inst-1', 'steer');
    await fs.writeFile(path.join(repo, 'b.txt'), 'after the steer\n');
    complete();

    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['a.txt']);
    expect(ready(await service.getResult('inst-1', 'steer')).files.map((file) => file.path)).toEqual(['b.txt']);
  });

  it('knows when an interrupted turn ended, so edits made by hand afterwards are not counted in it', async () => {
    userInput('u1');
    status('busy');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'edited by the agent\n');
    status('interrupting');
    status('idle');
    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['a.txt']);

    await fs.writeFile(path.join(repo, 'b.txt'), 'edited by hand after the interrupt\n');
    userInput('u2');
    await service.getResult('inst-1', 'u2');
    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('knows when a turn that crashed ended', async () => {
    userInput('u1');
    status('busy');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'edited before the crash\n');
    status('error');
    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['a.txt']);
  });

  it('gives no count for a turn it never saw end, rather than counting whatever happened before the next input', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'edited during the turn\n');
    await fs.writeFile(path.join(repo, 'b.txt'), 'edited by hand much later\n');
    // The session was idle when the next input arrived and no finish was seen for the first turn.
    userInput('u2');
    await service.getResult('inst-1', 'u2');
    expect(await service.getResult('inst-1', 'u1')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
  });

  it('keeps separate turns separate, and does not count edits made between them', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'turn one\n');
    complete();
    await service.getResult('inst-1', 'u1');

    await fs.writeFile(path.join(repo, 'b.txt'), 'edited by hand between turns\n');
    userInput('u2');
    await service.getResult('inst-1', 'u2');
    await fs.writeFile(path.join(repo, 'c.txt'), 'turn two\n');
    complete();

    expect(ready(await service.getResult('inst-1', 'u1')).files.map((file) => file.path)).toEqual(['a.txt']);
    expect(ready(await service.getResult('inst-1', 'u2')).files.map((file) => file.path)).toEqual(['c.txt']);
  });

  it('opens a turn for input Harness wrote itself, and ignores ordinary output', async () => {
    userInput('sys1', 'system', { internalInput: { actor: 'harness', source: 'async-work-continuation' } });
    userInput('chatter', 'assistant');
    expect((await service.getResult('inst-1', 'sys1')).state).toBe('running');
    expect(await service.getResult('inst-1', 'chatter')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
  });

  it('says why a count is not available', async () => {
    location = { type: 'remote' };
    userInput('remote-turn');
    complete();
    expect(await service.getResult('inst-1', 'remote-turn')).toEqual({ state: 'unavailable', reason: 'remote' });

    location = { type: 'local' };
    const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'turn-baseline-plain-'));
    workingDirectory = plain;
    try {
      userInput('plain-turn');
      complete();
      expect(await service.getResult('inst-1', 'plain-turn')).toEqual({ state: 'unavailable', reason: 'not-git' });
    } finally {
      await fs.rm(plain, { recursive: true, force: true });
    }
    expect(await service.getResult('inst-1', 'never-seen')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
    expect(await service.getResult('nobody', 'u1')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
  });

  it('returns at most 200 files but reports the real total', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await Promise.all(Array.from({ length: 205 }, (_, index) => fs.writeFile(path.join(repo, `gen-${index}.txt`), `${index}\n`)));
    complete();

    const result = ready(await service.getResult('inst-1', 'u1'));
    expect(result.total).toBe(205);
    expect(result.files).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('removes only its known private snapshot folder when the instance goes away', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    const state = (service as unknown as { instances: Map<string, { objectDirs: Set<string> }> }).instances.get('inst-1')!;
    const folders = [...state.objectDirs];
    expect(folders).toHaveLength(1);
    expect((await fs.stat(folders[0])).isDirectory()).toBe(true);
    await service.forget('inst-1');
    await expect(fs.stat(folders[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await service.getResult('inst-1', 'u1')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
  });

  it('never includes an immediate post-settlement manual edit, even before comparison finishes', async () => {
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    await fs.writeFile(path.join(repo, 'a.txt'), 'agent change\n');
    complete();
    await fs.writeFile(path.join(repo, 'manual.txt'), 'manual change after completion\n');
    complete();
    const result = await service.getResult('inst-1', 'u1');
    if (result.state === 'ready') expect(result.files.map(file => file.path)).toEqual(['a.txt']);
    else expect(result).toEqual({ state: 'unavailable', reason: 'git-error' });
  });

  it('reclaims snapshot disk after every settled turn and keeps only bounded results', async () => {
    for (let i = 0; i < 35; i++) {
      userInput(`u${i}`);
      await service.getResult('inst-1', `u${i}`);
      complete();
      await service.getResult('inst-1', `u${i}`);
    }
    const state = (service as unknown as { instances: Map<string, { objectDirs: Set<string>; segments: unknown[] }> }).instances.get('inst-1')!;
    expect(state.objectDirs.size).toBe(0);
    expect(state.segments.length).toBe(32);
    expect(await service.getResult('inst-1', 'u0')).toEqual({ state: 'unavailable', reason: 'no-baseline' });
  }, 30_000);

  it('never scavenges another live or unknown temp folder, even when it is old', async () => {
    const unknown = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-turn-objects-'));
    try {
      const marker = path.join(unknown, 'owned-by-another-session');
      await fs.writeFile(marker, 'live');
      await fs.utimes(unknown, new Date(0), new Date(0));
      service.attach(new EventEmitter(), () => ({ workingDirectory: repo }));
      userInput('u1');
      await service.getResult('inst-1', 'u1');
      await service.forget('inst-1');
      expect(await fs.readFile(marker, 'utf8')).toBe('live');
    } finally { await fs.rm(unknown, { recursive: true, force: true }); }
  });

  it('bounds a stalled baseline before provider dispatch and records unavailable', async () => {
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const mock = vi.spyOn(snapshotGit, 'snapshotWorkingTree').mockImplementation(async (_cwd, _dir, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      throw new Error('unreachable');
    });
    try {
      userInput('stalled');
      const dispatch = service.beforeDispatch('inst-1', { workingDirectory: repo,
        outputBuffer: [{ id: 'stalled', type: 'user', content: 'go', timestamp: Date.now() }] });
      await started;
      const at = Date.now();
      await dispatch;
      expect(Date.now() - at).toBeLessThan(4_000);
      expect(await service.getResult('inst-1', 'stalled')).toEqual({ state: 'unavailable', reason: 'git-error' });
    } finally { mock.mockRestore(); }
  });

  it('does not reuse a deferred baseline when admission never published its input', async () => {
    const reservation = await service.beforeDispatch('inst-1', { workingDirectory: repo, outputBuffer: [] }, true);
    await reservation!.release();
    await fs.writeFile(path.join(repo, 'a.txt'), 'manual edit before admitted turn\n');
    userInput('next');
    await service.getResult('inst-1', 'next');
    complete();
    expect(ready(await service.getResult('inst-1', 'next')).total).toBe(0);
  });

  it('rejects an immediate post-settlement deletion as uncertain instead of counting it', async () => {
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'manual draft\n');
    userInput('u1');
    await service.getResult('inst-1', 'u1');
    complete();
    await fs.rm(path.join(repo, 'untracked.txt'));
    const result = await service.getResult('inst-1', 'u1');
    if (result.state === 'ready') expect(result.total).toBe(0);
    else expect(result).toEqual({ state: 'unavailable', reason: 'git-error' });
  });

  it('survives garbage on the event channel', () => {
    expect(() => {
      events.emit('provider:normalized-event', undefined);
      events.emit('provider:normalized-event', { instanceId: 7 });
      events.emit('provider:normalized-event', { instanceId: 'inst-1', event: { kind: 'output' } });
      events.emit('instance:batch-update', undefined);
      events.emit('instance:batch-update', { updates: [null, { status: 'idle' }] });
      events.emit('instance:state-update', 'nope');
    }).not.toThrow();
  });
});
