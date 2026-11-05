import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueRun } from './plan-queue.types';
import { PlanQueueStore } from './plan-queue-store';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

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
        store: { listActiveRuns: () => [run], listItems: () => items, listItemsWithKeptFolders: () => [], waits: { blocked: () => undefined, started: () => undefined, prune: () => undefined } } as unknown as PlanQueueStore,
        flow: { startItem: async item => { starts.push(item.id); }, startVerification: async item => { starts.push(item.id); }, isWaitingForUsage: () => false, isClaimed: () => false, keptFolders: { retryDue: () => undefined } },
        triage: { isStopping: () => false, maybeStart: () => { starts.push('triage'); } },
        getRun: () => run, getItem: id => items.find(item => item.id === id)!,
        transition: (item, state, patch) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('The active run must not finish'); },
        logItemError: (_item, error) => { throw error; },
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
        store: { listActiveRuns: () => runs, listItems: (runId: string) => items.filter(item => item.runId === runId), listItemsWithKeptFolders: () => [], waits: { blocked: () => undefined, started: () => undefined, prune: () => undefined } } as unknown as PlanQueueStore,
        flow: { startItem: async () => undefined, startVerification: async item => { checks.push(item.id); }, isWaitingForUsage: () => false, isClaimed: () => false, keptFolders: { retryDue: () => undefined } },
        triage: null,
        getRun: id => runs.find(run => run.id === id)!, getItem: id => items.find(item => item.id === id)!,
        transition: (item, state, patch) => Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('An active run must not finish'); },
        logItemError: (_item, error) => { throw error; },
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
          isWaitingForUsage: () => false, isClaimed: () => false, keptFolders: { retryDue: () => undefined } },
        triage: null, getRun: () => run, getItem: id => store.getItem(id)!,
        transition: (item, state, patch) => store.getItem(item.id) ?? Object.assign(item, patch, { state }),
        notifyParent: () => undefined, resolveRunParent: () => 'chat',
        loadAverage: () => [0, 0, 0], followParent: value => value,
        isShuttingDown: () => false, isControlling: () => false,
        finishRun: () => { throw new Error('The active run must not finish'); },
        logItemError: (_item, error) => { throw error; },
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
