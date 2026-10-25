import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import type { AutomationAttachmentService } from './automation-attachment-service';

const databases: ReturnType<typeof defaultDriverFactory>[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));

describe('held automation runs', () => {
  it('keeps held fires as durable pending rows even with the skip policy', async () => {
    const db = defaultDriverFactory(':memory:');
    databases.push(db);
    createTables(db); createMigrationsTable(db); runMigrations(db);
    const store = new AutomationStore(db, {
      prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [],
    } as unknown as AutomationAttachmentService);
    const automation = await store.create({ name: 'Check', concurrencyPolicy: 'skip', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, action: { prompt: 'Check', workingDirectory: '/tmp' } }, 1000, 100);
    const first = store.decideAndInsertRun(automation, 'scheduled', 1000, 1000, { admissionHeld: true });
    const second = store.decideAndInsertRun(automation, 'catchUp', 2000, 2000, { admissionHeld: true });
    expect(first.kind).toBe('queued');
    expect(second.kind).toBe('queued');
    expect(store.listActiveRuns().map(run => run.status)).toEqual(['pending', 'pending']);
    const claimed = store.claimNextPending(undefined, 3000);
    expect(claimed?.run.status).toBe('running');
    expect(store.claimNextPending(undefined, 3000)).toBeNull();
    store.terminalizeRun(claimed!.run.id, 'succeeded', undefined, undefined, 4000);
    expect(store.claimNextPending(undefined, 4000)?.run.scheduledAt).toBe(2000);
  });
});
