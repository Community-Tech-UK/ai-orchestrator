import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _setPlanQueueDataDirForTesting } from '../plan-queue-data-dir';
import { FakeComputer, FakeMac } from './queue-job-fake-computer.test-helpers';
import { QueueJobLinkError } from './queue-job-link';
import { readSentRecord } from './queue-job-planning-docs';
import { RemoteQueueJobs, type RemoteComputer, type RemoteJobItem } from './queue-job-remote';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const PC: RemoteComputer = { nodeId: 'node-pc', label: 'the Windows PC' };
const PLAN = 'docs/plans/x_plan.md';
let mac: FakeMac;
let far: FakeComputer;
let remote: RemoteQueueJobs;
let root: string;
let item: RemoteJobItem;

const writeRoot = (rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

beforeEach(() => {
  mac = new FakeMac();
  root = realpathSync(mac.repo);
  far = new FakeComputer();
  remote = new RemoteQueueJobs(far);
  _setPlanQueueDataDirForTesting(join(mac.root, 'data'));
  writeRoot(PLAN, '# plan\n');
  item = { id: 'job-1', sourceRef: join(root, PLAN), branchName: mac.branch };
});
afterEach(() => { _setPlanQueueDataDirForTesting(null); mac.dispose(); far.dispose(); });

async function startTurn(commit: string, lastExchanged: string | null, turnId: string): Promise<void> {
  await remote.send({ computer: PC, repoRoot: root, item, commit, baseBranch: 'main', startCommit: mac.head(root), lastExchanged });
  await remote.prepare({ computer: PC, repoRoot: root, item, commit, turnId });
}
const collect = (expectedParent: string) => remote.collect({ computer: PC, repoRoot: root, item, jobFolder: mac.job, expectedParent });

describe('RemoteQueueJobs', () => {
  it('runs two rounds: code and plan come back, the save goes out, and what the save left out is deleted over there', async () => {
    const start = mac.head();
    await startTurn(start, null, 'turn-1');
    expect(readFileSync(join(far.planningFolder('job-1'), PLAN), 'utf8')).toBe('# plan\n');
    far.agentWrite('job-1', 'src/a.txt', 'a by agent\n');
    far.agentWrite('job-1', 'docs/plans/made_livetest.md', 'made in the job folder\n');
    far.agentWritePlanning('job-1', PLAN, '# plan\nagent notes\n');

    const first = await collect(start);
    if (first.outcome !== 'collected') throw new Error(first.outcome);
    expect(first.leftOut).toEqual(['docs/plans/made_livetest.md']);
    expect(first.documents.replaced).toEqual([PLAN]);
    expect(first.summary).toBe('Copied 2 changed files back from the Windows PC. Updated docs/plans/x_plan.md here.');
    expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\nagent notes\n');
    expect(mac.read('src/a.txt')).toBe('a by agent\n');

    // The queue's save moves the planning file to the root checkout (not simulated) and commits the rest.
    rmSync(join(mac.job, 'docs/plans/made_livetest.md'));
    const saved = mac.save('round 1');

    await startTurn(saved, start, 'turn-2');
    expect(far.agentGit('job-1', 'rev-parse', 'HEAD')).toBe(saved);
    expect(existsSync(join(far.jobFolder('job-1'), 'docs/plans/made_livetest.md'))).toBe(true);
    const gone = await remote.deleteLeftOut({ computer: PC, repoRoot: root, item, files: first.leftOut });
    expect(gone.deleted).toEqual(['docs/plans/made_livetest.md']);
    expect(existsSync(join(far.jobFolder('job-1'), 'docs/plans/made_livetest.md'))).toBe(false);
    expect(Object.keys(await readSentRecord(root, 'job-1'))).toContain(PLAN);
  });

  it('holds the job when the plan changed here meanwhile, naming the computer', async () => {
    const start = mac.head();
    await startTurn(start, null, 'turn-1');
    far.agentWritePlanning('job-1', PLAN, '# plan\nthe job\n');
    writeRoot(PLAN, '# plan\njames\n');
    const result = await collect(start);
    if (result.outcome !== 'collected') throw new Error(result.outcome);
    expect(result.documents.hold?.text).toBe('the plan changed here while the job was on the Windows PC');
    expect(result.summary).toContain('the plan changed here while the job was on the Windows PC');
    expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\njames\n');
  });

  it('returns a refusal as an outcome and changes nothing here', async () => {
    const start = mac.head();
    await startTurn(start, null, 'turn-1');
    far.sessionRunning = true;
    far.agentWritePlanning('job-1', PLAN, '# plan\nnot yet\n');
    const result = await collect(start);
    expect(result).toMatchObject({ outcome: 'refused', reason: 'session-running' });
    expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\n');
  });

  it('throws a link error when the computer has gone away', async () => {
    const start = mac.head();
    await startTurn(start, null, 'turn-1');
    far.online = false;
    await expect(collect(start)).rejects.toBeInstanceOf(QueueJobLinkError);
  });

  it('needs a send before prepare, and a branch', async () => {
    await expect(remote.prepare({ computer: PC, repoRoot: root, item, commit: mac.head(), turnId: 'turn-1' })).rejects.toThrow(/Nothing was sent/);
    await remote.send({ computer: PC, repoRoot: root, item, commit: mac.head(), baseBranch: 'main', startCommit: mac.head(), lastExchanged: null });
    await expect(remote.prepare({ computer: PC, repoRoot: root, item: { ...item, branchName: null }, commit: mac.head(), turnId: 'turn-1' })).rejects.toThrow(/no branch/);
  });

  it('removes the job over there and forgets what was sent; forget does the same without the computer', async () => {
    await startTurn(mac.head(), null, 'turn-1');
    expect(await remote.remove({ computer: PC, repoRoot: root, item })).toBe(true);
    expect(await readSentRecord(root, 'job-1')).toEqual({});
    await remote.send({ computer: PC, repoRoot: root, item, commit: mac.head(), baseBranch: 'main', startCommit: mac.head(), lastExchanged: null });
    far.online = false;
    await expect(remote.remove({ computer: PC, repoRoot: root, item })).rejects.toBeInstanceOf(QueueJobLinkError);
    expect(Object.keys(await readSentRecord(root, 'job-1')).length).toBeGreaterThan(0);
    await remote.forget({ repoRoot: root, item });
    expect(await readSentRecord(root, 'job-1')).toEqual({});
  });

  it('reads one turn\'s report, and makes no call when there is nothing to delete', async () => {
    expect(await remote.readReport({ computer: PC, item, turnId: 'turn-1' })).toBeNull();
    expect(await remote.deleteLeftOut({ computer: PC, repoRoot: root, item, files: [] })).toEqual({ deleted: [], skipped: [] });
    expect(far.calls).toEqual(['readReport']);
  });

  describe('projectCheck', () => {
    it('sends the base tip and returns a plain summary', async () => {
      const result = await remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'main' });
      expect(result).toMatchObject({ ok: true, problem: null, summary: "Checks took 43 s; a job folder's dependencies took 0.2 s." });
      expect(far.hasCommit(mac.head(root))).toBe(true);
      expect(far.sentFor('project-check')?.commit).toBe(mac.head(root));
    });

    it('says why a check failed', async () => {
      far.checkResult = { ok: false, steps: [{ name: 'lint', ms: 900, ok: false, tail: 'x' }], copyMs: null, problem: null };
      expect(await remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'main' })).toMatchObject({ ok: false, problem: 'lint failed on the Windows PC.' });
      far.checkResult = { ...far.checkResult, problem: 'Node is not installed on the Windows PC.' };
      expect((await remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'main' })).problem).toBe('Node is not installed on the Windows PC.');
    });

    it('reports a missing branch, and throws rather than record a failure when the computer is away', async () => {
      expect(await remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'nope' })).toMatchObject({ ok: false, problem: 'The branch nope was not found in this repository.' });
      far.online = false;
      await expect(remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'main' })).rejects.toBeInstanceOf(QueueJobLinkError);
    });
  });

  it('gives the Computers page the same project key the calls use', () => {
    expect(remote.projectKey(root)).toMatch(/^repo-[0-9a-f]{8}$/);
  });
});
