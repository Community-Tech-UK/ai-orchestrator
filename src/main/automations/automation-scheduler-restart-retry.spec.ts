import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationScheduler } from './automation-scheduler';
import { AutomationRunner } from './automation-runner';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { RESTART_INTERRUPTION } from './automation-restart-retry';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/automation-retry-test' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }) }));

describe('recurring scheduling after a stale restart retry', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let scheduler: AutomationScheduler;
  let runner: AutomationRunner;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    resetAutomationEventsForTesting();
    db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    const events = getAutomationEvents();
    runner = new AutomationRunner(store, events, () => Date.now(), vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }));
    vi.spyOn(runner, 'fire').mockResolvedValue({ status: 'skipped', reason: 'No provider session in this scheduler test' });
    scheduler = new AutomationScheduler(store, runner, new CatchUpCoordinator(store, runner, events), events);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); resetAutomationEventsForTesting(); db.close(); });

  it.each([false, true])('re-arms the edited cron job after rejecting its retry (active run: %s)', async active => {
    const nominal = Date.now() + 3_600_000;
    const job = await store.create({ name: 'Recurring check', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: { prompt: 'Original check', workingDirectory: '/tmp' } }, nominal);
    const first = store.decideAndInsertRun(job, 'scheduled', Date.now() - 60_000, Date.now() - 60_000);
    expect(first.kind).toBe('started');
    store.failRunningRuns(RESTART_INTERRUPTION, Date.now());
    expect(store.listPendingRetries()).toHaveLength(1);
    const edited = await store.update(job.id, { action: { ...job.action, prompt: 'Changed check' } }, nominal);
    if (active) expect(store.decideAndInsertRun(edited, 'manual', Date.now(), Date.now()).kind).toBe('started');
    scheduler.initialize();
    const insert = vi.spyOn(store, active ? 'insertPendingRetryRun' : 'insertRetryRun');
    await vi.advanceTimersByTimeAsync(15_001);
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.results[0].value).toBeNull();
    expect(store.listPendingRetries()).toHaveLength(0);
    const fire = vi.spyOn(store, 'setNextFireAt');
    await vi.advanceTimersByTimeAsync(nominal - Date.now());
    expect(fire).toHaveBeenCalledWith(job.id, nominal + 3_600_000, nominal);
    scheduler.deactivate(job.id);
  });

  it.each(['oneTime', 'disabled', 'deleted'] as const)('does not re-arm an ineligible %s job after dropping its restart retry', async kind => {
    const next = Date.now() + 3_600_000;
    const job = await store.create({ name: 'Interrupted check',
      schedule: kind === 'oneTime' ? { type: 'oneTime', runAt: next } : { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: { prompt: 'Original check', workingDirectory: '/tmp' } }, next);
    expect(store.decideAndInsertRun(job, 'scheduled', Date.now() - 60_000, Date.now() - 60_000).kind).toBe('started');
    store.failRunningRuns(RESTART_INTERRUPTION, Date.now());
    scheduler.initialize();
    if (kind === 'deleted') await store.delete(job.id);
    else await store.update(job.id, kind === 'disabled' ? { enabled: false }
      : { action: { ...job.action, prompt: 'Changed check' } }, undefined);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(store.listPendingRetries()).toHaveLength(0);
    if (kind === 'oneTime') expect((await store.get(job.id))?.nextFireAt).toBeNull();
    const events = getAutomationEvents();
    const restarted = new AutomationScheduler(store, runner, new CatchUpCoordinator(store, runner, events), events);
    restarted.initialize();
    await vi.advanceTimersByTimeAsync(3_600_001);
    expect(runner.fire).not.toHaveBeenCalled();
    restarted.deactivate(job.id);
    scheduler.deactivate(job.id);
  });

  it('preserves and arms a newly chosen one-time fire instead of the old retry time', async () => {
    const originalTime = Date.now() + 3_600_000;
    const replacementTime = originalTime + 3_600_000;
    const job = await store.create({ name: 'Rescheduled check', schedule: { type: 'oneTime', runAt: originalTime },
      action: { prompt: 'Check once', workingDirectory: '/tmp' } }, originalTime);
    expect(store.decideAndInsertRun(job, 'scheduled', Date.now() - 60_000, Date.now() - 60_000).kind).toBe('started');
    store.failRunningRuns(RESTART_INTERRUPTION, Date.now());
    scheduler.initialize();
    const updated = await store.update(job.id, { schedule: { type: 'oneTime', runAt: replacementTime } }, replacementTime);
    scheduler.schedule(updated);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await store.get(job.id))?.nextFireAt).toBe(replacementTime);
    expect(store.listPendingRetries()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(replacementTime - Date.now());
    expect(runner.fire).toHaveBeenCalledExactlyOnceWith(job.id, { trigger: 'scheduled', scheduledAt: replacementTime });
    scheduler.deactivate(job.id);
  });
});
