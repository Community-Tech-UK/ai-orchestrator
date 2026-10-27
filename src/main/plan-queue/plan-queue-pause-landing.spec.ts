import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { captureFixtureSpawns, ProcessFixtureRegistry, waitForFixtureProcessExit } from '../../tests/fixtures/process-fixture';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { stillRunsOn } from './plan-queue-account-rules-live';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

let repo: string;
let restoreSpawns: () => void;
let fixtures: ProcessFixtureRegistry;
let flow: PlanQueueItemFlow;
const git = (args: string[], cwd = repo): string => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  fixtures = new ProcessFixtureRegistry();
  restoreSpawns = captureFixtureSpawns(fixtures);
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-pause-landing-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']);
  git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, '.git', 'test-hooks'));
  git(['config', 'core.hooksPath', join(repo, '.git', 'test-hooks')]);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
});
afterEach(async () => {
  try {
    await fixtures.cleanup();
    await flow?.whenSettled();
  } finally {
    restoreSpawns();
    rmSync(repo, { recursive: true, force: true });
    GitWriteQueue._resetForTesting();
  }
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function fixture() {
  const base = git(['rev-parse', 'HEAD']);
  const worktree = join(repo, 'wt');
  const branch = 'queue/item';
  git(['worktree', 'add', '-qb', branch, worktree, 'main']);
  writeFileSync(join(worktree, 'a.txt'), 'worker\n');
  git(['add', 'a.txt'], worktree); git(['commit', '--no-verify', '-qm', 'work'], worktree);
  const checkpoint = git(['rev-parse', 'HEAD'], worktree);
  const item = newPlanQueueItem('item', 'run', join(repo, 'x_plan.md'), 1, {
    state: 'landing', worktreePath: worktree, branchName: branch, baseCommit: base,
    checkpointCommit: checkpoint, verifiedMainCommit: base, round: 1,
    verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: false, needJames: [] },
  });
  const run: PlanQueueRun = {
    id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo,
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', postMergeGate: [] },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null,
  };
  const items = new Map([[item.id, item]]);
  const save = (next: PlanQueueItem) => { items.set(next.id, next); return next; };
  const worktrees = {
    checkpoint: async (next: PlanQueueItem) => save({ ...next, checkpointCommit: git(['rev-parse', 'HEAD'], worktree) }),
    removeWithProof: async () => ({ removed: false, reason: 'retained', detail: 'test keeps worktree' }),
  };
  const host = {
    getRun: () => run, getItem: (id: string) => items.get(id)!, save, worktrees,
    transition: (next: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => {
      assertItemTransition(next.state, state); return save({ ...next, ...patch, state });
    },
    requestPump: () => undefined,
    // Session ports, for the checker cleanup that a hold on a landing item runs.
    tracker: { untrack: () => undefined },
    unregisterRole: () => undefined,
    instances: { getInstance: () => undefined, terminateInstance: async () => undefined },
  } as unknown as PlanQueueFlowHost;
  flow = new PlanQueueItemFlow(host);
  return { run, worktree, branch, base, checkpoint, get: (id = 'item') => items.get(id)!, save, worktrees };
}

/** A real descendant that remains running until Pause stops the owned process group. */
function waitingCommand(pidFile: string): string {
  fixtures.trackPidFile(pidFile);
  return `sleep 60 &\necho $! > "${pidFile}"\nwait\n`;
}

describe.skipIf(process.platform === 'win32')('pause during landing', () => {
  it.each(['post-merge gate', 'commit hook'] as const)('stops an active %s and retains the work for verification', async (stage) => {
    const test = fixture();
    const pidFile = join(repo, '.git', 'waiting.pid');
    if (stage === 'commit hook') {
      const hook = join(repo, '.git', 'test-hooks', 'pre-commit');
      writeFileSync(hook, `#!/bin/sh\n${waitingCommand(pidFile)}`); chmodSync(hook, 0o755);
    } else {
      writeFileSync(join(repo, 'other.txt'), 'another item landed\n');
      git(['add', 'other.txt']); git(['commit', '-qm', 'main moved']);
      test.run.config.postMergeGate = [waitingCommand(pidFile), 'touch must-not-run.txt'];
    }
    const mainBefore = git(['rev-parse', 'main']);
    const landing = flow.enqueueLanding('item');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());

    test.run.status = 'paused';
    await flow.hold('item');
    await landing;

    await waitForFixtureProcessExit(childPid);
    expect(test.get()).toMatchObject({ state: 'awaiting-slot', parkReason: null, round: 1,
      erroredRounds: 0, landingRefusals: 0, heldAt: expect.any(Number), landedCommit: null });
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(git(['branch', '--show-current'], test.worktree)).toBe(test.branch);
    expect(readFileSync(join(test.worktree, 'a.txt'), 'utf8')).toBe('worker\n');
    expect(git(['status', '--porcelain'], test.worktree)).toBe('');
    expect(existsSync(join(test.worktree, 'must-not-run.txt'))).toBe(false);
  });

  it('waits for a queued landing to stop when an earlier landing still owns the shared slot', async () => {
    const test = fixture();
    const pidFile = join(repo, '.git', 'waiting.pid');
    const hook = join(repo, '.git', 'test-hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\n${waitingCommand(pidFile)}`); chmodSync(hook, 0o755);
    const first = flow.enqueueLanding('item');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    // This second item never touches the shared fixture checkout: Pause cancels it before promotion.
    test.save({ ...test.get(), id: 'second' });
    const second = flow.enqueueLanding('second');
    test.run.status = 'paused';
    let held = false;
    const holdingSecond = flow.hold('second').then(() => { held = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(held).toBe(false);
    await Promise.all([flow.hold('item'), holdingSecond, first, second]);
    expect(test.get('second')).toMatchObject({ state: 'awaiting-slot', parkReason: null });
    expect(git(['rev-parse', 'main'])).toBe(test.base);
  });

  it('lets a landing finish when a rule change arrives before the merge, instead of aborting it', async () => {
    const test = fixture();
    test.save({ ...test.get(), verifierInstanceId: 'checker' });
    // The landing's final checkpoint runs before the merge; hold the landing there while the rule change arrives.
    const checkpoint = test.worktrees.checkpoint;
    let release!: () => void;
    let entered!: () => void;
    const checkpointStarted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    test.worktrees.checkpoint = async (next: PlanQueueItem) => {
      entered(); await gate;
      return checkpoint(next);
    };
    const landing = flow.enqueueLanding('item');
    try {
      await checkpointStarted;
      // The merge has not happened yet. The rule change's hold must leave the landing alone.
      const held = flow.hold('item', 'Restarting on another account: this account is on your Plan Queue never-use list.', stillRunsOn('checker'));
      await Promise.resolve();
      release(); await Promise.all([held, landing]);
    } finally { release(); await landing; }
    expect(test.get().state).toBe('landed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('worker\n');
  });

  it('finishes cleanup after promotion before Pause can finish', async () => {
    const test = fixture();
    let release!: () => void;
    let entered!: () => void;
    const cleanupStarted = new Promise<void>(resolve => { entered = resolve; });
    const cleanup = new Promise<void>(resolve => { release = resolve; });
    test.worktrees.removeWithProof = async () => {
      entered(); await cleanup;
      return { removed: false, reason: 'retained', detail: 'test keeps worktree' };
    };
    const landing = flow.enqueueLanding('item');
    try {
      await cleanupStarted;
      expect(git(['rev-parse', 'main'])).not.toBe(test.base);
      test.run.status = 'paused';
      let stopped = false;
      const held = flow.hold('item').then(() => { stopped = true; });
      await Promise.resolve(); expect(stopped).toBe(false);
      release(); await Promise.all([held, landing]);
    } finally { release(); await landing; }
    expect(test.get().state).toBe('landed');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('worker\n');
  });

  it('keeps Pause waiting or failed until a cancelled checkout can be recovered', async () => {
    const test = fixture();
    const pidFile = join(repo, '.git', 'waiting.pid');
    const hook = join(repo, '.git', 'test-hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\n${waitingCommand(pidFile)}`); chmodSync(hook, 0o755);
    const landing = flow.enqueueLanding('item');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const indexLock = git(['rev-parse', '--git-path', 'index.lock'], test.worktree);
    writeFileSync(indexLock, 'Simulated checkout lock\n');
    let release!: () => void;
    let entered!: () => void;
    const recovering = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    test.worktrees.checkpoint = async next => {
      entered(); await gate;
      if (existsSync(indexLock)) throw new Error('Checkpoint recovery blocked');
      git(['checkout', '-f', '-q', test.branch], test.worktree);
      return test.save(next);
    };
    test.run.status = 'paused';
    let held = false;
    let rejected = false;
    const holding = flow.hold('item').then(() => { held = true; }, () => { rejected = true; });
    try {
      await recovering;
      await new Promise(resolve => setImmediate(resolve));
      expect({ held, rejected }).toEqual({ held: false, rejected: false });
      release(); await Promise.all([holding, landing]);
      expect({ held, rejected }).toEqual({ held: false, rejected: true });
      expect(test.get().state).toBe('landing');
      rmSync(indexLock);
      await flow.hold('item');
      expect(test.get()).toMatchObject({ state: 'awaiting-slot', parkReason: null, heldAt: expect.any(Number) });
      expect(git(['branch', '--show-current'], test.worktree)).toBe(test.branch);
      expect(git(['rev-parse', 'main'])).toBe(test.base);
    } finally {
      rmSync(indexLock, { force: true }); release();
      await Promise.all([holding, landing]);
    }
  });
});
