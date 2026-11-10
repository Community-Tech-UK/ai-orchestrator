import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueItemState } from '@contracts/schemas/plan-queue';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import { PlanQueueStore } from './plan-queue-store';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { PlanQueueSlotWaits } from './plan-queue-timings';

// Work admission reads the real load average on the light levels; keep this Mac's load out of the result.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
beforeAll(() => initSqliteWasm());
afterEach(() => WorkAdmission._resetForTesting());
describe('Plan Queue admission wiring', () => {
  it('keeps workers, checks and triage waiting during Hold and starts them on Release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-admission-'));
    try {
      const document = join(root, 'work_plan.md'); writeFileSync(document, '# Work');
      const run: PlanQueueRun = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null,
        kind: 'plans', workspaceCwd: root, status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans,
        relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
      const worker = newPlanQueueItem('worker', 'run', document, 1, { state: 'queued' });
      const check = newPlanQueueItem('check', 'run', document, 2, { state: 'awaiting-slot' });
      const items = [worker, check];
      const starts: string[] = [];
      const host: Parameters<typeof pumpPlanQueue>[0] = {
        store: { listActiveRuns: () => [run], listAutomaticLandingsInEndedRuns: () => [], listItems: () => items, listItemsWithKeptFolders: () => [], waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } } as unknown as PlanQueueStore,
        flow: { startItem: async item => { starts.push(item.id); }, startVerification: async item => { starts.push(item.id); }, isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
        triage: { isStopping: () => false, maybeStart: () => { starts.push('triage'); } },
        getRun: () => run, getItem: id => items.find(item => item.id === id)!,
        transition: (item, state, patch) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('The active run must not finish'); },
        logItemError: (_item, error) => { throw error; }, announceRun: () => undefined,
      };
      getWorkAdmission().setGlobalPhase('holding');
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
      expect(items.map(item => item.state)).toEqual(['queued', 'awaiting-slot']);
      getWorkAdmission().setGlobalPhase('none');
      await pumpPlanQueue(host);
      expect(starts).toEqual(['triage', 'worker', 'check']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  describe('one checklist at a time', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    function pumpOf(runs: PlanQueueRun[], items: ReturnType<typeof newPlanQueueItem>[], turns: Set<string>) {
      const starts: string[] = [];
      const host = {
        store: { listActiveRuns: () => runs, listAutomaticLandingsInEndedRuns: () => [], listItems: (id: string) => items.filter(item => item.runId === id), listItemsWithKeptFolders: () => [],
          listFoldersWithDiscardedItems: () => [], waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } },
        flow: { startItem: async () => undefined, isWaitingForUsage: () => false, isClaimed: () => false, keptFolders: { retryDue: () => undefined },
          breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: turns,
          startVerification: async (item: { id: string; runId: string }) => {
            starts.push(item.id);
            if (runs.find(run => run.id === item.runId)!.config.verifierGates.length) turns.add(item.id);
          } },
        triage: null, getRun: (id: string) => runs.find(run => run.id === id)!, getItem: (id: string) => items.find(item => item.id === id)!,
        transition: (item: object, state: string, patch: object) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: (value: PlanQueueRun) => value,
        isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined,
        logItemError: (_item: unknown, error: unknown) => { throw error; }, announceRun: () => undefined,
      } as unknown as Parameters<typeof pumpPlanQueue>[0];
      return { host, starts };
    }
    function runIn(id: string, gates: string[], startedAt: number) {
      const root = mkdtempSync(join(tmpdir(), `queue-turn-${id}-`)); roots.push(root);
      const document = join(root, 'work_plan.md'); writeFileSync(document, '# Work');
      const run: PlanQueueRun = { id, parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: 'running',
        config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verifierGates: gates }, relaxation: null, workerProvider: null, workerModel: null, startedAt, endedAt: null };
      return { run, document };
    }

    it('starts one across all folders, and the next only when the turn is free', async () => {
      const a = runIn('a', ['check'], 1);
      const b = runIn('b', ['check'], 2);
      const items = [newPlanQueueItem('first', 'a', a.document, 1, { state: 'awaiting-slot' }), newPlanQueueItem('second', 'b', b.document, 2, { state: 'awaiting-slot' })];
      const turns = new Set<string>();
      const { host, starts } = pumpOf([a.run, b.run], items, turns);
      await pumpPlanQueue(host);
      expect(starts).toEqual(['first']);
      items[0].state = 'verifying';
      await pumpPlanQueue(host);
      expect(starts).toEqual(['first']);
      turns.clear();
      await pumpPlanQueue(host);
      expect(starts).toEqual(['first', 'second']);
    });

    it('gives the turn to the job that has waited longest, not to the oldest run', async () => {
      const older = runIn('older', ['check'], 1);
      const newer = runIn('newer', ['check'], 2);
      const items = [newPlanQueueItem('fresh', 'older', older.document, 1, { state: 'awaiting-slot', updatedAt: 900 }),
        newPlanQueueItem('patient', 'newer', newer.document, 2, { state: 'awaiting-slot', updatedAt: 100 })];
      const { host, starts } = pumpOf([older.run, newer.run], items, new Set());
      await pumpPlanQueue(host);
      expect(starts).toEqual(['patient']);
    });

    it('goes by how long a job has really waited, because routine saves move its last-updated time', async () => {
      const a = runIn('a', ['check'], 1);
      const items = [newPlanQueueItem('bumped', 'a', a.document, 1, { state: 'awaiting-slot', updatedAt: 900 }),
        newPlanQueueItem('later', 'a', a.document, 2, { state: 'awaiting-slot', updatedAt: 500 })];
      const { host, starts } = pumpOf([a.run], items, new Set());
      (host.store.waits as unknown as { waitingSince: (id: string) => number | undefined }).waitingSince = id => id === 'bumped' ? 100 : undefined;
      await pumpPlanQueue(host);
      expect(starts).toEqual(['bumped']);
    });

    it('leaves a run alone when a Pause or Cancel began while the pass was running', async () => {
      const a = runIn('a', ['check'], 1);
      const items = [newPlanQueueItem('one', 'a', a.document, 1, { state: 'awaiting-slot' })];
      const { host, starts } = pumpOf([a.run], items, new Set());
      let asked = 0;
      host.isControlling = () => { asked += 1; return asked > 1; };
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
    });

    it('lets a run with no checklist start while a turn is held', async () => {
      const gated = runIn('gated', ['check'], 1);
      const plain = runIn('plain', [], 2);
      const items = [newPlanQueueItem('waits', 'gated', gated.document, 1, { state: 'awaiting-slot' }), newPlanQueueItem('free', 'plain', plain.document, 2, { state: 'awaiting-slot' })];
      const { host, starts } = pumpOf([gated.run, plain.run], items, new Set(['someone-else']));
      await pumpPlanQueue(host);
      expect(starts).toEqual(['free']);
    });

    it('starts nothing on a held run, including triage, until a trial is due, and then only one', async () => {
      const a = runIn('a', [], 1);
      a.run.holdReason = 'No new work is starting';
      const items = [newPlanQueueItem('queued-1', 'a', a.document, 1, { state: 'queued' }), newPlanQueueItem('queued-2', 'a', a.document, 2, { state: 'queued' }),
        newPlanQueueItem('check-1', 'a', a.document, 3, { state: 'awaiting-slot' })];
      const { host, starts } = pumpOf([a.run], items, new Set());
      let trials = 0;
      const started = vi.fn();
      Object.assign(host.flow, { startItem: async (item: { id: string }) => { starts.push(item.id); },
        breaker: { canStart: () => trials > 0, started: () => { trials -= 1; started(); } } });
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
      trials = 1;
      await pumpPlanQueue(host);
      expect(starts).toHaveLength(1);
      expect(started).toHaveBeenCalledTimes(1);
    });

    it('starts no triage on a held run until a trial is due, because triage is how the October outage spread', async () => {
      const a = runIn('a', [], 1);
      a.run.holdReason = 'No new work is starting';
      const items = [newPlanQueueItem('undecided', 'a', a.document, 1, { state: 'discovered' })];
      const { host } = pumpOf([a.run], items, new Set());
      const maybeStart = vi.fn();
      let due = false;
      Object.assign(host, { triage: { isStopping: () => false, maybeStart } });
      Object.assign(host.flow, { breaker: { canStart: () => due, started: () => undefined } });
      await pumpPlanQueue(host);
      expect(maybeStart).not.toHaveBeenCalled();
      due = true;
      await pumpPlanQueue(host);
      expect(maybeStart).toHaveBeenCalledTimes(1);
    });

    it('applies at the highest workload too', async () => {
      getWorkAdmission().setWorkloadLevel(5);
      const a = runIn('a', ['check'], 1);
      const items = [newPlanQueueItem('one', 'a', a.document, 1, { state: 'awaiting-slot' }), newPlanQueueItem('two', 'a', a.document, 2, { state: 'awaiting-slot' })];
      const { host, starts } = pumpOf([a.run], items, new Set());
      await pumpPlanQueue(host);
      expect(starts).toEqual(['one']);
    });
  });

  describe('work folders across runs', () => {
    const roots: string[] = [];
    afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
    type Row = PlanQueueItemState | `held ${PlanQueueItemState}`;
    // `landing waiting` is a landing that waits for uncommitted edits in the main folder.
    function setUp(limit: number, layout: Record<string, (Row | 'landing waiting')[]>, options: { paused?: string[]; endedLandings?: number; waits?: PlanQueueSlotWaits } = {}) {
      const runs: PlanQueueRun[] = Object.keys(layout).map((id, index) => {
        const root = mkdtempSync(join(tmpdir(), `queue-folders-${id}-`)); roots.push(root);
        return { id, parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: options.paused?.includes(id) ? 'paused' : 'running',
          config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, workerSlots: 8 }, relaxation: null, workerProvider: null, workerModel: null, startedAt: index, endedAt: null };
      });
      const items = runs.flatMap(run => layout[run.id].map((row, n) => {
        const document = join(run.workspaceCwd, `${n}_plan.md`); writeFileSync(document, '# Work');
        const state = row.replace('held ', '').replace(' waiting', '') as PlanQueueItemState;
        // A paused run holds its jobs: as queued rows, or as awaiting-slot once their work was done.
        return newPlanQueueItem(`${run.id}-${n}`, run.id, document, n,
          { state, heldAt: row.startsWith('held ') ? 1 : null, landingWaitPaths: row === 'landing waiting' ? ['src/a.ts'] : [] });
      }));
      const starts: string[] = [];
      const waits = new Map<string, string>();
      const host = {
        store: { listActiveRuns: () => runs, listAutomaticLandingsInEndedRuns: () => Array.from({ length: options.endedLandings ?? 0 }), listItems: (id: string) => items.filter(item => item.runId === id),
          listItemsWithKeptFolders: () => [], listFoldersWithDiscardedItems: () => [],
          waits: options.waits ?? { blocked: () => undefined, explain: (id: string, why: string) => { waits.set(id, why); return false; }, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } },
        // As in the real flow, a held job keeps `heldAt` until its session spawns, minutes after it starts.
        flow: { startItem: async (item: { id: string }) => { starts.push(item.id); Object.assign(items.find(row => row.id === item.id)!, { state: 'preparing' }); },
          startVerification: async (item: { id: string }) => { starts.push(`check ${item.id}`); Object.assign(items.find(row => row.id === item.id)!, { state: 'verifying' }); },
          isWaitingForUsage: () => false, isClaimed: () => false,
          recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined },
          discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
        triage: null, getRun: (id: string) => runs.find(run => run.id === id)!, getItem: (id: string) => items.find(item => item.id === id)!,
        transition: (item: object, state: string, patch: object) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => limit,
        followParent: (value: PlanQueueRun) => value, isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined,
        logItemError: (_item: unknown, error: unknown) => { throw error; }, announceRun: () => undefined,
      } as unknown as Parameters<typeof pumpPlanQueue>[0];
      return { host, starts, items, waits, runs };
    }

    it('keeps two runs together within the limit, and a job that cannot start waits for a free folder', async () => {
      const { host, starts } = setUp(4, { a: ['working', 'verifying', 'queued', 'queued'], b: ['landing', 'queued', 'queued'] });
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2']);
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2']);
    });

    it('does not count folders kept by set-aside jobs or by a paused run, including paused jobs whose work was done', async () => {
      const { host, starts } = setUp(2, { a: ['parked', 'parked', 'parked', 'queued'], b: ['parked', 'queued'],
        held: ['held queued', 'held awaiting-slot', 'held awaiting-slot'] }, { paused: ['held'] });
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-3', 'b-1']);
    });

    it('starts a held job\'s checks only when a folder is free, and counts it from then on', async () => {
      const { host, starts, items, waits } = setUp(2, { a: ['working', 'held awaiting-slot', 'queued'] });
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2']);
      expect(waits.get('a-1')).toBe('no-free-folder');
      items[0].state = 'landed';
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2', 'check a-1']);
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2', 'check a-1']);
    });

    it('counts a held job from the moment its checks start, so a later run in the same pass waits', async () => {
      const { host, starts, runs } = setUp(2, { a: ['working', 'held awaiting-slot'], b: ['queued'] });
      // Without a checklist its checks start in the run's own turn, before run b's workers (checklists go last).
      runs[0].config = { ...runs[0].config, verifierGates: [] };
      await pumpPlanQueue(host);
      expect(starts).toEqual(['check a-1']);
      await pumpPlanQueue(host); // still held while its checks run, and still counted
      expect(starts).toEqual(['check a-1']);
    });

    it('counts a held job that starts work again while it keeps its hold mark', async () => {
      const { host, starts } = setUp(2, { a: ['working', 'held queued'], b: ['queued'] });
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-1']);
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-1']);
    });

    it('does not count a landing waiting for edits in a paused run, but does in a running one', async () => {
      const paused = setUp(2, { held: ['landing waiting', 'landing waiting'], a: ['queued', 'queued'] }, { paused: ['held'] });
      await pumpPlanQueue(paused.host);
      expect(paused.starts).toEqual(['a-0', 'a-1']);
      const running = setUp(2, { busy: ['landing waiting', 'landing waiting'], a: ['queued'] });
      await pumpPlanQueue(running.host);
      expect(running.starts).toEqual([]);
    });

    it('times a wait after a pause from the release, not from before the pause', async () => {
      let now = 1_000;
      const slotWaits = new PlanQueueSlotWaits({ recordEvent: () => undefined } as never, () => now);
      const { host, runs } = setUp(1, { a: ['working', 'held awaiting-slot'] }, { waits: slotWaits });
      runs[0].config = { ...runs[0].config, verifierGates: [] };
      await pumpPlanQueue(host);
      expect([slotWaits.whyWaiting('a-1'), slotWaits.waitingSince('a-1')]).toEqual(['no-free-folder', 1_000]);
      now = 2_000; runs[0].status = 'paused';
      await pumpPlanQueue(host);
      expect([slotWaits.whyWaiting('a-1'), slotWaits.waitingSince('a-1')]).toEqual(['run-on-hold', undefined]);
      now = 90_000; runs[0].status = 'running';
      await pumpPlanQueue(host);
      expect([slotWaits.whyWaiting('a-1'), slotWaits.waitingSince('a-1')]).toEqual(['no-free-folder', 90_000]);
    });

    it('restarts the wait clock in a paused run even while a finished job\'s clean-up is still pending', async () => {
      let now = 1_000;
      const slotWaits = new PlanQueueSlotWaits({ recordEvent: () => undefined } as never, () => now);
      const { host, items } = setUp(1, { held: ['landed', 'held awaiting-slot'] }, { paused: ['held'], waits: slotWaits });
      items[0].workerInstanceId = 'worker'; // a landed job whose session is not yet cleaned away
      slotWaits.blocked('held-1');
      now = 2_000;
      await pumpPlanQueue(host);
      expect(slotWaits.waitingSince('held-1')).toBeUndefined();
    });

    it('counts landings Harness retries by itself in runs that have ended', async () => {
      const { host, starts } = setUp(2, { a: ['working', 'queued'] }, { endedLandings: 1 });
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
    });

    it('sets no limit when the setting is 0', async () => {
      const { host, starts } = setUp(0, { a: ['working', 'working', 'queued'], b: ['working', 'queued'] }, { endedLandings: 3 });
      await pumpPlanQueue(host);
      expect(starts).toEqual(['a-2', 'b-1']);
    });
  });

  it('shares checks between runs in one project folder but never across folders', async () => {
    const roots = [mkdtempSync(join(tmpdir(), 'queue-folder-a-')), mkdtempSync(join(tmpdir(), 'queue-folder-b-'))];
    try {
      const config = { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verificationSlots: 1 };
      const runOf = (id: string, workspaceCwd: string): PlanQueueRun => ({ id, parentInstanceId: 'chat', parentHistoryThreadId: null,
        kind: 'plans', workspaceCwd, status: 'running', config, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null });
      const runs = [runOf('a1', roots[0]), runOf('a2', roots[0]), runOf('b', roots[1])];
      const items = runs.flatMap((run, index) => [1, 2].map((n) => {
        const document = join(run.workspaceCwd, `${run.id}-${n}_plan.md`); writeFileSync(document, '# Work');
        return newPlanQueueItem(`${run.id}-${n}`, run.id, document, index * 2 + n, { state: 'awaiting-slot' });
      }));
      const checks: string[] = [];
      const host: Parameters<typeof pumpPlanQueue>[0] = {
        store: { listActiveRuns: () => runs, listAutomaticLandingsInEndedRuns: () => [], listItems: (runId: string) => items.filter(item => item.runId === runId), listItemsWithKeptFolders: () => [], waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } } as unknown as PlanQueueStore,
        flow: { startItem: async () => undefined, startVerification: async item => { checks.push(item.id); }, isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
        triage: null,
        getRun: id => runs.find(run => run.id === id)!, getItem: id => items.find(item => item.id === id)!,
        transition: (item, state, patch) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('An active run must not finish'); },
        logItemError: (_item, error) => { throw error; }, announceRun: () => undefined,
      };
      await pumpPlanQueue(host);
      // Folder A's one check goes to its first run; folder B still gets its own.
      expect(checks).toEqual(['a1-1', 'b-1']);
      // On Lightest the machine-wide limit of one check still spans every folder.
      for (const item of items) Object.assign(item, { state: 'awaiting-slot' });
      checks.length = 0;
      getWorkAdmission().setWorkloadLevel(1);
      await pumpPlanQueue(host);
      expect(checks).toEqual(['a1-1']);
    } finally { for (const root of roots) rmSync(root, { recursive: true, force: true }); }
  });

  it('records how long a ready item waited for a slot, and how soon after one freed it started', async () => {
    const root = mkdtempSync(join(tmpdir(), 'queue-slot-wait-'));
    const db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    try {
      let clock = 1_000_000;
      const store = new PlanQueueStore(db, () => clock);
      const run: PlanQueueRun = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: root, status: 'running',
        config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, workerSlots: 1 }, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
      store.upsertRun(run);
      const documents = ['busy', 'next'].map(name => { const path = join(root, `${name}_plan.md`); writeFileSync(path, '# Work'); return path; });
      store.upsertItem(newPlanQueueItem('busy', 'run', documents[0], 1, { state: 'working' }));
      store.upsertItem(newPlanQueueItem('next', 'run', documents[1], 2, { state: 'queued' }));
      const starts: string[] = [];
      const host: Parameters<typeof pumpPlanQueue>[0] = {
        store,
        flow: { startItem: async item => { starts.push(item.id); store.upsertItem({ ...item, state: 'preparing' }); }, startVerification: async () => undefined,
          isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
        triage: null, getRun: () => run, getItem: id => store.getItem(id)!,
        transition: (item, state, patch) => store.getItem(item.id) ?? Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('The active run must not finish'); },
        logItemError: (_item, error) => { throw error; }, announceRun: () => undefined,
      };
      await pumpPlanQueue(host);
      expect(starts).toEqual([]);
      clock += 120_000; await pumpPlanQueue(host); // still blocked: the clock must not restart
      clock += 30_000; store.upsertItem({ ...store.getItem('busy')!, state: 'landed' }); // the slot frees
      clock += 10_000; await pumpPlanQueue(host);
      expect(starts).toEqual(['next']);
      const rows = db.prepare('SELECT item_id, detail_head FROM plan_queue_item_events WHERE reason = ?').all<{ item_id: string; detail_head: string }>('slot-wait');
      expect(rows.map(row => [row.item_id, JSON.parse(row.detail_head)])).toEqual([['next', { kind: 'worker', waitedMs: 160_000, freeToStartMs: 10_000 }]]);
    } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
