import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { attachPlanQueueSpendRecorder } from './plan-queue-spend';
import { recordCostAttribution } from '../core/system/cost-attribution';

describe('queue spend attribution', () => {
  it('accumulates worker/replacement verifier costs by item and triage by run', () => {
    const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
    db.prepare("INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES ('run','parent','plans','/repo','running','{}',1,1)").run();
    db.prepare("INSERT INTO plan_queue_items (id,run_id,document_path,state,created_at,updated_at) VALUES ('item','run','/repo/a','working',1,1)").run();
    const store = new PlanQueueStore(db);
    const stop = attachPlanQueueSpendRecorder({ store, getInstanceMetadata: (id) => id === 'unrelated' ? {} : { planQueueRunId: 'run', planQueueRole: id === 'triage' ? 'triage' : 'worker', ...(id === 'triage' ? {} : { planQueueItemId: 'item' }) } });
    for (const instanceId of ['worker','replacement','triage','unrelated']) recordCostAttribution({ source: 'instance-turn', taskType: 'child', instanceId, provider: 'claude', usage: { inputTokens: 10, outputTokens: 20, cost: 0.25 } });
    stop();
    expect(store.getItem('item')?.spend).toEqual({ tokens: 60, costUsd: 0.5, exactUsd: 0.5 });
    expect(store.getRun('run')?.spend).toEqual({ tokens: 30, costUsd: 0.25, exactUsd: 0.25 });
    store.upsertItem(store.getItem('item')!);
    expect(store.getItem('item')?.spend?.costUsd).toBe(0.5);
    db.close();
  });
});
