import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { captureFixtureSpawns, ProcessFixtureRegistry, waitForFixtureProcessExit } from '../../tests/fixtures/process-fixture';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import type { PlanQueueFlowHost, PlanQueueInstanceRecord } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { itemStage, itemStages } from './plan-queue-item-stage';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { recordTiming, TIMING_REASONS } from './plan-queue-timings';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const marks = (enteredAt: number | null, checksAt: number | null = null, landingAt: number | null = null) => ({ enteredAt, checksAt, landingAt });
const item = (patch: Partial<PlanQueueItem>) => newPlanQueueItem('item', 'run', '/repo/a_plan.md', 1, patch);

describe('itemStage', () => {
  it('names the three steps that have no session, timed from stored history', () => {
    expect(itemStage(item({ state: 'awaiting-slot' }), marks(100), 0)).toEqual({ name: 'waiting-for-checks', startedAt: 100 });
    expect(itemStage(item({ state: 'verifying', detail: 'Running checks' }), marks(100, 160), 0)).toEqual({ name: 'checks', startedAt: 160 });
    expect(itemStage(item({ state: 'landing' }), marks(100, null, 130), 0)).toEqual({ name: 'landing', startedAt: 130 });
  });

  it('ignores a check run from an earlier round', () => {
    expect(itemStage(item({ state: 'verifying' }), marks(100, 40), 0)).toEqual({ name: 'checks', startedAt: 100 });
  });

  it('shows no stage while a checker session exists, the item is paused, or it is in any other state', () => {
    expect(itemStage(item({ state: 'verifying', verifierInstanceId: 'checker' }), marks(100), 0)).toBeNull();
    expect(itemStage(item({ state: 'awaiting-slot', heldAt: 5 }), marks(100), 0)).toBeNull();
    for (const state of ['queued', 'working', 'fixing', 'landed', 'parked'] as const) {
      expect(itemStage(item({ state }), marks(100), 0)).toBeNull();
    }
  });

  it('keeps a landing item waiting until its own turn starts', () => {
    expect(itemStage(item({ state: 'landing' }), marks(100), 0)).toEqual({ name: 'waiting-to-land', startedAt: 100 });
    // A turn from an earlier landing state (Land anyway after a set-aside) is not this one.
    expect(itemStage(item({ state: 'landing' }), marks(100, null, 90), 0)).toEqual({ name: 'waiting-to-land', startedAt: 100 });
  });

  it('treats a landing turn recorded before this app session as ended', () => {
    expect(itemStage(item({ state: 'landing' }), marks(100, null, 130), 200)).toEqual({ name: 'waiting-to-land', startedAt: 100 });
  });

  it('gives no time when history has no row for it', () => {
    expect(itemStage(item({ state: 'awaiting-slot' }), undefined, 0)).toEqual({ name: 'waiting-for-checks', startedAt: null });
  });
});

let db: SqliteDriver | undefined;
beforeAll(() => initSqliteWasm());
afterEach(() => { db?.close(); db = undefined; });

const RUN: PlanQueueRun = {
  id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
  status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
  workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null,
};

describe('itemStages from stored history', () => {
  it('reads each item\'s start time and survives a restart', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    let now = 1_000;
    const store = new PlanQueueStore(db, () => now);
    store.upsertRun(RUN);
    const save = (next: PlanQueueItem, at: number) => { now = at; store.upsertItem(next); return next; };
    const checking = save(newPlanQueueItem('checking', 'run', '/repo/a_plan.md', 1, { state: 'awaiting-slot' }), 1_000);
    save({ ...checking, state: 'verifying', detail: 'Running checks' }, 2_000);
    now = 2_500; store.history.recordChecklistRun({ ...checking, state: 'verifying' }, ['checking']);
    const waiting = save(newPlanQueueItem('waiting', 'run', '/repo/b_plan.md', 1, { state: 'awaiting-slot' }), 3_000);
    // A save that keeps the state (a new detail) and a measurement row do not restart the clock.
    save({ ...waiting, detail: 'Checks are paused or the computer is busy.' }, 3_500);
    now = 3_550; recordTiming(store.history, waiting, TIMING_REASONS.usageWait, { kind: 'check', waitedMs: 1 });
    const working = save(newPlanQueueItem('working', 'run', '/repo/c_plan.md', 1, { state: 'working' }), 3_600);

    const read = (from: PlanQueueStore) => itemStages(from.history, from.listItems('run'), 0);
    const stages = read(store);
    expect(stages.get('checking')).toEqual({ name: 'checks', startedAt: 2_500 });
    expect(stages.get('waiting')).toEqual({ name: 'waiting-for-checks', startedAt: 3_000 });
    expect(stages.has(working.id)).toBe(false);

    // A restart reads the same rows: the times come from the database, not from memory.
    expect(read(new PlanQueueStore(db, () => 99_000))).toEqual(stages);
  });

  it('reads history only for items in a state that can have a stage', () => {
    const stageMarks = vi.fn(() => new Map());
    itemStages({ stageMarks }, [item({ id: 'landed', state: 'landed' }), item({ id: 'waiting', state: 'awaiting-slot' })], 0);
    expect(stageMarks).toHaveBeenCalledWith(['waiting']);
  });

  it('reads nothing when no item has a stage', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    expect(new PlanQueueStore(db).history.stageMarks([])).toEqual(new Map());
  });
});

