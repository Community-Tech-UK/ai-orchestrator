import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutomationScheduler } from './automation-scheduler';
import { AutomationStore } from './automation-store';
import type { AutomationRunner } from './automation-runner';
import type { CatchUpCoordinator } from './catch-up-coordinator';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-test' }, powerMonitor: new EventEmitter() }));
const databases: ReturnType<typeof defaultDriverFactory>[] = [];
afterEach(() => { WorkAdmission._resetForTesting(); vi.useRealTimers(); databases.splice(0).forEach(db => db.close()); });

describe('retry admission', () => {
  it('keeps the durable retry while held, then fires it exactly once on release', async () => {
    vi.useFakeTimers();
    const db = defaultDriverFactory(':memory:'); databases.push(db);
    createTables(db); createMigrationsTable(db); runMigrations(db);
    const store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    const automation = await store.create({ name: 'Retry', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, action: { prompt: 'Retry work', workingDirectory: '/tmp' } }, 1000);
    const decision = store.decideAndInsertRun(automation, 'manual', 1000);
    if (decision.kind !== 'started') throw new Error('Fixture did not create a run');
    const failed = store.terminalizeRun(decision.run.id, 'failed', 'retryable')!;
    let fired = 0;
    const runner = { setRetryScheduler: () => undefined, dispatchRetryRun: async () => { fired++; } } as unknown as AutomationRunner;
    const scheduler = new AutomationScheduler(store, runner, {} as CatchUpCoordinator, undefined, Date.now, async (_run, _store, dispatch) => dispatch());
    getWorkAdmission().setGlobalPhase('holding');
    scheduler.scheduleRetry(failed, 2, 3, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(fired).toBe(0);
    expect(store.listPendingRetries()).toHaveLength(1);
    getWorkAdmission().setGlobalPhase('none');
    await Promise.resolve();
    expect(fired).toBe(1);
    expect(store.listPendingRetries()).toHaveLength(0);
    getWorkAdmission().notifyChanged();
    expect(fired).toBe(1);
  });
});
