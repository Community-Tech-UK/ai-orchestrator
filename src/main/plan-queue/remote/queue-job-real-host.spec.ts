/**
 * This Mac's half against the worker's real `QueueJobHost` (src/worker-agent/queue-jobs), reached through the same
 * dispatcher the worker connection uses, so both sides' schemas are exercised: params and results are parsed in both directions.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runQueueJobCall } from '../../../worker-agent/queue-jobs/queue-job-dispatch';
import { BRANCH, JOB, commitAll, makeFixture, runGit, type Fixture } from '../../../worker-agent/queue-jobs/queue-job-fixture.test-helpers';
import { _setPlanQueueDataDirForTesting } from '../plan-queue-data-dir';
import { RpcQueueJobLink } from './queue-job-link';
import { RemoteQueueJobs, type RemoteComputer, type RemoteJobItem } from './queue-job-remote';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const PC: RemoteComputer = { nodeId: 'node-pc', label: 'the Windows PC' };
const PLAN = 'docs/plans/p_plan.md';
let fx: Fixture;
let remote: RemoteQueueJobs;
let root: string;
let jobFolder: string;
let item: RemoteJobItem;

const writeIn = (base: string, rel: string, text: string): void => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text); };

beforeEach(() => {
  fx = makeFixture();
  root = realpathSync(fx.mac);
  _setPlanQueueDataDirForTesting(join(fx.dir, 'data'));
  jobFolder = join(fx.dir, 'macjob');
  runGit(['worktree', 'add', '-q', '-b', BRANCH, jobFolder], root);
  writeIn(root, PLAN, '# plan\n');
  item = { id: JOB, sourceRef: join(root, PLAN), branchName: BRANCH };
  remote = new RemoteQueueJobs(new RpcQueueJobLink({
    getNode: () => ({ name: PC.label, status: 'connected', capabilities: { queueJobs: 1 } } as never),
    send: (_nodeId, method, params) => runQueueJobCall(fx.host, method, params),
  }));
});
afterEach(() => { _setPlanQueueDataDirForTesting(null); fx.dispose(); });

describe('this Mac with the worker\'s real host', () => {
  it('sends a job, takes the agent\'s work back (code and plan), sends the save, and cleans up', async () => {
    const start = runGit(['rev-parse', 'HEAD'], jobFolder);
    await remote.send({ computer: PC, repoRoot: root, item, commit: start, baseBranch: 'main', startCommit: start, lastExchanged: null });
    const prepared = await remote.prepare({ computer: PC, repoRoot: root, item, commit: start, turnId: 'turn-1' });
    expect(readFileSync(join(prepared.planningFolder, PLAN), 'utf8')).toBe('# plan\n');
    expect(runGit(['rev-parse', 'HEAD'], prepared.jobFolder)).toBe(start);

    writeIn(prepared.jobFolder, 'src/a.txt', 'one, edited by the agent\n');
    rmSync(join(prepared.jobFolder, 'src/b.txt'));
    writeIn(prepared.jobFolder, 'src/new.txt', 'new\n');
    writeIn(prepared.jobFolder, 'docs/plans/q_livetest.md', 'checks\n');
    writeIn(prepared.planningFolder, PLAN, '# plan\nthe agent ticked a box\n');

    const result = await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: start });
    if (result.outcome !== 'collected') throw new Error(`${result.outcome}: ${JSON.stringify(result)}`);
    expect(result.changedFiles.sort()).toEqual(['docs/plans/q_livetest.md', 'src/a.txt', 'src/b.txt', 'src/new.txt']);
    expect(result.changedFiles.some(file => file.startsWith('node_modules'))).toBe(false);
    expect(result.leftOut).toEqual(['docs/plans/q_livetest.md']);
    expect(runGit(['status', '--porcelain', '--untracked-files=all'], jobFolder).split('\n').map(line => line.trim()).sort())
      .toEqual(['?? docs/plans/q_livetest.md', '?? src/new.txt', 'D src/b.txt', 'M src/a.txt']);
    expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\nthe agent ticked a box\n');
    expect(result.documents.replaced).toEqual([PLAN]);

    // The queue's save: the planning file goes to the root checkout, the rest is committed.
    rmSync(join(jobFolder, 'docs/plans/q_livetest.md'));
    const saved = commitAll(jobFolder, 'round 1 work');
    await remote.send({ computer: PC, repoRoot: root, item, commit: saved, baseBranch: 'main', startCommit: start, lastExchanged: start });
    await remote.prepare({ computer: PC, repoRoot: root, item, commit: saved, turnId: 'turn-2' });
    expect(runGit(['rev-parse', 'HEAD'], prepared.jobFolder)).toBe(saved);
    const gone = await remote.deleteLeftOut({ computer: PC, repoRoot: root, item, files: result.leftOut });
    expect(gone.deleted).toEqual(['docs/plans/q_livetest.md']);
    expect(existsSync(join(prepared.jobFolder, 'docs/plans/q_livetest.md'))).toBe(false);

    // The next turn changes nothing: nothing comes back and nothing is rewritten.
    const quiet = await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: saved });
    expect(quiet).toMatchObject({ outcome: 'collected', applied: 'none', changedFiles: [] });
    expect(runGit(['status', '--porcelain'], jobFolder)).toBe('');

    expect(await remote.remove({ computer: PC, repoRoot: root, item })).toBe(true);
    expect(existsSync(prepared.jobFolder)).toBe(false);
  });

  it('survives a merge of main made here between turns', async () => {
    const start = runGit(['rev-parse', 'HEAD'], jobFolder);
    await remote.send({ computer: PC, repoRoot: root, item, commit: start, baseBranch: 'main', startCommit: start, lastExchanged: null });
    const first = await remote.prepare({ computer: PC, repoRoot: root, item, commit: start, turnId: 'turn-1' });
    writeIn(first.jobFolder, 'src/a.txt', 'a from the job\n');
    await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: start });
    const saved = commitAll(jobFolder, 'round 1 work');
    writeIn(root, 'src/b.txt', 'b from main\n');
    runGit(['add', 'src/b.txt'], root);
    runGit(['commit', '-qm', 'main moves'], root);
    runGit(['merge', '-q', '--no-edit', 'main'], jobFolder);
    const merged = runGit(['rev-parse', 'HEAD'], jobFolder);

    await remote.send({ computer: PC, repoRoot: root, item, commit: merged, baseBranch: 'main', startCommit: start, lastExchanged: saved });
    await remote.prepare({ computer: PC, repoRoot: root, item, commit: merged, turnId: 'turn-2' });
    expect(readFileSync(join(first.jobFolder, 'src/b.txt'), 'utf8')).toBe('b from main\n');
    writeIn(first.jobFolder, 'src/c.txt', 'c from the job\n');
    const result = await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: merged });
    if (result.outcome !== 'collected') throw new Error(result.outcome);
    expect(result.changedFiles).toEqual(['src/c.txt']);
    expect(readFileSync(join(jobFolder, 'src/b.txt'), 'utf8')).toBe('b from main\n');
    expect(readFileSync(join(jobFolder, 'src/a.txt'), 'utf8')).toBe('a from the job\n');
    expect(runGit(['rev-parse', 'HEAD'], jobFolder)).toBe(merged);
  });

  it('returns the worker\'s refusals unchanged, and changes nothing here', async () => {
    const start = runGit(['rev-parse', 'HEAD'], jobFolder);
    await remote.send({ computer: PC, repoRoot: root, item, commit: start, baseBranch: 'main', startCommit: start, lastExchanged: null });
    const prepared = await remote.prepare({ computer: PC, repoRoot: root, item, commit: start, turnId: 'turn-1' });
    writeIn(prepared.jobFolder, 'src/a.txt', 'edited\n');
    fx.folders.busy = true;
    expect(await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: start })).toMatchObject({ outcome: 'refused', reason: 'session-running' });
    fx.folders.busy = false;
    runGit(['commit', '-qam', 'the agent committed'], prepared.jobFolder);
    expect(await remote.collect({ computer: PC, repoRoot: root, item, jobFolder, expectedParent: start })).toMatchObject({ outcome: 'refused', reason: 'agent-committed' });
    expect(runGit(['status', '--porcelain'], jobFolder)).toBe('');
    expect(readFileSync(join(jobFolder, 'src/a.txt'), 'utf8')).toBe('one\n');
  });

  it('runs a project check through the real host', async () => {
    const result = await remote.projectCheck({ computer: PC, repoRoot: root, baseBranch: 'main' });
    expect(result.checkedAt).toBeGreaterThan(0);
    expect(typeof result.summary).toBe('string');
  });
});
