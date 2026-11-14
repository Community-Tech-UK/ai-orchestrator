/**
 * A job's turns on another computer, against the worker's real `QueueJobHost` and real git: arrange, report, save.
 * The item rows are an in-memory map; the queue's own `checkpoint` is stood in for by a commit of everything.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { runQueueJobCall } from '../../../worker-agent/queue-jobs/queue-job-dispatch';
import { BRANCH, JOB, commitAll, makeFixture, runGit, type Fixture } from '../../../worker-agent/queue-jobs/queue-job-fixture.test-helpers';
import type { QueueJobComputer } from '../../../shared/types/plan-queue-computers.types';
import type { WorkerNodeCapabilities } from '../../../shared/types/worker-node.types';
import { _setPlanQueueDataDirForTesting } from '../plan-queue-data-dir';
import { newPlanQueueItem } from '../plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from '../plan-queue.types';
import { RpcQueueJobLink } from './queue-job-link';
import { RemoteQueueJobs } from './queue-job-remote';
import { RemoteCollectRefused, PlanQueueRemoteTurns } from './plan-queue-remote-turns';
import { PlanQueueRemoteFlow } from './plan-queue-remote-flow';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

const PLAN = 'docs/plans/p_plan.md';
const REPORT = (itemId: string, extra: object = {}) => JSON.stringify({ item_id: itemId, summary: 'done', as_built: 'built', checks_run: [{ command: 'npm test', exitCode: 0 }],
  deferred_checks: [], follow_ups: [], ...extra });
let fx: Fixture;
let root: string;
let jobFolder: string;
let connected = true;
let computers: QueueJobComputer[];
let rows: Map<string, PlanQueueItem>;
let events: { reason: string | null; detailHead: string | null }[];
let turns: PlanQueueRemoteTurns;
let run: PlanQueueRun;
let ids: number;

const write = (base: string, rel: string, text: string): void => { mkdirSync(dirname(join(base, rel)), { recursive: true }); writeFileSync(join(base, rel), text); };
/** The queue's checkpoint: a planning file moves to the root checkout and stays out of the commit, then the rest is committed. */
const checkpoint = async (item: PlanQueueItem, label: string): Promise<PlanQueueItem> => {
  const planning = join(jobFolder, 'docs/plans/q_livetest.md');
  if (existsSync(planning)) { writeFileSync(join(root, 'q_livetest.md'), readFileSync(planning, 'utf8')); rmSync(planning); }
  const head = commitAll(jobFolder, label);
  return { ...item, checkpointCommit: head };
};
const current = (): PlanQueueItem => rows.get(JOB)!;

