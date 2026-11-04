import { afterEach, expect, it, vi } from 'vitest';
import { createInstance } from '../../shared/types/instance.types';
import type { CliResponse } from '../cli/adapters/base-cli-adapter.types';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { recordCompletionCost } from '../instance/communication-completion-cost';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { PlanQueueStore } from './plan-queue-store';
import { attachPlanQueueSpendRecorder } from './plan-queue-spend';

vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: () => ({ cost: 0.25 }) }) }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({}) }));
afterEach(() => vi.unstubAllEnvs());

it('books final queue usage with captured ownership after its instance is removed', () => {
  // Exercise observers while disabling the unrelated user-data JSONL sink.
  vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
  const db = defaultDriverFactory(':memory:'); runLoopMigrations(db);
  db.prepare("INSERT INTO plan_queue_runs (id,parent_instance_id,kind,workspace_cwd,status,config_json,started_at,updated_at) VALUES ('run','parent','plans','/fixture','running','{}',1,1)").run();
  db.prepare("INSERT INTO plan_queue_items (id,run_id,document_path,state,round,created_at,updated_at) VALUES ('item','run','/fixture/a','working',2,1,1)").run();
  const store = new PlanQueueStore(db);
  const instance = createInstance({ workingDirectory: '/fixture', provider: 'claude',
    metadata: { planQueueRunId: 'run', planQueueItemId: 'item', planQueueRole: 'worker', planQueueRound: 2 } });
  instance.currentModel = 'fixture-model';
  const stop = attachPlanQueueSpendRecorder({ store });
  const response: CliResponse = { id: 'response', role: 'assistant', content: 'Fixture result' };
  const settle = deferResponseUsage(response);
  try {
    recordCompletionCost(instance.id, instance, response);
    instance.metadata = {};
    store.upsertItem({ ...store.getItem('item')!, round: 3 });
    response.usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 1000, cacheWriteTokens: 30, cost: 0.25 };
    settle();
    expect(store.listSpend('run')).toMatchObject([{ itemId: 'item', role: 'worker', round: 2,
      processed: 1040, output: 20, costUsd: 0.25, costBasis: 'exact' }]);
    expect(store.getItem('item')?.spend).toEqual({ tokens: 1060, costUsd: 0.25, exactUsd: 0.25 });
    settle();
    expect(store.listSpend('run')).toHaveLength(1);
  } finally { stop(); db.close(); }
});