describe('PlanQueueCoordinator run DTOs', () => {
  afterEach(() => PlanQueueCoordinator._resetForTesting());

  it('sends each item\'s stage to the renderer, ending landing turns from before this app session', () => {
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    let now = 1_000;
    const store = new PlanQueueStore(db, () => now);
    store.upsertRun(RUN);
    store.upsertItem(newPlanQueueItem('checking', 'run', '/repo/a_plan.md', 1, { state: 'verifying', detail: 'Running checks' }));
    const before = newPlanQueueItem('before', 'run', '/repo/b_plan.md', 1, { state: 'landing' });
    store.upsertItem(before);
    now = 1_500; recordTiming(store.history, before, TIMING_REASONS.landingStart, {});
    store.upsertItem(newPlanQueueItem('working', 'run', '/repo/c_plan.md', 1, { state: 'working' }));
    const parent: PlanQueueInstanceRecord = { id: 'parent', status: 'idle', outputBuffer: [] };
    const instances = Object.assign(new EventEmitter(), {
      getInstance: (id: string) => id === 'parent' ? parent : undefined, getAllInstances: () => [parent],
      createInstance: vi.fn(), sendInput: vi.fn(), terminateInstance: vi.fn(), restartFreshInstance: vi.fn(), adoptOrphanInstance: () => false,
    });
    // The app restarts: a landing turn recorded before now died with the previous session.
    now = 5_000;
    const coordinator = PlanQueueCoordinator.getInstance();
    coordinator.initialize({ store, instances, skipInstall: true, pumpIntervalMs: null, loadAverage: () => [0, 0, 0], now: () => now,
      worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] },
      selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
      routing: { readSaved: () => ({ workers: [], verifiers: [] }), routeUsage: async () => ({ usable: true, resumeAt: null }), readAccountRules: () => ({ never: [], last: [] }),
        copilotProfileFor: () => null, poolProfiles: () => [], copilotProfiles: () => [], defaultProvider: () => null, checkerScopeKind: () => 'none',
        isProviderExcluded: () => false, listInstalledProviders: async () => ['claude', 'codex'] },
    } as unknown as Parameters<PlanQueueCoordinator['initialize']>[0]);

    const stagesOf = (items: { id: string; stage?: unknown }[]) => Object.fromEntries(items.map(entry => [entry.id, entry.stage]));
    const expected = { checking: { name: 'checks', startedAt: 1_000 }, before: { name: 'waiting-to-land', startedAt: 1_000 }, working: undefined };
    expect(stagesOf(coordinator.getRunDto('run')!.items)).toEqual(expected);
    expect(stagesOf(coordinator.listRunDtos(5)[0].items)).toEqual(expected);
    // Its turn starts again in this session.
    now = 6_000; recordTiming(store.history, before, TIMING_REASONS.landingStart, {});
    expect(coordinator.getRunDto('run')!.items.find(entry => entry.id === 'before')!.stage).toEqual({ name: 'landing', startedAt: 6_000 });
  });
});

let repo: string | undefined;
let restoreSpawns: (() => void) | undefined;
let fixtures: ProcessFixtureRegistry | undefined;
let flow: PlanQueueItemFlow | undefined;
const git = (args: string[], cwd = repo!): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

afterEach(async () => {
  try {
    await fixtures?.cleanup();
    await flow?.whenSettled();
  } finally {
    restoreSpawns?.();
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined; flow = undefined; fixtures = undefined; restoreSpawns = undefined;
    GitWriteQueue._resetForTesting();
  }
});