beforeEach(() => {
  connected = true;
  fx = makeFixture();
  root = realpathSync(fx.mac);
  _setPlanQueueDataDirForTesting(join(fx.dir, 'data'));
  jobFolder = join(fx.dir, 'macjob');
  runGit(['worktree', 'add', '-q', '-b', BRANCH, jobFolder], root);
  write(root, PLAN, '# plan\n');
  const start = runGit(['rev-parse', 'HEAD'], jobFolder);
  run = { id: 'run', parentInstanceId: 'owner', parentHistoryThreadId: null, kind: 'plans', status: 'running', workspaceCwd: root,
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main' }, relaxation: null, workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null };
  rows = new Map([[JOB, newPlanQueueItem(JOB, 'run', join(root, PLAN), 1, { state: 'working', branchName: BRANCH, worktreePath: jobFolder, baseCommit: start,
    checkpointCommit: start, workerInstanceId: 'worker-1' })]]);
  events = [];
  computers = [{ nodeId: 'pc', label: 'the Windows PC', takesJobs: true, paused: false, jobsAtOnce: 2, projects: {} }];
  const jobs = new RemoteQueueJobs(new RpcQueueJobLink({
    getNode: () => ({ name: 'the Windows PC', status: connected ? 'connected' : 'disconnected', capabilities: { queueJobs: 1 } } as never),
    send: (_nodeId, method, params) => runQueueJobCall(fx.host, method, params),
  }));
  computers[0]!.projects[jobs.projectKey(root)] = { ok: true, checkedAt: 1, problem: null, summary: 'fine' };
  ids = 0;
  turns = new PlanQueueRemoteTurns({
    getItem: id => rows.get(id)!, save: item => { rows.set(item.id, item); return item; }, getRun: () => run,
    store: { listActiveRuns: () => [run], listItems: () => [...rows.values()] } as never,
    history: { recordEvent: (event: { reason: string | null; detailHead: string | null }) => { events.push(event); } } as never,
  }, {
    jobs, computers: () => ({ list: () => computers }),
    nodes: { isConnected: () => connected, capabilities: () => ({ queueJobs: 1, signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-in' }] }) as WorkerNodeCapabilities },
    newTurnId: () => `turn-${++ids}`, awayLimitMs: 1000, now: () => 5000,
  }, async () => undefined);
});
afterEach(() => { _setPlanQueueDataDirForTesting(null); turns.shutdown(); fx.dispose(); });

describe('starting a turn on another computer', () => {
  it('places the job, sends its code and plan, and gives the session the far folders', async () => {
    const placed = await turns.arrange(current(), run);
    expect(placed.remote).toMatchObject({ nodeId: 'pc', label: 'the Windows PC', turnId: 'turn-1' });
    expect(placed.remote!.lastExchangedCommit).toBe(runGit(['rev-parse', 'HEAD'], jobFolder));
    expect(placed.remote!.turnStartCommit).toBe(placed.remote!.lastExchangedCommit);
    const config = turns.spawnConfig(placed, 'claude')!;
    expect(config.forceNodeId).toBe('pc');
    expect(existsSync(config.workingDirectory!)).toBe(true);
    expect(runGit(['rev-parse', 'HEAD'], config.workingDirectory!)).toBe(placed.remote!.turnStartCommit);
    expect(config.additionalDirectories).toBeUndefined();
    const prompt = turns.promptFor(placed, root)!;
    expect(prompt).toMatchObject({ computerLabel: 'the Windows PC', repoRoot: root });
    expect(readFileSync(join(prompt.planningFolder, PLAN), 'utf8')).toBe('# plan\n');
    expect(events.some(event => event.reason === 'job-placement' && event.detailHead!.includes('computer'))).toBe(true);
    expect(turns.jobsOn('pc')).toBe(1);
  });

  it('names the planning and report folders for OpenCode, whose extra folders the tool is told', async () => {
    const placed = await turns.arrange(current(), run);
    const config = turns.spawnConfig(placed, 'opencode')!;
    expect(config.additionalDirectories).toHaveLength(2);
  });

  it('keeps a live-test job, and a run kept on this Mac, here with nothing on the timeline', async () => {
    run = { ...run, kind: 'livetests' };
    expect((await turns.arrange(current(), run)).remote).toBeUndefined();
    run = { ...run, kind: 'plans', config: { ...run.config, keepOnThisMac: true } };
    expect((await turns.arrange(current(), run)).remote).toBeUndefined();
    expect(events).toEqual([]);
  });

  it('runs a job here and says why on its timeline when no computer can take it', async () => {
    connected = false;
    const placed = await turns.arrange(current(), run);
    expect(placed.remote).toBeUndefined();
    expect(events.at(-1)!.detailHead).toContain('the Windows PC is away');
  });

  it('runs a job here when the Computers settings cannot be read', async () => {
    const broken = new PlanQueueRemoteTurns(
      { getItem: id => rows.get(id)!, save: item => item, getRun: () => run, store: { listActiveRuns: () => [], listItems: () => [] } as never,
        history: { recordEvent: (event: { reason: string | null; detailHead: string | null }) => { events.push(event); } } as never },
      { jobs: {} as never, computers: () => { throw new Error('unreadable'); }, nodes: { isConnected: () => true, capabilities: () => undefined } }, async () => undefined);
    expect((await broken.arrange(current(), run)).remote).toBeUndefined();
    expect(events.at(-1)!.detailHead).toContain('could not be read (unreadable)');
  });

  it('sends a job that is already there again, with a fresh report file, after a merge of main here', async () => {
    const first = await turns.arrange(current(), run);
    write(root, 'src/b.txt', 'b from main\n');
    runGit(['add', 'src/b.txt'], root); runGit(['commit', '-qm', 'main moves'], root);
    runGit(['merge', '-q', '--no-edit', 'main'], jobFolder);
    rows.set(JOB, first);
    const second = await turns.arrange(first, run);
    expect(second.remote!.turnId).toBe('turn-2');
    expect(second.remote!.lastExchangedCommit).toBe(runGit(['rev-parse', 'HEAD'], jobFolder));
    expect(readFileSync(join(turns.spawnConfig(second, 'claude')!.workingDirectory!, 'src/b.txt'), 'utf8')).toBe('b from main\n');
  });
});

describe('merges and several jobs', () => {
  it('keeps a round with a merge to resolve on this Mac, removes the far copy, and sends the job out again once it is saved', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const far = turns.promptFor(current(), root)!.jobFolder;
    write(jobFolder, 'src/a.txt', 'job side\n'); runGit(['add', '-A'], jobFolder); runGit(['commit', '-qn', '-m', 'job edit'], jobFolder);
    write(root, 'src/a.txt', 'main side\n'); runGit(['add', '-A'], root); runGit(['commit', '-qn', '-m', 'main edit'], root);
    expect(() => runGit(['merge', '--no-edit', 'main'], jobFolder)).toThrow();
    const kept = await turns.arrange(current(), run);
    expect(kept.remote).toBeNull();
    expect(turns.promptFor(kept, root)).toBeUndefined();
    expect(existsSync(far)).toBe(false);
    expect(events.at(-1)!.detailHead).toContain('merge has to be resolved');
    runGit(['merge', '--abort'], jobFolder);
    rows.set(JOB, kept);
    expect((await turns.arrange(kept, run)).remote).toMatchObject({ nodeId: 'pc' });
  });

  it('does not let two jobs started together take a computer\'s last place', async () => {
    computers[0]!.jobsAtOnce = 1;
    const second = join(fx.dir, 'macjob2');
    runGit(['worktree', 'add', '-q', '-b', 'queue/job-two-def456', second], root);
    const start = runGit(['rev-parse', 'HEAD'], second);
    rows.set('job-two', newPlanQueueItem('job-two', 'run', join(root, PLAN), 2, { state: 'working', branchName: 'queue/job-two-def456', worktreePath: second, baseCommit: start, workerInstanceId: 'worker-2' }));
    const [one, two] = await Promise.all([turns.arrange(current(), run), turns.arrange(rows.get('job-two')!, run)]);
    expect([one.remote, two.remote].filter(Boolean)).toHaveLength(1);
    expect(events.some(event => event.detailHead?.includes('already has 1 job (its limit)'))).toBe(true);
  });

  it('is idle between turns after a save, and remembers the session so it can be stopped there', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    turns.noteSession(current(), 'worker-1');
    expect(current().remote!.instanceId).toBe('worker-1');
    write(jobFolder, 'src/here.txt', 'x\n');
    const saved = await turns.saveRound(current(), run, 'round 1 work', checkpoint);
    expect(saved.item.remote!.turnId).toBeNull();
    expect(saved.item.remote!.lastExchangedCommit).toBe(runGit(['rev-parse', 'HEAD'], jobFolder));
  });

  it('forgets a removal queued when the job last left a computer, once the job is placed there again', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const far = turns.promptFor(current(), root)!.jobFolder;
    rows.set(JOB, await turns.fallBackHere(current(), 'the Windows PC was away for ten minutes'));
    rows.set(JOB, await turns.arrange(current(), run));
    await turns.retryRemovals();
    expect(existsSync(far)).toBe(true);
    expect(current().remote).toMatchObject({ nodeId: 'pc' });
  });
});

describe('Resume after a pause or park while the computer was away', () => {
  it('takes back what the agent did there once the computer is back, instead of overwriting it when the job is sent out again', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const far = turns.promptFor(current(), root)!.jobFolder;
    write(far, 'src/made-there.txt', 'agent work on the computer\n');
    const flow = new PlanQueueRemoteFlow({
      host: { getItem: (id: string) => rows.get(id)!, getRun: () => run, save: (item: PlanQueueItem) => { rows.set(item.id, item); return item; }, requestPump: () => undefined,
        worktrees: { checkpoint } } as never,
      turns, lock: (_id, action) => action(), hold: async () => undefined, park: async () => undefined });
    // Paused while the computer was away: the work is kept there, and the turn stays open.
    connected = false;
    const stopped = await flow.copyBackForStop(current(), run);
    expect(stopped.keepThere).toBe(true);
    expect(current().remote!.turnId).toBe('turn-1');
    // Back before Resume: the work comes here first, then the job is sent out with it.
    connected = true;
    const resumed = await flow.arrange(current(), run);
    expect(readFileSync(join(jobFolder, 'src/made-there.txt'), 'utf8')).toBe('agent work on the computer\n');
    expect(resumed!.remote!.turnId).toBe('turn-3');
    expect(readFileSync(join(turns.promptFor(resumed!, root)!.jobFolder, 'src/made-there.txt'), 'utf8')).toBe('agent work on the computer\n');
  });
});

