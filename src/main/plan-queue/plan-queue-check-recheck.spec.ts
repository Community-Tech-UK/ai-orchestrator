import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { queueAdmission } from '../work-admission/queue-admission';
import { PlanQueueCoordinator, type PlanQueueInstanceManagerPort } from './plan-queue-coordinator';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

let db: SqliteDriver;
let store: PlanQueueStore;
let coordinator: PlanQueueCoordinator;
let run: PlanQueueRun;
let load: number[];
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db); store = new PlanQueueStore(db);
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/repo',
    status: 'running', config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, maxLoadAverage: 1 },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  store.upsertRun(run); load = [0, 0, 0];
  coordinator = new PlanQueueCoordinator();
  const instances: PlanQueueInstanceManagerPort = Object.assign(new EventEmitter(), {
    createInstance: async () => { throw new Error('No session expected'); },
    sendInput: async () => undefined, terminateInstance: async () => undefined,
    restartFreshInstance: async () => undefined, getInstance: () => undefined,
    getAllInstances: () => [], adoptOrphanInstance: () => false,
  });
  coordinator.initialize({ store, instances,
    worktreeCreator: { getAllSessions: () => [], createWorktree: async () => { throw new Error('No checkout expected'); }, cleanupWorktree: async () => undefined },
    loadAverage: () => load, pumpIntervalMs: null });
});
afterEach(async () => {
  coordinator.shutdown(); await coordinator._whenSettledForTesting();
  db.close(); vi.restoreAllMocks(); WorkAdmission._resetForTesting();
});

it('rechecks Hold after the pump has reserved a check', () => {
  expect(coordinator.checksAdmitted(run)).toBe(true);
  getWorkAdmission().setGlobalPhase('holding');
  expect(coordinator.checksAdmitted(run)).toBe(false);
  getWorkAdmission().setGlobalPhase('none');
  expect(coordinator.checksAdmitted(run)).toBe(true);
});

it.each([0, 1])('rechecks the host load window %s before running gates', window => {
  load[window] = 2;
  expect(coordinator.checksAdmitted(run)).toBe(false);
});

it('uses the workload load minimum rather than rejecting an already admitted check', () => {
  getWorkAdmission().setWorkloadLevel(5);
  const threshold = queueAdmission(run.config, 0, 0).maxLoadAverage;
  expect(threshold).toBeGreaterThan(run.config.maxLoadAverage);
  load = [threshold, threshold, 0];
  expect(coordinator.checksAdmitted(run)).toBe(true);
  load[1]++;
  expect(coordinator.checksAdmitted(run)).toBe(false);
  expect(run.config.maxLoadAverage).toBe(1);
});

it.each(['paused', 'cancelled', 'completed'] as const)('does not start gates when the run is %s', status => {
  store.upsertRun({ ...run, status });
  expect(coordinator.checksAdmitted(run)).toBe(false);
});

it('does not start gates after shutdown', () => {
  coordinator.shutdown();
  expect(coordinator.checksAdmitted(run)).toBe(false);
});
