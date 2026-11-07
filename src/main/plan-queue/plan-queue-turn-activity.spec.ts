import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, PlanQueueItemDtoSchema } from '@contracts/schemas/plan-queue';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { runLoopMigrations, runLoopMigrationsUpTo } from '../orchestration/loop-schema';
import { PlanQueueHistoryStore } from './plan-queue-history-store';
import { PlanQueueInstanceTracker } from './plan-queue-instance-tracker';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { itemToDto } from './plan-queue-messages';
import { PlanQueueStore } from './plan-queue-store';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const run: PlanQueueRun = {
  id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: '/fixture',
  status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
  workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null,
};
const item: PlanQueueItem = {
  id: 'item', runId: run.id, documentPath: '/fixture/a_plan.md', state: 'working', round: 0,
  erroredRounds: 0, landingRefusals: 0, baseConflicts: 0, branchName: null, worktreePath: null, baseCommit: null,
  checkpointCommit: null, verifiedMainCommit: null, landedCommit: null, workerInstanceId: 'worker',
  verifierInstanceId: null, question: null, answer: null, parkReason: null, detail: null,
  verdict: null, createdAt: 1, updatedAt: 1,
};

describe('queue round activity persistence', () => {
  it('retains observed worker turns after reload without inventing activity for a restored transcript', async () => {
    const db = defaultDriverFactory(':memory:');
    try {
      runLoopMigrations(db);
      const store = new PlanQueueStore(db);
      store.upsertRun(run); store.upsertItem(item);
      let flow!: PlanQueueItemFlow;
      const source = new class extends EventEmitter {
        getInstance = () => ({ id: 'worker', status: 'busy' as const, outputBuffer: [] });
      }();
      const tracker = new PlanQueueInstanceTracker(source, (id, outcome) => { void flow.onWorkerOutcome(id, outcome); });
      const save = (next: PlanQueueItem) => { store.upsertItem(next); return store.getItem(next.id)!; };
      const worktrees = new PlanQueueWorktreeService({
        saveItem: save, repoRootForItem: () => '/fixture',
        creator: { createWorktree: async () => { throw new Error('No checkout may be created in this test'); },
          getAllSessions: () => [], cleanupWorktree: async () => undefined },
      });
      vi.spyOn(worktrees, 'checkpoint').mockImplementation(async next => next);
      const host: PlanQueueFlowHost = {
        store, history: new PlanQueueHistoryStore(db), checksAdmitted: () => true, setRunHold: () => undefined,
        livetestPortsInUse: () => [], tracker, worktrees, save, getItem: id => store.getItem(id)!, getRun: () => run,
        transition: (next, state, patch) => save({ ...next, ...patch, state }),
        roleOf: () => ({ role: 'worker', runId: run.id, itemId: item.id }),
        instances: { getInstance: source.getInstance, getAllInstances: () => [],
          createInstance: async () => { throw new Error('No worker may be spawned in this test'); },
          sendInput: async () => undefined, terminateInstance: async () => undefined,
          restartFreshInstance: async () => undefined },
        registerRole: () => undefined, unregisterRole: () => undefined, notifyParent: () => undefined,
        liveParentId: () => undefined, resolveRunParent: () => undefined, requestPump: () => undefined,
        selectVerifier: async () => { throw new Error('No verifier may start in this test'); },
      };
      flow = new PlanQueueItemFlow(host);
      tracker.attach(); tracker.track('worker');
      const emit = (event: Record<string, unknown>) => source.emit('provider:normalized-event', { instanceId: 'worker', event });
      emit({ kind: 'output', messageType: 'assistant', content: 'Checking.' });
      emit({ kind: 'complete' });
      await flow.whenSettled();
      expect(PlanQueueItemDtoSchema.parse(itemToDto(new PlanQueueStore(db).getItem(item.id)!, undefined))).toMatchObject({
        roundActivity: [{ round: 1, toolCalls: 0, outputCharacters: 9, statusOnlyTurns: 1 }],
      });
      save({ ...store.getItem(item.id)!, state: 'fixing', round: 1 });
      tracker.beginTurn('worker');
      emit({ kind: 'tool_use', toolUseId: 'read' });
      emit({ kind: 'output', messageType: 'assistant', content: 'Read.' });
      emit({ kind: 'complete' }); emit({ kind: 'complete' });
      await flow.whenSettled();
      expect(itemToDto(new PlanQueueStore(db).getItem(item.id)!, undefined)).toMatchObject({ roundActivity: [
        { round: 1, toolCalls: 0, outputCharacters: 9, statusOnlyTurns: 1 },
        { round: 2, toolCalls: 1, outputCharacters: 5, statusOnlyTurns: 0 },
      ] });
      save({ ...store.getItem(item.id)!, state: 'working' });
      tracker.beginTurn('worker');
      await flow.onWorkerOutcome('worker', { kind: 'turn-complete', lastAssistantOutput: 'Old transcript' });
      expect(itemToDto(new PlanQueueStore(db).getItem(item.id)!, undefined)).toMatchObject({ roundActivity: [
        { statusOnlyTurns: 1 }, { statusOnlyTurns: 0 },
      ] });
    } finally { db.close(); }
  });

  it('upgrades existing items without fabricating historical turn measurements', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      runLoopMigrationsUpTo(db, 30);
      // Exercise the old schema directly, before the new store's columns exist.
      db.prepare('INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(run.id, 'parent', 'plans', '/fixture', 'running', JSON.stringify(run.config), 1, 1);
      db.prepare('INSERT INTO plan_queue_items (id,run_id,document_path,state,created_at,updated_at) VALUES (?,?,?,?,?,?)')
        .run(item.id, run.id, item.documentPath, 'working', 1, 1);
      runLoopMigrations(db); runLoopMigrations(db);
      expect(itemToDto(new PlanQueueStore(db).getItem(item.id)!, undefined)).toMatchObject({ roundActivity: [] });
    } finally { db.close(); }
  });

  it('adopts a round_activity_json column an earlier build already added', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      runLoopMigrationsUpTo(db, 52);
      db.exec('ALTER TABLE plan_queue_items ADD COLUMN round_activity_json TEXT');
      expect(() => runLoopMigrations(db)).not.toThrow();
      expect(db.prepare('SELECT name FROM loop_migrations WHERE version = 53').get<{ name: string }>()?.name)
        .toBe('053_plan_queue_round_activity');
    } finally { db.close(); }
  });

  it('treats a damaged round activity record as no activity instead of failing the read', () => {
    const db = defaultDriverFactory(':memory:');
    try {
      runLoopMigrations(db);
      const store = new PlanQueueStore(db);
      store.upsertRun(run); store.upsertItem(item);
      db.prepare('UPDATE plan_queue_items SET round_activity_json = ? WHERE id = ?').run('{not json', item.id);
      expect(store.getItem(item.id)?.roundActivity).toEqual([]);
      db.prepare('UPDATE plan_queue_items SET round_activity_json = ? WHERE id = ?').run('[{"round":"x"}]', item.id);
      expect(store.getItem(item.id)?.roundActivity).toEqual([]);
    } finally { db.close(); }
  });
});