describe('the report', () => {
  const reportFile = (): string => turns.promptFor(current(), root)!.reportFile;

  it('is read from this turn\'s file and stored as the worker\'s tool report', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    writeFileSync(reportFile(), REPORT(JOB, { deferred_checks: [{ title: 'Live check', steps: 's', expectedResult: 'e', whyDeferred: 'w' }] }));
    const stored = await turns.storeReport(current(), 'worker-1', run);
    expect(stored.workerReport).toMatchObject({ summary: 'done', asBuilt: 'built', checksRun: [{ command: 'npm test', exitCode: 0 }], deferredChecks: [{ title: 'Live check' }] });
  });

  it('counts a missing file as no report', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    expect((await turns.storeReport(current(), 'worker-1', run)).workerReport).toBeUndefined();
  });

  it('counts a malformed file, or one naming another job, as no report and says so in words', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    writeFileSync(reportFile(), '{ not json');
    let stored = await turns.storeReport(current(), 'worker-1', run);
    expect(stored.workerReport).toBeUndefined();
    expect(stored.detail).toContain('could not be used');
    writeFileSync(reportFile(), REPORT('another-job'));
    stored = await turns.storeReport(current(), 'worker-1', run);
    expect(stored.workerReport).toBeUndefined();
    expect(stored.detail).toContain('names another job');
  });

  it('never reads an earlier turn\'s file, and a new turn deletes it', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const oldFile = reportFile();
    writeFileSync(oldFile, REPORT(JOB));
    rows.set(JOB, { ...current(), workerReport: null });
    rows.set(JOB, await turns.arrange(current(), run));
    expect(reportFile()).not.toBe(oldFile);
    expect((await turns.storeReport(current(), 'worker-1', run)).workerReport).toBeFalsy();
    expect(existsSync(oldFile)).toBe(false);
  });

  it('only the job\'s current worker may have its report stored', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    writeFileSync(reportFile(), REPORT(JOB));
    await expect(turns.storeReport(current(), 'someone-else', run)).rejects.toThrow('Only the worker currently assigned');
  });
});

