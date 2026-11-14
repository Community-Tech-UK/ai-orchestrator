import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueJobRefusal } from './queue-job-errors';
import { createQueueWorktree } from './queue-worktree-route';
import {
  BRANCH, JOB, PROJECT, commitAll, documents, makeFixture, runGit, sendAndPrepare, sendCommit, writeFile, type Fixture,
} from './queue-job-fixture.test-helpers';

let fx: Fixture;
beforeEach(() => { fx = makeFixture(); });
afterEach(() => fx.dispose());

const bare = (): string => join(fx.root, 'queue-repos', `${PROJECT}.git`);
const provisionedRecord = (folder: string): string[] =>
  JSON.parse(readFileSync(join(runGit(['rev-parse', '--absolute-git-dir'], folder), 'plan-queue-provisioned'), 'utf8')) as string[];

describe('queue.prepare', () => {
  it('makes the job folder at the commit on the job\'s branch through the Mac\'s createWorktree route, and the other folders', async () => {
    const { commit, prepared } = await sendAndPrepare(fx, { docs: { 'docs/plans/p_plan.md': '# plan\n', 'docs/specs/p_spec.md': 'spec\n' } });
    expect(prepared.jobFolder).toBe(join(fx.root, 'queue-worktrees', 'queue', 'job-one-abc123'));
    expect(runGit(['rev-parse', 'HEAD'], prepared.jobFolder)).toBe(commit);
    expect(runGit(['symbolic-ref', '--short', 'HEAD'], prepared.jobFolder)).toBe(BRANCH);
    expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], bare())).toBe(commit);
    expect(readFileSync(join(prepared.jobFolder, 'src', 'a.txt'), 'utf8')).toBe('one\n');
    // Dependencies are linked from the installed checkout (.worktreeinclude), entry by entry.
    const dep = join(prepared.jobFolder, 'node_modules', 'dep');
    expect(lstatSync(dep).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dep)).toContain('-installed');
    expect(readFileSync(join(dep, 'index.js'), 'utf8')).toContain('module.exports');
    // No local settings files: none is ever sent, and none is created.
    expect(existsSync(join(prepared.jobFolder, '.env.local'))).toBe(false);

    expect(readFileSync(join(prepared.planningFolder, 'docs', 'plans', 'p_plan.md'), 'utf8')).toBe('# plan\n');
    expect(readFileSync(join(prepared.planningFolder, 'docs', 'specs', 'p_spec.md'), 'utf8')).toBe('spec\n');
    expect(prepared.planningFolder).toBe(join(fx.root, 'queue-docs', JOB));
    const manifest = JSON.parse(readFileSync(join(fx.root, 'queue-state', JOB, 'planning-manifest.json'), 'utf8')) as { files: [string, string][] };
    expect(Object.fromEntries(manifest.files)['docs/plans/p_plan.md']).toBe(createHash('sha256').update('# plan\n').digest('hex'));

    expect(prepared.reportFolder).toBe(join(fx.root, 'queue-reports', JOB));
    expect(prepared.reportFile).toBe(join(prepared.reportFolder, 'turn-1.json'));
    expect(existsSync(prepared.reportFolder)).toBe(true);
    expect(prepared.installed).toBe(true);
    expect(fx.folders.registered.get(prepared.jobFolder)).toEqual({
      jobFolder: prepared.jobFolder, planningFolder: prepared.planningFolder, reportFolder: prepared.reportFolder,
    });
    expect(prepared.provisioned).toEqual(provisionedRecord(prepared.jobFolder));
  });

  it('records what setup left untracked, as the Mac does, so collect can leave it out', async () => {
    const { prepared } = await sendAndPrepare(fx);
    const status = runGit(['status', '--porcelain', '--untracked-files=all'], prepared.jobFolder).split('\n').filter(Boolean).map(line => line.slice(3));
    for (const entry of status) expect(prepared.provisioned.some(p => entry === p || entry.startsWith(`${p}/`))).toBe(true);
  });

  it('refuses when this computer does not hold the commit it is asked to prepare', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    await expect(fx.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit, documents: [], turnId: 't1' }))
      .rejects.toBeInstanceOf(QueueJobRefusal);
    await sendCommit(fx, { commit });
    writeFile(fx.mac, 'src/a.txt', 'newer\n');
    const newer = commitAll(fx.mac, 'newer');
    await expect(fx.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit: newer, documents: [], turnId: 't1' }))
      .rejects.toThrow(/does not hold that version/);
    expect(existsSync(join(fx.root, 'queue-worktrees'))).toBe(false);
  });

  it('refuses a planning document whose path leaves the planning folder, and a folder already at the job\'s place', async () => {
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    await sendCommit(fx, { commit });
    await expect(fx.host.prepare({
      project: PROJECT, jobId: JOB, branch: BRANCH, commit, turnId: 't1',
      documents: [{ path: '../escape.md', contentBase64: 'eA==' }],
    })).rejects.toThrow(/outside/);
    expect(existsSync(join(fx.root, 'queue-docs', 'escape.md'))).toBe(false);

    const other = makeFixture();
    try {
      const sent = runGit(['rev-parse', 'HEAD'], other.mac);
      await sendCommit(other, { commit: sent });
      mkdirSync(join(other.root, 'queue-worktrees', 'queue', 'job-one-abc123'), { recursive: true });
      writeFileSync(join(other.root, 'queue-worktrees', 'queue', 'job-one-abc123', 'mine.txt'), 'keep');
      await expect(other.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit: sent, documents: [], turnId: 't1' }))
        .rejects.toThrow(/left alone/);
      expect(readFileSync(join(other.root, 'queue-worktrees', 'queue', 'job-one-abc123', 'mine.txt'), 'utf8')).toBe('keep');
    } finally { other.dispose(); }
  });

  it('clears the planning folder and rewrites it on the next turn', async () => {
    const { prepared } = await sendAndPrepare(fx, { docs: { 'a.md': 'one', 'b.md': 'two' } });
    writeFile(prepared.planningFolder, 'stray.md', 'agent made this');
    const commit = runGit(['rev-parse', 'HEAD'], fx.mac);
    const next = await fx.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit, documents: documents({ 'a.md': 'new' }), turnId: 'turn-2' });
    expect(existsSync(join(next.planningFolder, 'stray.md'))).toBe(false);
    expect(existsSync(join(next.planningFolder, 'b.md'))).toBe(false);
    expect(readFileSync(join(next.planningFolder, 'a.md'), 'utf8')).toBe('new');
    expect(next.reportFile.endsWith('turn-2.json')).toBe(true);
    expect(next.installed).toBe(false);
  });

  it('reattaches a branch that already exists, keeps it, and moves it to the commit sent', async () => {
    const first = await sendAndPrepare(fx);
    // The agent left work behind, and Mac then closed the session; a new commit was sent on top of the old one.
    writeFile(first.prepared.jobFolder, 'src/a.txt', 'agent edit\n');
    writeFile(first.prepared.jobFolder, 'src/new.txt', 'agent new\n');
    writeFile(fx.mac, 'src/a.txt', 'saved on the mac\n');
    const second = commitAll(fx.mac, 'checkpoint');
    await sendCommit(fx, { commit: second, have: [first.commit], startCommit: first.commit });
    const again = await fx.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit: second, documents: [], turnId: 'turn-2' });
    expect(again.jobFolder).toBe(first.prepared.jobFolder);
    expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], bare())).toBe(second); // the branch is kept, and moved
    expect(runGit(['rev-parse', 'HEAD'], again.jobFolder)).toBe(second);
    expect(readFileSync(join(again.jobFolder, 'src', 'a.txt'), 'utf8')).toBe('saved on the mac\n');
    expect(lstatSync(join(again.jobFolder, 'node_modules', 'dep')).isSymbolicLink()).toBe(true);
  });

  it('reattaches an existing branch whose folder has been removed, without createWorktree and without deleting the branch', async () => {
    const createWorktree = vi.fn(createQueueWorktree);
    const spied = makeFixture({ createWorktree });
    try {
      const first = await sendAndPrepare(spied);
      expect(createWorktree).toHaveBeenCalledTimes(1);
      expect(await spied.host.remove({ project: PROJECT, jobId: JOB, branch: BRANCH })).toEqual({ removed: true });
      expect(existsSync(first.prepared.jobFolder)).toBe(false);
      const sparePath = join(spied.root, 'queue-repos', `${PROJECT}.git`);
      expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], sparePath)).toBe(first.commit);

      writeFile(spied.mac, 'src/b.txt', 'second\n');
      const second = commitAll(spied.mac, 'later');
      await sendCommit(spied, { commit: second, have: [first.commit] });
      const again = await spied.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit: second, documents: [], turnId: 't9' });
      expect(createWorktree).toHaveBeenCalledTimes(1); // reattached, not created again
      expect(runGit(['rev-parse', 'HEAD'], again.jobFolder)).toBe(second);
      expect(runGit(['symbolic-ref', '--short', 'HEAD'], again.jobFolder)).toBe(BRANCH);
      expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], sparePath)).toBe(second);
      expect(lstatSync(join(again.jobFolder, 'node_modules', 'dep')).isSymbolicLink()).toBe(true);
      expect(again.provisioned).toEqual(provisionedRecord(again.jobFolder));
    } finally { spied.dispose(); }
  });

  it('leaves an existing branch alone when making a new folder fails', async () => {
    const failing = makeFixture({ createWorktree: async () => { throw new Error('disk full'); } });
    try {
      const commit = runGit(['rev-parse', 'HEAD'], failing.mac);
      await sendCommit(failing, { commit });
      await expect(failing.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit, documents: [], turnId: 't1' })).rejects.toThrow('disk full');
      expect(existsSync(join(failing.root, 'queue-docs', JOB))).toBe(false);
      expect(failing.folders.registered.size).toBe(0);
    } finally { failing.dispose(); }
  });

  it('does not touch a folder at the job\'s place that is not this job\'s checkout of its branch', async () => {
    const first = await sendAndPrepare(fx);
    runGit(['checkout', '-q', '--detach'], first.prepared.jobFolder);
    const commit = first.commit;
    await expect(fx.host.prepare({ project: PROJECT, jobId: JOB, branch: BRANCH, commit, documents: [], turnId: 't2' }))
      .rejects.toThrow(/not this job's checkout/);
    expect(runGit(['rev-parse', `refs/heads/${BRANCH}`], bare())).toBe(commit);
  });
});