describe.skipIf(process.platform === 'win32')('landing turns', () => {
  it('marks the landing job when its turn starts and keeps the next one waiting', { timeout: 30_000 }, async () => {
    GitWriteQueue._resetForTesting();
    fixtures = new ProcessFixtureRegistry();
    restoreSpawns = captureFixtureSpawns(fixtures);
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-stage-landing-')));
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.name', 'Queue Test']);
    git(['config', 'user.email', 'queue@example.invalid']);
    git(['config', 'commit.gpgsign', 'false']);
    mkdirSync(join(repo, '.git', 'test-hooks'));
    git(['config', 'core.hooksPath', join(repo, '.git', 'test-hooks')]);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    git(['add', 'a.txt']); git(['commit', '-qm', 'base']);
    const base = git(['rev-parse', 'HEAD']);
    const worktree = join(repo, 'wt');
    git(['worktree', 'add', '-qb', 'queue/item', worktree, 'main']);
    writeFileSync(join(worktree, 'a.txt'), 'worker\n');
    git(['add', 'a.txt'], worktree); git(['commit', '--no-verify', '-qm', 'work'], worktree);
    // The repository's commit check holds the first landing open, as a long pre-commit run does.
    const pidFile = join(repo, '.git', 'waiting.pid');
    fixtures.trackPidFile(pidFile);
    const hook = join(repo, '.git', 'test-hooks', 'pre-commit');
    writeFileSync(hook, `#!/bin/sh\nsleep 60 &\necho $! > "${pidFile}"\nwait\n`); chmodSync(hook, 0o755);

    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    const run: PlanQueueRun = { ...RUN, workspaceCwd: repo, config: { ...RUN.config, baseBranch: 'main', postMergeGate: [] } };
    store.upsertRun(run);
    const landingItem = (id: string) => newPlanQueueItem(id, 'run', join(repo!, `${id}_plan.md`), 1, {
      state: 'landing', worktreePath: worktree, branchName: 'queue/item', baseCommit: base,
      checkpointCommit: git(['rev-parse', 'HEAD'], worktree), verifiedMainCommit: base, round: 1,
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: false, needJames: [] },
    });
    store.upsertItem(landingItem('first'));
    store.upsertItem(landingItem('second'));
    const announced: string[] = [];
    const save = (next: PlanQueueItem) => { store.upsertItem(next); announced.push(next.id); return next; };
    const host = {
      store, history: store.history, getRun: () => run, getItem: (id: string) => store.getItem(id)!, save,
      worktrees: {
        // Written straight to the store so `announced` counts only the landing's own saves.
        checkpoint: async (next: PlanQueueItem) => {
          const saved = { ...next, checkpointCommit: git(['rev-parse', 'HEAD'], worktree) };
          store.upsertItem(saved); return saved;
        },
        preflightPlanningFiles: async () => ({ moved: [], beside: [], failed: [] }),
        removeWithProof: async () => ({ removed: false, reason: 'retained', detail: 'test keeps worktree' }),
      },
      transition: (next: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => {
        assertItemTransition(next.state, state); return save({ ...next, ...patch, state });
      },
      requestPump: () => undefined,
      tracker: { untrack: () => undefined },
      unregisterRole: () => undefined,
      instances: { getInstance: () => undefined, terminateInstance: async () => undefined },
    } as unknown as PlanQueueFlowHost;
    flow = new PlanQueueItemFlow(host);
    const sessionStartedAt = Date.now();
    const first = flow.enqueueLanding('first');
    const second = flow.enqueueLanding('second');
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 10_000 });
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());

    const stages = itemStages(store.history, store.listItems('run'), sessionStartedAt);
    expect(stages.get('first')).toEqual({ name: 'landing', startedAt: expect.any(Number) });
    expect(stages.get('first')!.startedAt).toBeGreaterThanOrEqual(sessionStartedAt);
    expect(stages.get('second')).toEqual({ name: 'waiting-to-land', startedAt: expect.any(Number) });
    // The turn's start was announced, so the session list learns of it without waiting for another change.
    expect(announced).toEqual(['first']);
    expect(store.history.listEvents('first')).not.toContainEqual(expect.objectContaining({ reason: TIMING_REASONS.landingStart }));

    run.status = 'paused';
    await Promise.all([flow.hold('first'), flow.hold('second'), first, second]);
    await waitForFixtureProcessExit(childPid);
    // A paused landing never starts a turn, so it records none.
    const turns = db.prepare(`SELECT item_id FROM plan_queue_item_events WHERE reason = ?`).all<{ item_id: string }>(TIMING_REASONS.landingStart);
    expect(turns.map(row => row.item_id)).toEqual(['first']);
  });
});