describe('saving a turn', () => {
  async function farTurn(): Promise<{ far: string; planning: string }> {
    rows.set(JOB, await turns.arrange(current(), run));
    const prompt = turns.promptFor(current(), root)!;
    write(prompt.jobFolder, 'src/a.txt', 'edited on the PC\n');
    write(prompt.jobFolder, 'src/new.txt', 'new\n');
    write(prompt.jobFolder, 'docs/plans/q_livetest.md', 'a deferred check\n');
    write(prompt.planningFolder, PLAN, '# plan\nticked on the PC\n');
    return { far: prompt.jobFolder, planning: prompt.planningFolder };
  }

  it('collects the far folder, saves it here with the usual checkpoint, and moves the far folder to the commit', async () => {
    const { far } = await farTurn();
    const saved = await turns.saveRound(current(), run, 'round 1 work', async (item, label) => {
      // The queue's checkpoint moves a planning file out of the folder and commits the rest.
      expect(readFileSync(join(jobFolder, 'src/a.txt'), 'utf8')).toBe('edited on the PC\n');
      expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\nticked on the PC\n');
      return checkpoint(item, label);
    });
    expect(saved.hold).toBeNull();
    const head = runGit(['rev-parse', 'HEAD'], jobFolder);
    expect(saved.item.remote!.lastExchangedCommit).toBe(head);
    expect(runGit(['rev-parse', 'HEAD'], far)).toBe(head);
  });

  it('deletes the files the save left out of the far folder', async () => {
    const { far } = await farTurn();
    await turns.saveRound(current(), run, 'round 1 work', async (item, label) => {
      return checkpoint(item, label);
    });
    expect(existsSync(join(far, 'docs/plans/q_livetest.md'))).toBe(false);
  });

  it('holds the job, naming the computer, when the plan changed here while it was away', async () => {
    await farTurn();
    writeFileSync(join(root, PLAN), '# plan\nJames edited this\n');
    const saved = await turns.saveRound(current(), run, 'round 1 work', checkpoint);
    expect(saved.hold).toBe('the plan changed here while the job was on the Windows PC');
    expect(readFileSync(join(root, PLAN), 'utf8')).toBe('# plan\nJames edited this\n');
  });

  it('refuses a collect, with a plain reason, when this Mac\'s folder moved since the turn started', async () => {
    await farTurn();
    write(jobFolder, 'src/c.txt', 'c\n');
    commitAll(jobFolder, 'someone moved the folder');
    await expect(turns.collect(current(), run)).rejects.toThrow(RemoteCollectRefused);
    await expect(turns.collect(current(), run)).rejects.toThrow('moved while the Windows PC was working');
    expect(readFileSync(join(jobFolder, 'src/a.txt'), 'utf8')).toBe('one\n');
  });

  it('refuses a commit the agent made itself, and a session still running, and keeps its work there', async () => {
    const { far } = await farTurn();
    runGit(['add', '-A'], far); runGit(['commit', '-qn', '-m', 'the agent committed'], far);
    await expect(turns.collect(current(), run)).rejects.toMatchObject({ reason: 'agent-committed', message: expect.stringContaining('kept on the Windows PC') });
    fx.folders.busy = true;
    await expect(turns.collect(current(), run)).rejects.toMatchObject({ reason: 'session-running' });
  });

  it('refuses when nothing was ever sent', async () => {
    rows.set(JOB, { ...current(), remote: { nodeId: 'pc', label: 'the Windows PC', branch: BRANCH, lastExchangedCommit: null, turnStartCommit: null, turnId: null } });
    await expect(turns.collect(current(), run)).rejects.toMatchObject({ reason: 'nothing-sent' });
  });

  it('a job with no computer is simply saved by the usual checkpoint', async () => {
    write(jobFolder, 'src/here.txt', 'made here\n');
    const saved = await turns.saveRound(current(), run, 'round 1 work', checkpoint);
    expect(saved.hold).toBeNull();
    expect(saved.item.remote).toBeUndefined();
    expect(saved.item.checkpointCommit).toBe(runGit(['rev-parse', 'HEAD'], jobFolder));
  });
});

