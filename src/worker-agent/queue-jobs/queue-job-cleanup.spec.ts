import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BRANCH, JOB, PROJECT, makeFixture, runGit, sendAndPrepare, writeFile, type Fixture,
} from './queue-job-fixture.test-helpers';

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());
const bare = (): string => join(fx.root, 'queue-repos', `${PROJECT}.git`);

describe('queue.readReport', () => {
  it('returns this turn\'s file only and deletes every other entry in the report folder', async () => {
    const { prepared } = await sendAndPrepare(fx, { turnId: 'turn-2' });
    writeFile(prepared.reportFolder, 'turn-1.json', '{"old":true}');
    writeFile(prepared.reportFolder, 'turn-2.json', '{"summary":"current"}');
    writeFile(prepared.reportFolder, 'notes/turn-2.json', 'nested');
    writeFile(prepared.reportFolder, 'turn-3.json', '{"future":true}');
    expect(await fx.host.readReport({ jobId: JOB, turnId: 'turn-2' })).toEqual({ text: '{"summary":"current"}' });
    expect(readdirSync(prepared.reportFolder)).toEqual(['turn-2.json']);
  });

  it('answers null for a missing file or folder, still deleting the other turns\' files', async () => {
    expect(await fx.host.readReport({ jobId: 'never-seen', turnId: 't1' })).toEqual({ text: null });
    const { prepared } = await sendAndPrepare(fx);
    writeFile(prepared.reportFolder, 'turn-0.json', 'older');
    expect(await fx.host.readReport({ jobId: JOB, turnId: 'turn-1' })).toEqual({ text: null });
    expect(readdirSync(prepared.reportFolder)).toEqual([]);
  });

  it('never follows a link, and ignores an oversized file', async () => {
    const { prepared } = await sendAndPrepare(fx);
    const secret = join(fx.dir, 'secret.txt');
    writeFileSync(secret, 'do not read');
    symlinkSync(secret, join(prepared.reportFolder, 'turn-1.json'));
    expect(await fx.host.readReport({ jobId: JOB, turnId: 'turn-1' })).toEqual({ text: null });
    expect(readFileSync(secret, 'utf8')).toBe('do not read');
    writeFile(prepared.reportFolder, 'turn-2.json', Buffer.alloc(1024 * 1024 + 1, 97));
    expect(await fx.host.readReport({ jobId: JOB, turnId: 'turn-2' })).toEqual({ text: null });
  });
});

describe('queue.deleteLeftOut', () => {
  const call = (files: string[]) => fx.host.deleteLeftOut({ project: PROJECT, jobId: JOB, branch: BRANCH, files });

  it('deletes exactly the named untracked files', async () => {
    const { prepared } = await sendAndPrepare(fx);
    writeFile(prepared.jobFolder, 'docs/plans/moved.md', 'x');
    writeFile(prepared.jobFolder, 'keep.txt', 'agent file the save kept');
    expect(await call(['docs/plans/moved.md', 'already/gone.md'])).toEqual({ deleted: ['docs/plans/moved.md', 'already/gone.md'], skipped: [] });
    expect(existsSync(join(prepared.jobFolder, 'docs', 'plans', 'moved.md'))).toBe(false);
    expect(existsSync(join(prepared.jobFolder, 'keep.txt'))).toBe(true);
  });

  it('skips and lists a tracked file, a directory, a provisioned path, a path in .git, and a path behind a link', async () => {
    const { prepared } = await sendAndPrepare(fx);
    const outside = join(fx.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'victim.txt'), 'victim');
    symlinkSync(outside, join(prepared.jobFolder, 'linked'), 'junction');
    writeFile(prepared.jobFolder, 'untracked/file.md', 'x');
    const provisioned = prepared.provisioned[0];
    expect(provisioned).toBeTruthy();
    const files = ['src/a.txt', 'SRC/A.TXT', 'untracked', provisioned!, '.git', '.git/HEAD', 'linked/victim.txt'];
    const result = await call(files);
    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual(files);
    expect(readFileSync(join(prepared.jobFolder, 'src', 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(outside, 'victim.txt'), 'utf8')).toBe('victim');
    expect(existsSync(join(prepared.jobFolder, 'untracked', 'file.md'))).toBe(true);
    expect(existsSync(join(prepared.jobFolder, '.git'))).toBe(true);
  });

  it('skips everything for a job with no folder here', async () => {
    expect(await call(['a.md'])).toEqual({ deleted: [], skipped: ['a.md'] });
  });
});

describe('queue.remove', () => {
  it('removes the job\'s folders, references and packs, keeping the repository, the installed checkout and the branch', async () => {
    const { commit, prepared } = await sendAndPrepare(fx);
    writeFile(prepared.jobFolder, 'src/a.txt', 'work\n');
    const collected = await fx.host.collect({ project: PROJECT, jobId: JOB, branch: BRANCH, expectedParent: commit });
    expect('refused' in collected).toBe(false);
    expect(existsSync(join(fx.root, 'queue-packs'))).toBe(true);

    expect(await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: true });
    for (const gone of [prepared.jobFolder, prepared.planningFolder, prepared.reportFolder, join(fx.root, 'queue-state', JOB)]) expect(existsSync(gone)).toBe(false);
    expect(readdirSync(join(fx.root, 'queue-packs'))).toEqual([]);
    expect(runGit(['for-each-ref', 'refs/queue'], bare())).toBe('');
    expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], bare())).toBe(commit);
    expect(existsSync(join(fx.root, 'queue-repos', `${PROJECT}-installed`, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(runGit(['worktree', 'list'], bare())).not.toContain(prepared.jobFolder);
    expect(fx.folders.registered.size).toBe(0); // the allowed folders went with it
  });

  it('can be called twice, and for a job this computer never saw, even with no repository at all', async () => {
    await sendAndPrepare(fx);
    expect(await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: true });
    expect(await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: true });
    expect(await fx.host.remove({ project: PROJECT, jobId: 'never-seen', branch: 'queue/never-seen-000000' })).toEqual({ removed: true });
    const empty = makeFixture();
    try {
      expect(await empty.host.remove({ project: 'other-project', jobId: 'x1', branch: 'queue/x1-aaaaaa' })).toEqual({ removed: true });
    } finally { empty.dispose(); }
  });

  it('removes a folder with dependency links without touching the installed checkout\'s dependencies', async () => {
    const { prepared } = await sendAndPrepare(fx);
    const installedFile = join(fx.root, 'queue-repos', `${PROJECT}-installed`, 'node_modules', 'dep', 'index.js');
    expect(existsSync(join(prepared.jobFolder, 'node_modules', 'dep', 'index.js'))).toBe(true);
    await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH });
    expect(existsSync(installedFile)).toBe(true);
  });

  it('refuses to remove a job while a session is in its folder, leaving everything in place', async () => {
    const { prepared } = await sendAndPrepare(fx);
    fx.folders.busy = true;
    expect(await fx.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: false });
    expect(existsSync(prepared.jobFolder)).toBe(true);
    expect(fx.folders.registered.size).toBe(1);
  });
});
