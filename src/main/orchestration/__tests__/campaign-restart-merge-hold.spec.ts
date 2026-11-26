import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { CampaignCoordinator } from '../campaign-coordinator';
import { CampaignStore } from '../campaign-store';
import { LoopStore } from '../loop-store';
import { runLoopMigrations } from '../loop-schema';
import type { CampaignRun, CampaignSpec } from '../campaign.types';

let db: SqliteDriver;
let loopStore: LoopStore;

vi.mock('../loop-store', async original => ({
  ...await original<typeof import('../loop-store')>(),
  getLoopStoreService: () => ({ store: loopStore, getDb: () => db }),
}));
vi.mock('../loop-coordinator', async () => {
  const { EventEmitter } = await import('node:events');
  return { getLoopCoordinator: () => new EventEmitter() };
});

beforeEach(() => {
  db = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(db);
  loopStore = new LoopStore(db);
});
afterEach(() => db.close());

describe('campaign restart through the production loop status reader', () => {
  it.each([true, false])('keeps the persisted merge hold (%s) when recovering a carry-on campaign', async mergeHold => {
    const spec: CampaignSpec = {
      id: 'campaign-restart', title: 'Restart recovery', createdAt: 1,
      nodes: [
        { id: 'a', label: 'First step', dependsOn: [], loopConfig: { initialPrompt: 'First', workspaceCwd: '/tmp', completion: { verifyCommand: 'npm test' } } },
        { id: 'b', dependsOn: ['a'], loopConfig: { initialPrompt: 'Second', workspaceCwd: '/tmp', completion: { verifyCommand: 'npm test' } } },
      ],
      edges: [{ from: 'a', to: 'b' }], policy: { onNodeNeedsReview: 'continue', maxParallel: 1 },
    };
    const run: CampaignRun = {
      id: spec.id, spec, status: 'running', startedAt: 1,
      nodeRuns: new Map([
        ['a', { nodeId: 'a', campaignId: spec.id, status: 'running', loopRunId: 'finished-offline', startedAt: 1 }],
        ['b', { nodeId: 'b', campaignId: spec.id, status: 'pending' }],
      ]),
    };
    const campaignStore = new CampaignStore(db);
    campaignStore.upsertCampaign(run);
    for (const node of run.nodeRuns.values()) campaignStore.upsertNode(node);
    db.prepare(`INSERT INTO loop_runs (id, chat_id, config_json, status, started_at, ended_at, end_evidence_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('finished-offline', 'campaign-chat', JSON.stringify(spec.nodes[0].loopConfig), 'completed-needs-review', 1, 2, JSON.stringify({ mergeHold }));

    const coordinator = new CampaignCoordinator();
    const start = vi.fn(async () => ({ id: 'next-loop' }));
    coordinator.setLoopStarterForTesting(start);
    coordinator.initialize();
    await coordinator.recoverInterruptedCampaigns();

    if (mergeHold) {
      expect(coordinator.getCampaign(spec.id)).toMatchObject({ status: 'paused', pausedReason: expect.stringContaining('was not merged') });
      expect(coordinator.getCampaign(spec.id)?.nodeRuns.get('b')?.status).toBe('pending');
      expect(start).not.toHaveBeenCalled();
      expect(campaignStore.getCampaign(spec.id)?.status).toBe('paused');
    } else {
      await vi.waitFor(() => expect(coordinator.getCampaign(spec.id)?.nodeRuns.get('b')?.status).toBe('running'));
      expect(start).toHaveBeenCalledOnce();
    }
  });
});