describe('leaving the computer', () => {
  it('removes the far copy and the job\'s computer, and keeps the bare repository for the next job', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const far = turns.promptFor(current(), root)!.jobFolder;
    const released = await turns.release(current(), run);
    expect(released.remote).toBeNull();
    expect(existsSync(far)).toBe(false);
    expect(existsSync(join(fx.root, 'queue-repos'))).toBe(true);
    expect(turns.jobsOn('pc')).toBe(0);
  });

  it('queues the removal of a computer that is away, and does it when it is back', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const far = turns.promptFor(current(), root)!.jobFolder;
    connected = false;
    const released = await turns.release(current(), run);
    expect(released.remote).toBeNull();
    expect(existsSync(far)).toBe(true);
    await turns.retryRemovals();
    expect(existsSync(far)).toBe(true);
    connected = true;
    await turns.retryRemovals();
    expect(existsSync(far)).toBe(false);
  });

  it('carries on here from the last checkpoint, with the removal queued, when the computer has gone', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const here = await turns.fallBackHere(current(), 'the Windows PC was away for ten minutes');
    expect(here.remote).toBeNull();
    expect(here.detail).toContain('Carrying on here from the last saved point');
    expect(turns.promptFor(here, root)).toBeUndefined();
  });

  it('counts ten minutes away from when it was found away', async () => {
    rows.set(JOB, await turns.arrange(current(), run));
    const marked = turns.markAway(current(), async () => 'done');
    expect(marked.remote!.awaySince).toBe(5000);
    expect(turns.awayExpired(marked)).toBe(false);
    expect(turns.awayExpired({ ...marked, remote: { ...marked.remote!, awaySince: 3000 } })).toBe(true);
    turns.stopWatching(JOB);
  });
});
