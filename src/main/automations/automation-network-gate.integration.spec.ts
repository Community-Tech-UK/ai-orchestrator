/**
 * Replays the 2026-09-29 incident: a scheduled automation fired the moment the
 * Mac woke from hibernate, before DNS worked, and every Codex attempt failed
 * with "workspace routing discovery failed". The run must now wait for the
 * network instead of spawning into it, without blocking the caller.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import type { InstanceManager } from '../instance/instance-manager';
import type { NetworkReadyResult } from '../runtime/network-readiness';
import { AutomationStore } from './automation-store';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationRunner } from './automation-runner';
import { AutomationScheduler } from './automation-scheduler';
import { CatchUpCoordinator } from './catch-up-coordinator';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { createAutomationNetworkGate } from './automation-network-gate';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/ai-orchestrator-test') },
  powerMonitor: new EventEmitter(),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }),
}));

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.pragma('foreign_keys = ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function fakeManager() {
  const manager = Object.assign(new EventEmitter(), {
    createInstance: vi.fn(async () => ({ id: 'instance-1', outputBuffer: [], status: 'working' })),
    getInstance: vi.fn(() => undefined),
  });
  return manager as unknown as InstanceManager & { createInstance: ReturnType<typeof vi.fn> };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('automation network gate (integration)', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let online: boolean;
  let networkBack: ReturnType<typeof deferred<NetworkReadyResult>>;

  beforeEach(() => {
    resetAutomationEventsForTesting();
    db = createDb();
    store = new AutomationStore(db, {
      prepare: async () => [],
      replacePrepared: () => undefined,
      listForAutomation: async () => [],
    } as unknown as AutomationAttachmentService);
    online = false;
    networkBack = deferred<NetworkReadyResult>();
  });

  afterEach(() => {
    db.close();
  });

  const gate = () => createAutomationNetworkGate({
    resolver: () => () => Promise.resolve({}),
    probe: async () => online,
    wait: () => networkBack.promise,
  });

  function makeRunner(manager: InstanceManager): AutomationRunner {
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => Date.now(),
      vi.fn().mockReturnValue({ fireThreadWakeup: vi.fn() }),
      3,
      100,
      () => ({ automationDefaultCli: 'auto', automationDefaultModel: '', modelPickerFavorites: [] }),
      () => false,
      gate(),
    );
    runner.setRetryScheduler(() => undefined);
    runner.initialize(manager);
    return runner;
  }

  async function createAutomation(concurrencyPolicy: 'skip' | 'queue' = 'skip'): Promise<string> {
    const automation = await store.create({
      name: 'Process outreach review instructions',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'runOnce',
      concurrencyPolicy,
      action: { prompt: 'Do work', workingDirectory: '/tmp', provider: 'codex' },
    }, 1_000, 100);
    return automation.id;
  }

  it('holds a scheduled fire until DNS works, without blocking the caller', async () => {
    const manager = fakeManager();
    const runner = makeRunner(manager);
    const id = await createAutomation();

    const outcome = await runner.fire(id, { trigger: 'scheduled', scheduledAt: 1_000 });

    expect(outcome.status).toBe('started');
    expect(manager.createInstance).not.toHaveBeenCalled();
    // The run row exists and is running, so concurrency and catch-up see it.
    const runId = outcome.status === 'started' ? outcome.run.id : '';
    expect(store.getRun(runId)?.status).toBe('running');

    online = true;
    networkBack.resolve({ ready: true, waitedMs: 240_000 });
    await vi.waitFor(() => expect(manager.createInstance).toHaveBeenCalledOnce());
  });

  it('does not double-fire when a resume catch-up sweep lands during the wait', async () => {
    const manager = fakeManager();
    const runner = makeRunner(manager);
    const id = await createAutomation();

    await runner.fire(id, { trigger: 'scheduled', scheduledAt: 1_000 });
    const second = await runner.fire(id, { trigger: 'catchUp', scheduledAt: 1_000 });

    expect(second.status).toBe('skipped');
    networkBack.resolve({ ready: true, waitedMs: 1 });
    await vi.waitFor(() => expect(manager.createInstance).toHaveBeenCalledOnce());
  });

  it('dispatches a manual run immediately even while offline', async () => {
    const manager = fakeManager();
    const runner = makeRunner(manager);
    const id = await createAutomation();

    await runner.fire(id, { trigger: 'manual' });

    expect(manager.createInstance).toHaveBeenCalledOnce();
  });

  it('holds a queued scheduled run promoted after the active run ends', async () => {
    const manager = fakeManager();
    const runner = makeRunner(manager);
    const id = await createAutomation('queue');

    const active = await runner.fire(id, { trigger: 'manual' });
    const queued = await runner.fire(id, { trigger: 'scheduled', scheduledAt: 1_000 });
    expect(queued.status).toBe('queued');
    expect(manager.createInstance).toHaveBeenCalledOnce();

    if (active.status !== 'started') throw new Error('expected the manual run to start');
    store.terminalizeRun(active.run.id, 'succeeded', undefined, 'done', 2_000);
    await runner.promotePendingIfAny(id);
    expect(manager.createInstance).toHaveBeenCalledOnce();

    online = true;
    networkBack.resolve({ ready: true, waitedMs: 30_000 });
    await vi.waitFor(() => expect(manager.createInstance).toHaveBeenCalledTimes(2));
  });

  it('holds a retry fired by the scheduler until DNS works', async () => {
    vi.useFakeTimers();
    try {
      const manager = fakeManager();
      const runner = makeRunner(manager);
      const catchUp = new CatchUpCoordinator(store, runner, getAutomationEvents(), () => Date.now());
      const scheduler = new AutomationScheduler(
        store, runner, catchUp, getAutomationEvents(), () => Date.now(), gate(),
      );
      const id = await createAutomation();
      const automation = await store.get(id);
      const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, { maxAttempts: 3, attempt: 1 });
      if (decision.kind !== 'started') throw new Error('expected a started run');
      const failed = store.terminalizeRun(decision.run.id, 'failed', 'workspace routing discovery failed', undefined, 2_000)!;

      scheduler.scheduleRetry(failed, 2, 3, 500);
      await vi.advanceTimersByTimeAsync(600);
      expect(manager.createInstance).not.toHaveBeenCalled();

      online = true;
      networkBack.resolve({ ready: true, waitedMs: 120_000 });
      await vi.waitFor(() => expect(manager.createInstance).toHaveBeenCalledOnce());
      expect(manager.createInstance).toHaveBeenCalledWith(expect.objectContaining({
        displayName: 'Process outreach review instructions (retry 2)',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
