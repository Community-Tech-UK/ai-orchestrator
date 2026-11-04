import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { attachPlanQueueSpendRecorder } from './plan-queue-spend';
import { recordCostAttribution, recordInstanceTurnAttribution } from '../core/system/cost-attribution';

describe('queue spend attribution', () => {
  it('keeps the original pricing source when attribution already contains a calculated dollar cost', () => {
    const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
    db.prepare("INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES ('run','parent','plans','/repo','running','{}',1,1)").run();
    const store = new PlanQueueStore(db);
    const stop = attachPlanQueueSpendRecorder({ store });
    try {
      for (const [provider, costSource, cost] of [['claude', 'priced', 0.25], ['claude', 'provider', 0.25],
        ['codex', 'provider', 0.25], ['copilot', 'free', 0]] as const) {
        recordInstanceTurnAttribution({ instanceId: 'worker', provider, model: 'sonnet', costSource, costKnown: true,
          usage: { inputTokens: 10, outputTokens: 20, cost },
          planQueue: { runId: 'run', itemId: null, role: 'worker', round: 1 } });
      }
      expect(store.listSpend('run').map(row => row.costBasis)).toEqual(['exact', 'estimated', 'exact', 'estimated']);
      expect(store.getRun('run')?.spend).toEqual({ tokens: 120, costUsd: 0.75, exactUsd: 0.25 });
    } finally { stop(); db.close(); }
  });
  it('counts cached input and preserves null cost with the role and round', () => {
    const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
    db.prepare("INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES ('run','parent','plans','/repo','running','{}',1,1)").run();
    db.prepare("INSERT INTO plan_queue_items (id,run_id,document_path,state,round,created_at,updated_at) VALUES ('item','run','/repo/a','working',2,1,1)").run();
    const store = new PlanQueueStore(db);
    const stop = attachPlanQueueSpendRecorder({ store });
    try {
      recordCostAttribution({ source: 'instance-turn', taskType: 'child', instanceId: 'checker', provider: 'unknown', planQueue: { runId: 'run', itemId: 'item', role: 'verifier', round: 2 },
        usage: { inputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 30, outputTokens: 20 } });
      expect(store.getItem('item')?.spend).toMatchObject({ tokens: 1060, unpricedTokens: 1060 });
      expect(store.listSpend('run')).toMatchObject([{ processed: 1040, output: 20, costUsd: null, costBasis: 'unknown', role: 'verifier', round: 2 }]);
    } finally { stop(); db.close(); }
  });
  it('accumulates worker/replacement verifier costs by item and triage by run', () => {
    const db = new Database(':memory:') as unknown as SqliteDriver; runLoopMigrations(db);
    db.prepare("INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES ('run','parent','plans','/repo','running','{}',1,1)").run();
    db.prepare("INSERT INTO plan_queue_items (id,run_id,document_path,state,created_at,updated_at) VALUES ('item','run','/repo/a','working',1,1)").run();
    const store = new PlanQueueStore(db);
    const stop = attachPlanQueueSpendRecorder({ store });
    for (const instanceId of ['worker','replacement','triage','unrelated']) recordCostAttribution({ source: 'instance-turn', taskType: 'child', instanceId, provider: 'claude', ...(instanceId === 'unrelated' ? {} : { planQueue: { runId: 'run', itemId: instanceId === 'triage' ? null : 'item', role: instanceId === 'triage' ? 'triage' : 'worker', round: null } }), usage: { inputTokens: 10, outputTokens: 20, cost: 0.25 } });
    stop();
    expect(store.getItem('item')?.spend).toEqual({ tokens: 60, costUsd: 0.5, exactUsd: 0.5 });
    expect(store.getRun('run')?.spend).toEqual({ tokens: 30, costUsd: 0.25, exactUsd: 0.25 });
    store.upsertItem(store.getItem('item')!);
    expect(store.getItem('item')?.spend?.costUsd).toBe(0.5);
    db.close();
  });
});
