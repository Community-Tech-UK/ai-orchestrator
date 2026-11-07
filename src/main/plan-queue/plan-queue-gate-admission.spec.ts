import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { limitsFor } from '../work-admission/workload-policy';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { pumpPlanQueue } from './plan-queue-pump';
import { newPlanQueueItem } from './plan-queue-state';
import type { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

beforeEach(() => {
  const admission = getWorkAdmission();
  // Test slot policy independently of other work on the shared test machine.
  vi.spyOn(admission, 'getLimits').mockImplementation(() => ({ ...limitsFor(admission.getWorkloadLevel(), 8), loadPerCore: null }));
});
afterEach(() => { vi.restoreAllMocks(); WorkAdmission._resetForTesting(); });

function fixture(groups: { folder: string; slots: number; jobs: number }[]) {
  const runs: PlanQueueRun[] = groups.map((group, index) => ({
    id: `run-${index}`, parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
    workspaceCwd: group.folder, status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, verificationSlots: group.slots, verifierGates: ['check'] },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: index, endedAt: null,
  }));
  const items = runs.flatMap((run, index) => Array.from({ length: groups[index].jobs }, (_, job) =>
    newPlanQueueItem(`${run.id}-${job}`, run.id, `${run.workspaceCwd}/work_plan.md`, job,
      { state: 'awaiting-slot', worktreePath: `/items/${run.id}-${job}` })));
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started: string[] = [];
  const finished: string[] = [];
  const pending: Promise<void>[] = [];
  const checklistTurns = new Set<string>();
  const runner = new PlanQueueGateRunner(async (_command, cwd) => {
    started.push(cwd);
    await held;
    return { exitCode: 0, output: '' };
  }, () => 'admission-test-tree');
  const host: Parameters<typeof pumpPlanQueue>[0] = {
    store: { listActiveRuns: () => runs, listItems: (id: string) => items.filter(item => item.runId === id), listItemsWithKeptFolders: () => [], waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, waitingSince: () => undefined } } as unknown as PlanQueueStore,
    flow: {
      startItem: async () => { throw new Error('Only checks are expected'); },
      startVerification: (item: PlanQueueItem) => {
        // Match the flow: the slot is reserved synchronously and held through the checker, the turn only while commands run.
        item.state = 'verifying';
        checklistTurns.add(item.id);
        const result = runner.run({ cwd: item.worktreePath!, head: item.id, commands: ['check'] }).then(() => {
          checklistTurns.delete(item.id);
          item.verifierInstanceId = `checker-${item.id}`;
          finished.push(item.id);
        });
        pending.push(result);
        return result;
      },
      isWaitingForUsage: () => false, isClaimed: () => false, recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined } as never, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns, finishLandingCleanup: async () => undefined,
    },
    triage: null, getRun: id => runs.find(run => run.id === id)!, getItem: id => items.find(item => item.id === id)!,
    transition: (item, state, patch) => Object.assign(item, patch, { state }),
    notifyParent: () => undefined, resolveRunParent: () => 'parent',
    loadAverage: () => [0, 0, 0], followParent: run => run,
    isShuttingDown: () => false, isControlling: () => false,
    finishRun: () => { throw new Error('Checks are still active'); },
    logItemError: (_item, error) => { throw error; }, announceRun: () => undefined,
  };
  return { host, runs, items, started, finished,
    flush: () => new Promise<void>(resolve => setImmediate(resolve)),
    close: async () => { release(); await Promise.all(pending); },
  };
}

describe('gate sets occupy the pump check slots', () => {
  it('runs one gate set at a time across project folders, and gives the turn up when its commands end', async () => {
    const f = fixture([{ folder: '/a', slots: 1, jobs: 1 }, { folder: '/b', slots: 1, jobs: 1 }]);
    try {
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0']);
      expect(f.finished).toEqual([]);
      await f.close();
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0', '/items/run-1-0']);
      expect(f.items[0].state).toBe('verifying');
    } finally { await f.close(); }
  });

  it('reviews two jobs in one folder with two check slots, holding the slots through review', async () => {
    const f = fixture([{ folder: '/a', slots: 2, jobs: 3 }]);
    try {
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0']);
      await f.close();
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0', '/items/run-0-1']);
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.items.map(item => item.state)).toEqual(['verifying', 'verifying', 'awaiting-slot']);
      expect(f.started).toHaveLength(2);
      Object.assign(f.items[0], { state: 'landed', verifierInstanceId: null });
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toHaveLength(3);
    } finally { await f.close(); }
  });

  it('shares a folder cap across runs without limiting a different folder', async () => {
    const f = fixture([{ folder: '/a', slots: 1, jobs: 1 }, { folder: '/a', slots: 1, jobs: 1 }, { folder: '/b', slots: 1, jobs: 1 }]);
    try {
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0']);
      await f.close();
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0', '/items/run-2-0']);
      expect(f.items[1].state).toBe('awaiting-slot');
    } finally { await f.close(); }
  });

  it.each([1, 2] as const)('limits gates to one across the machine at workload level %s', async level => {
    getWorkAdmission().setWorkloadLevel(level);
    const f = fixture([{ folder: '/a', slots: 2, jobs: 2 }, { folder: '/b', slots: 2, jobs: 1 }]);
    try {
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0']);
      await f.close();
      f.items[0].state = 'landed';
      await pumpPlanQueue(f.host); await f.flush();
      // run-1-0 has waited longer than run-0-1, so it goes next even though its run is newer.
      expect(f.started).toEqual(['/items/run-0-0', '/items/run-1-0']);
    } finally { await f.close(); }
  });

  it('counts a paused run check against the machine cap', async () => {
    getWorkAdmission().setWorkloadLevel(1);
    const f = fixture([{ folder: '/a', slots: 2, jobs: 1 }, { folder: '/b', slots: 2, jobs: 1 }]);
    f.runs[0].status = 'paused'; f.items[0].state = 'verifying';
    try {
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual([]);
    } finally { await f.close(); }
  });

  it('keeps gates behind Hold, paused runs and the load gate', async () => {
    const f = fixture([{ folder: '/a', slots: 1, jobs: 1 }]);
    try {
      getWorkAdmission().setGlobalPhase('holding');
      await pumpPlanQueue(f.host);
      getWorkAdmission().setGlobalPhase('none');
      f.runs[0].status = 'paused'; await pumpPlanQueue(f.host);
      f.runs[0].status = 'running';
      f.host.loadAverage = () => [0, f.runs[0].config.maxLoadAverage + 1, 0];
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual([]);
      f.host.loadAverage = () => [0, 0, 0];
      await pumpPlanQueue(f.host); await f.flush();
      expect(f.started).toEqual(['/items/run-0-0']);
    } finally { await f.close(); }
  });

  it('uses workload minimums without changing saved slot settings', async () => {
    getWorkAdmission().setWorkloadLevel(5);
    const f = fixture([{ folder: '/a', slots: 1, jobs: 4 }]);
    try {
      await f.close();
      for (let pass = 0; pass < 4; pass += 1) { await pumpPlanQueue(f.host); await f.flush(); await Promise.resolve(); }
      expect(f.items.filter(item => item.state === 'verifying')).toHaveLength(4);
      expect(f.runs[0].config.verificationSlots).toBe(1);
    } finally { await f.close(); }
  });
});
