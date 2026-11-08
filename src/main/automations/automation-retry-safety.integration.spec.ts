import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { Automation, AutomationRun } from '../../shared/types/automation.types';
import { WorkAdmission, getWorkAdmission } from '../work-admission/work-admission';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { AutomationScheduler } from './automation-scheduler';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { createAutomationNetworkGate } from './automation-network-gate';
import type { AutomationNetworkGate } from './automation-network-gate';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { RESTART_INTERRUPTION } from './automation-restart-retry';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/automation-retry-safety' }, powerMonitor: new EventEmitter() }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }) }));

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

describe('retry safety through the real scheduler and store', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let runner: AutomationRunner;
  let scheduler: AutomationScheduler;
  let instances: Map<string, Instance>;
  let manager: EventEmitter & { createInstance: ReturnType<typeof vi.fn>; terminateInstance: ReturnType<typeof vi.fn> };
  let online: boolean;
  let gate: AutomationNetworkGate;
  let restoreNetwork: () => void;
  let accountPreferencesWait: Promise<undefined> | undefined;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T10:00:00Z'));
    WorkAdmission._resetForTesting(); resetAutomationEventsForTesting();
    db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as never);
    instances = new Map(); online = true; accountPreferencesWait = undefined;
    const restored = new Promise<{ ready: boolean; waitedMs: number }>(resolve => { restoreNetwork = () => resolve({ ready: true, waitedMs: 61_000 }); });
    gate = createAutomationNetworkGate({ resolver: () => async () => ({}), probe: async () => online, wait: () => restored });
    manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async (config: InstanceCreateConfig) => {
        const instance = { id: `instance-${instances.size}`, parentId: null, childrenIds: [], status: 'busy', outputBuffer: [], metadata: config.metadata } as unknown as Instance;
        instances.set(instance.id, instance); return instance;
      }),
      getInstance: (id: string) => instances.get(id), getAllInstances: () => [...instances.values()],
      terminateInstance: vi.fn(async (id: string) => { instances.delete(id); }), queueInstanceUpdate: vi.fn(),
    });
    runner = new AutomationRunner(store, undefined, Date.now, (() => ({})) as never, 4, 100,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'sonnet', modelPickerFavorites: [] }), () => false, gate,
      async () => accountPreferencesWait);
    runner.initialize(manager as unknown as InstanceManager);
    scheduler = new AutomationScheduler(store, runner, new CatchUpCoordinator(store, runner), undefined, Date.now, gate);
  });
  afterEach(() => {
    for (const job of store.listSchedulable()) scheduler.deactivate(job.id);
    vi.clearAllTimers(); WorkAdmission._resetForTesting(); resetAutomationEventsForTesting(); vi.restoreAllMocks(); vi.useRealTimers(); db.close();
  });
  async function createJob(concurrencyPolicy: 'skip' | 'queue' = 'skip', maxRunMinutes = 1): Promise<Automation> {
    return store.create({ name: 'Recurring check', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, concurrencyPolicy,
      action: { prompt: 'Check', workingDirectory: '/fixture', maxRunMinutes } }, Date.now() + 3_600_000, Date.now());
  }
  function failedRun(job: Automation): AutomationRun {
    const decision = store.decideAndInsertRun(job, 'scheduled', Date.now() - 1000, Date.now() - 1000, { maxAttempts: 4 });
    if (decision.kind !== 'started') throw new Error('Expected initial run');
    return store.terminalizeRun(decision.run.id, 'failed', 'Transient failure', undefined, Date.now())!;
  }
  async function startNewer(job: Automation) {
    const outcome = await runner.fire(job.id, { trigger: 'manual' });
    if (outcome.status !== 'started') throw new Error('Expected newer run');
    manager.terminateInstance.mockRejectedValue(new Error('Stop rejected'));
    return outcome.run;
  }
  function retry(job: Automation) { return store.listRuns({ automationId: job.id }).find(run => run.attempt === 2)!; }


  it.each(['resume', 'retry'] as const)('refuses overdue %s before any provider creation or timer turn', async entry => {
    const job = await createJob();
    const decision = store.decideAndInsertRun(job, 'scheduled', Date.now(), Date.now());
    if (decision.kind !== 'started') throw new Error('Expected running job');
    const run = decision.run; const startedAt = run.startedAt;
    runner.pauseRunForGlobalPause(run.id);
    vi.setSystemTime(Date.now() + 60_001);
    if (entry === 'resume') await runner.resumePendingRunForGlobalPause(run.id);
    else await runner.dispatchRetryRun(run);
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', startedAt, error: 'Stopped after 1 minutes' });
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it.each(['resume', 'retry'] as const)('keeps the original unexpired %s deadline, minus time paused', async entry => {
    const job = await createJob();
    const decision = store.decideAndInsertRun(job, 'scheduled', Date.now(), Date.now());
    if (decision.kind !== 'started') throw new Error('Expected running job');
    const run = decision.run; const startedAt = run.startedAt;
    if (entry === 'resume') runner.pauseRunForGlobalPause(run.id);
    vi.setSystemTime(Date.now() + 59_000);
    if (entry === 'resume') await runner.resumePendingRunForGlobalPause(run.id);
    else await runner.dispatchRetryRun(run);
    expect(manager.createInstance).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', startedAt });
    // Time paused for a restart does not count against the limit, so a resumed run gets those 59 seconds back.
    if (entry === 'resume') {
      await vi.advanceTimersByTimeAsync(1001);
      expect(store.getRun(run.id)).toMatchObject({ status: 'running', startedAt });
      await vi.advanceTimersByTimeAsync(59_000);
    } else await vi.advanceTimersByTimeAsync(1001);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', startedAt, error: 'Stopped after 1 minutes' });
  });

  it('rechecks an elapsed deadline after account admission without relying on timer callbacks', async () => {
    const job = await createJob(); const original = failedRun(job);
    const run = store.insertRetryRun(original, 2, 4, Date.now(), Date.now())!;
    let release!: (value: undefined) => void;
    accountPreferencesWait = new Promise(resolve => { release = resolve; });
    const dispatch = runner.dispatchRetryRun(run); await flush();
    vi.setSystemTime(Date.now() + 60_001); release(undefined); await dispatch;
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', startedAt: run.startedAt, error: 'Stopped after 1 minutes' });
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it('expires an offline retry at its original deadline without any later paid start', async () => {
    const job = await createJob(); const original = failedRun(job); online = false;
    scheduler.scheduleRetry(original, 2, 4, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(retry(job).status).toBe('running');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(retry(job)).toMatchObject({ status: 'failed', error: 'Stopped after 1 minutes' });
    expect(store.listPendingRetries()).toHaveLength(0);
    restoreNetwork(); await flush();
    expect(manager.createInstance).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.listRuns({ automationId: job.id })).toHaveLength(2);
  });

  it('refuses a retry whose saved run disappeared before dispatch', async () => {
    const job = await createJob(); const original = failedRun(job);
    const waiting = store.insertRetryRun(original, 2, 4, Date.now(), Date.now())!;
    await store.delete(job.id);
    expect(store.getRun(waiting.id)).toBeNull();
    await runner.dispatchRetryRun(waiting);
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  it('does not start a deleted retry after its asynchronous account lookup returns', async () => {
    const job = await createJob(); const original = failedRun(job);
    const waiting = store.insertRetryRun(original, 2, 4, Date.now(), Date.now())!;
    let release!: (value: undefined) => void;
    accountPreferencesWait = new Promise(resolve => { release = resolve; });
    const dispatch = runner.dispatchRetryRun(waiting);
    try {
      await flush(); expect(manager.createInstance).not.toHaveBeenCalled();
      await store.delete(job.id);
    } finally { release(undefined); }
    await dispatch;
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  it.each(['skip', 'queue'] as const)('durably rejects an older due retry after a newer stop rejects (%s)', async policy => {
    const job = await createJob(policy); const original = failedRun(job);
    scheduler.scheduleRetry(original, 2, 4, 61_000);
    const newer = await startNewer(job);
    await vi.advanceTimersByTimeAsync(61_001);
    expect(store.getRun(newer.id)?.error).toContain('Could not stop');
    expect(retry(job)).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be stopped') });
    expect(manager.createInstance).toHaveBeenCalledOnce();
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it('rejects a queued retry at promotion while failed cancellation is still owned', async () => {
    const job = await createJob('queue'); const original = failedRun(job);
    await startNewer(job);
    scheduler.scheduleRetry(original, 2, 4, 10);
    await vi.advanceTimersByTimeAsync(10);
    expect(retry(job).status).toBe('pending');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(retry(job)).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be stopped') });
    expect(manager.createInstance).toHaveBeenCalledOnce();
    expect(store.listPendingRetries()).toHaveLength(0);
  });

  it.each(['network', 'admission'] as const)('rechecks failed-stop ownership after a retry waits for %s', async waitFor => {
    const job = await createJob('skip', 10); const original = failedRun(job);
    await store.update(job.id, { action: { ...job.action, maxRunMinutes: 1 } }, undefined);
    await startNewer(job);
    let waiting: AutomationRun;
    if (waitFor === 'network') {
      waiting = store.insertRetryRun(original, 2, 4, Date.now(), Date.now())!;
      online = false;
      await gate(waiting, store, () => runner.dispatchRetryRun(waiting));
    } else {
      getWorkAdmission().setGlobalPhase('holding');
      scheduler.scheduleRetry(original, 2, 4, 10);
      await vi.advanceTimersByTimeAsync(10);
    }
    await vi.advanceTimersByTimeAsync(60_001);
    if (waitFor === 'network') restoreNetwork();
    else getWorkAdmission().setGlobalPhase('none');
    await flush();
    const rejected = waitFor === 'network' ? store.getRun(waiting!.id) : retry(job);
    expect(rejected).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be stopped') });
    expect(store.listPendingRetries()).toHaveLength(0);
    expect(manager.createInstance).toHaveBeenCalledOnce();
  });

  it('restores the next cron timer when a dispatched restart retry fails', async () => {
    const job = await createJob();
    store.decideAndInsertRun(job, 'scheduled', Date.now() - 1000, Date.now() - 1000);
    store.failRunningRuns(RESTART_INTERRUPTION, Date.now());
    scheduler.initialize();
    manager.createInstance.mockRejectedValueOnce(new Error('Retry startup failed'));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(retry(job)).toMatchObject({ status: 'failed', error: 'Retry startup failed' });
    expect(store.listPendingRetries()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(job.nextFireAt! - Date.now());
    expect(manager.createInstance).toHaveBeenCalledTimes(2);
    expect(store.listRuns({ automationId: job.id }).some(run => run.scheduledAt === job.nextFireAt && run.status === 'running')).toBe(true);
  });

  it.each(['cancel', 'disable', 'drop', 'insert', 'queue'] as const)('publishes the current source retry marker synchronously on arm and %s', async action => {
    const job = await createJob(action === 'queue' ? 'queue' : 'skip'); const original = failedRun(job);
    const changed = vi.spyOn(getAutomationEvents(), 'emitRunChanged');
    scheduler.scheduleRetry(original, 2, 4, 10);
    expect(changed.mock.calls.some(([event]) => event.run.id === original.id && event.run.nextRetryAt === Date.now() + 10)).toBe(true);
    changed.mockClear();
    if (action === 'cancel') scheduler.cancelRetry(original.id);
    if (action === 'disable') scheduler.deactivate(job.id);
    if (action === 'drop') await store.update(job.id, { enabled: false }, undefined);
    if (action === 'queue') await startNewer(job);
    if (!['cancel', 'disable'].includes(action)) await vi.advanceTimersByTimeAsync(10);
    expect(changed.mock.calls.some(([event]) => event.run.id === original.id && event.run.nextRetryAt === null)).toBe(true);
    if (action === 'queue') expect(changed.mock.calls.some(([event]) => event.run.id === retry(job).id && event.run.status === 'pending')).toBe(true);
  });
});
