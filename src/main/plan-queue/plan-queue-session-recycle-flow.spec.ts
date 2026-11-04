import { EventEmitter } from 'node:events';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueHistoryStore } from './plan-queue-history-store';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueFlowHost, PlanQueueInstanceRecord } from './plan-queue-host';
import { PlanQueueInstanceTracker } from './plan-queue-instance-tracker';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueRun } from './plan-queue.types';

let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
afterEach(() => db?.close());
const unused = (): never => { throw new Error('Unexpected queue port during same-owner continuation'); };

describe('queue continuation after Copilot compaction', () => {
  it('restarts the provider before the next turn, reanchors the task, and keeps job, branch and owner', async () => {
    const source = Object.assign(new EventEmitter(), { getInstance: () => worker });
    const worker: PlanQueueInstanceRecord = { id: 'owner', provider: 'copilot', status: 'idle',
      providerSessionId: 'old-provider-session', historyThreadId: 'history', workingDirectory: '/synthetic/item-worktree',
      outputBuffer: [{ type: 'assistant', content: 'Earlier work' }],
      contextUsage: { copilotUsage: { compactions: 1, postCompactionTokens: 950, tokenLimit: 1000 } } };
    const outcomes: unknown[] = [];
    const tracker = new PlanQueueInstanceTracker(source, (_id, outcome) => outcomes.push(outcome));
    tracker.attach(); tracker.beginTurn('owner');
    let item = newPlanQueueItem('job', 'run', '/synthetic/project/example_plan.md', 1, {
      state: 'working', branchName: 'queue/example', worktreePath: '/synthetic/item-worktree', workerInstanceId: 'owner',
      question: { question: 'Continue?', options: [{ id: 'continue', label: 'Continue' }] },
    });
    const run: PlanQueueRun = { id: 'run', workspaceCwd: '/synthetic/project', kind: 'plans', status: 'running',
      config: DEFAULT_PLAN_QUEUE_CONFIG.plans, parentInstanceId: 'parent', parentHistoryThreadId: null,
      relaxation: null, workerProvider: 'copilot', workerModel: null, startedAt: 1, endedAt: null };
    const operations: string[] = [];
    let sent = '';
    db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
    const history = new PlanQueueHistoryStore(db);
    const host: PlanQueueFlowHost = {
      history,
      worktrees: new PlanQueueWorktreeService({ repoRootForItem: () => run.workspaceCwd, history, saveItem: next => { item = next; },
        creator: { createWorktree: unused, cleanupWorktree: unused, getAllSessions: unused } }),
      checksAdmitted: unused, pauseForSharedError: unused, selectVerifier: unused,
      transition: unused, unregisterRole: unused, roleOf: unused, notifyParent: unused,
      liveParentId: unused, resolveRunParent: unused, requestPump: unused,
      getRun: () => run, getItem: () => item, save: next => (item = next), tracker,
      instances: {
        getInstance: id => id === worker.id ? worker : undefined,
        getAllInstances: unused, terminateInstance: unused,
        restartFreshInstance: async id => {
          operations.push(`restart:${id}`);
          source.emit('provider:normalized-event', { instanceId: id, event: { kind: 'exit', code: null, signal: 'SIGTERM' } });
          worker.providerSessionId = 'fresh-provider-session';
          worker.contextUsage = { copilotUsage: { compactions: 0 } };
          return 'archive';
        },
        sendInput: async (id, message) => { operations.push(`send:${id}`); sent = message; },
        createInstance: async () => { throw new Error('must keep existing owner'); },
      },
      registerRole: () => undefined,
    };
    await new PlanQueueItemFlow(host).answerWorker('job', 'continue');
    expect(operations).toEqual(['restart:owner', 'send:owner']);
    expect(outcomes).toEqual([]);
    expect(tracker.isTracked('owner')).toBe(true);
    expect(sent).toContain('example_plan.md');
    expect(sent).toContain('James says: carry on using your best judgement.');
    expect(item).toMatchObject({ id: 'job', state: 'working', branchName: 'queue/example', workerInstanceId: 'owner', pendingInstruction: null,
      workerSession: { providerSessionId: 'fresh-provider-session' } });
    expect(worker.outputBuffer).toEqual([{ type: 'assistant', content: 'Earlier work' }]);
  });
});
