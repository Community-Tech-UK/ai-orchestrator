import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';

let db: SqliteDriver;
beforeAll(() => initSqliteWasm());
afterEach(() => db?.close());

describe('queue round history', () => {
  it('keeps all verdicts across Resume and records path-free state events atomically', () => {
    db = createSqliteWasmDatabase(':memory:');
    runLoopMigrations(db);
    const store = new PlanQueueStore(db);
    store.upsertRun({ id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans',
      workspaceCwd: '/repo', status: 'running', config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null,
      workerProvider: 'claude', workerModel: null, startedAt: 1, endedAt: null });
    const item = newPlanQueueItem('item', 'run', '/repo/plan.md', 1);
    store.upsertItem(item);
    for (const [index, verdict] of (['FAIL', 'FAIL', 'PASS'] as const).entries()) {
      store.history.recordVerdict({ itemId: item.id, runId: item.runId, round: index + 1, verdict,
        findings: [{ severity: 'high', confidence: 95, summary: 'Retry fails', file: 'src/retry.ts' }],
        gatesRun: [], notChecked: ['Windows runtime needs its worker.'], worktreeHead: 'head', documentSha256: 'document' });
    }
    store.upsertItem({ ...item, state: 'parked', detail: 'Stopped in /Users/example/private/project/file.ts' });
    store.upsertItem({ ...item, state: 'queued', round: 0, verdict: null });
    const restored = new PlanQueueStore(db);
    expect(restored.history.listVerdicts(item.id).map(row => row.verdict)).toEqual(['FAIL', 'FAIL', 'PASS']);
    expect(new Set(restored.history.listVerdicts(item.id).map(row => row.findings[0].id)).size).toBe(1);
    const events = restored.history.listEvents(item.id);
    expect(events.map(row => row.toState)).toEqual(['queued', 'parked', 'discovered']);
    expect(events[1].detailHead).not.toContain('/Users/');
  });
});
