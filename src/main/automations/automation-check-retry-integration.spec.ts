import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { AutomationCheckStore } from './automation-check-store';
import { AutomationRunner } from './automation-runner';
import { AutomationStore } from './automation-store';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import type { AutomationRun } from '../../shared/types/automation.types';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { pauseConsults } from '../work-admission/consult-admission';
import * as preCheck from './automation-pre-check';

const checkStoreSlot = vi.hoisted(() => ({ store: null as AutomationCheckStore | null }));

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ai-orchestrator-check-retry-test' } }));
// Checks run through plain `/bin/sh -c`, not the developer's login shell: its profile start-up follows the
// computer's load and timed these tests out on a busy Mac. The login shell is covered by automation-pre-check.spec.ts.
vi.mock('../orchestration/loop-completion-detector', async (importOriginal) => ({
  ...await importOriginal<typeof import('../orchestration/loop-completion-detector')>(),
  buildVerifyInvocation: (command: string) => ({ file: '/bin/sh', args: ['-c', command], useShellOption: false }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
// Account routing has its own tests; these runs must not read real settings.
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }),
}));
vi.mock('./automation-check-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./automation-check-store')>();
  return {
    ...actual,
    getAutomationCheckStore: () => {
      if (!checkStoreSlot.store) throw new Error('Test check store was not initialized');
      return checkStoreSlot.store;
    },
  };
});

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('checked automation retry baseline transitions', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let checkStore: AutomationCheckStore;

  beforeEach(() => {
    WorkAdmission._resetForTesting();
    resetAutomationEventsForTesting();
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    const attachments = {
      prepare: async () => [],
      replacePrepared: () => undefined,
      listForAutomation: async () => [],
    } as unknown as AutomationAttachmentService;
    store = new AutomationStore(db, attachments);
    checkStore = new AutomationCheckStore(db);
    checkStoreSlot.store = checkStore;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    WorkAdmission._resetForTesting();
    checkStoreSlot.store = null;
    db.close();
  });

  async function makeCheckedJob(concurrencyPolicy: 'skip' | 'queue' = 'skip') {
    return store.create({
      name: 'Checked retry job',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy,
      action: {
        prompt: 'Report changes',
        workingDirectory: '/tmp',
        provider: 'claude',
        preCheck: { command: "printf 'new\\n'" },
      },
    }, 1_000, 100);
  }

  function makeRunner(maxAttempts: number) {
    let now = 1_000;
    let instanceNumber = 0;
    const instances = new Map<string, { id: string; status: string; outputBuffer: [] }>();
    const manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async (_options: { initialPrompt: string }) => {
        const instance = { id: `instance-${++instanceNumber}`, status: 'working', outputBuffer: [] as [] };
        instances.set(instance.id, instance);
        return instance;
      }),
      getInstance: (id: string) => instances.get(id),
    });
    const retries: { run: AutomationRun; nextAttempt: number; maxAttempts: number }[] = [];
    const runner = new AutomationRunner(
      store,
      getAutomationEvents(),
      () => now,
      undefined,
      maxAttempts,
      100,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: '', modelPickerFavorites: [] }),
      undefined,
      async (_run, _store, dispatch) => dispatch(),
    );
    runner.setRetryScheduler((run, nextAttempt, retryMaxAttempts) => {
      retries.push({ run, nextAttempt, maxAttempts: retryMaxAttempts });
    });
    runner.initialize(manager as unknown as InstanceManager);
    return { runner, manager, retries, setNow: (value: number) => { now = value; } };
  }

  it('promotes only a successful retry and skips the next identical scheduled tick', async () => {
    const automation = await makeCheckedJob();
    const { runner, manager, retries, setNow } = makeRunner(2);
    const first = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: 1_000 });
    expect(first.status).toBe('started');
    expect(manager.createInstance).toHaveBeenCalledTimes(1);
    expect(checkStore.getState(automation.id)).toMatchObject({
      baselineHash: null,
      pendingRunId: first.run!.id,
      pendingHash: hash('new\n'),
    });

    manager.emit('provider:normalized-event', {
      instanceId: 'instance-1', event: { kind: 'error', message: 'transient', recoverable: false },
    });
    expect(retries).toHaveLength(1);
    expect(checkStore.getState(automation.id)?.pendingRunId).toBe(first.run!.id);
    expect(checkStore.getState(automation.id)?.baselineHash).toBeNull();

    setNow(1_500);
    const retry = store.insertRetryRun(retries[0]!.run, 2, 2, 1_500, 1_500)!;
    expect(checkStore.getState(automation.id)?.pendingRunId).toBe(retry.id);
    await runner.dispatchRetryRun(retry);
    expect(manager.createInstance).toHaveBeenCalledTimes(2);
    expect(manager.createInstance.mock.calls[1]![0].initialPrompt).toContain('automation_check_result');
    manager.emit('provider:normalized-event', {
      instanceId: 'instance-2', event: { kind: 'output', messageType: 'assistant', content: 'Found a change.' },
    });
    manager.emit('provider:normalized-event', {
      instanceId: 'instance-2', event: { kind: 'complete' },
    });
    const promoted = checkStore.getState(automation.id);
    expect(promoted).toMatchObject({ baselineHash: hash('new\n'), baselineOutput: 'new\n', pendingRunId: null });
    expect(store.getRun(retry.id)?.status).toBe('succeeded');

    setNow(2_000);
    const next = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: 2_000 });
    expect(next.status).toBe('started');
    expect(store.getRun(next.run!.id)).toMatchObject({ status: 'skipped', outcome: 'no-change' });
    expect(manager.createInstance).toHaveBeenCalledTimes(2);
    expect(checkStore.getState(automation.id)).toMatchObject({
      baselineHash: hash('new\n'), baselineAt: promoted!.baselineAt, pendingRunId: null,
    });
  });

  it.each([
    ['scheduled', 'first-check'], ['scheduled', 'changed'], ['scheduled', 'check-failed'],
    ['catchUp', 'first-check'], ['catchUp', 'changed'], ['catchUp', 'check-failed'],
  ] as const)('resumes a %s %s startup without repeating its check or prompt note', async (trigger, outcome) => {
    const automation = await store.create({
      name: 'Checked pause job',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: { prompt: 'Report changes', workingDirectory: '/tmp', provider: 'claude',
        preCheck: { command: outcome === 'check-failed' ? 'exit 2' : "printf 'new\\n'" } },
    }, 1_000, 100);
    if (outcome !== 'first-check') {
      checkStore.setPending(automation.id, 'seed', hash('old\n'), 'old\n');
      checkStore.promotePending('seed', 500);
    }
    const check = vi.spyOn(preCheck, 'runAutomationPreCheck');
    const { runner, manager } = makeRunner(2);
    const terminateInstance = vi.fn(async () => undefined);
    Object.assign(manager, { terminateInstance });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const creation = new Promise<void>(resolve => { release = resolve; });
    manager.createInstance.mockImplementationOnce(async () => {
      entered();
      await creation;
      return { id: 'paused-startup', status: 'working', outputBuffer: [] };
    });
    const dispatching = runner.fire(automation.id, { trigger, scheduledAt: 1_000 });
    await started;
    const run = store.listActiveRuns()[0]!;
    const savedPrompt = run.configSnapshot!.action.prompt;
    expect(run.outcome).toBe(outcome);
    expect(check).toHaveBeenCalledOnce();

    getWorkAdmission().setGlobalPhase('collecting');
    const pausing = pauseConsults();
    release();
    await dispatching;
    await pausing;
    expect(terminateInstance).toHaveBeenCalledWith('paused-startup', false);
    expect(store.getRun(run.id)).toMatchObject({ status: 'running', instanceId: null });
    const pendingBeforeResume = checkStore.getState(automation.id);

    getWorkAdmission().setGlobalPhase('none');
    await runner.resumePendingRunForGlobalPause(run.id);
    expect(check).toHaveBeenCalledOnce();
    expect(manager.createInstance).toHaveBeenCalledTimes(2);
    expect(manager.createInstance.mock.calls[1]![0].initialPrompt)
      .toBe(manager.createInstance.mock.calls[0]![0].initialPrompt);
    expect(store.getRun(run.id)?.configSnapshot?.action.prompt).toBe(savedPrompt);
    expect(checkStore.getState(automation.id)).toEqual(pendingBeforeResume);

    manager.emit('provider:normalized-event', {
      instanceId: 'instance-1', event: { kind: 'output', messageType: 'assistant', content: 'Checked.' },
    });
    manager.emit('provider:normalized-event', { instanceId: 'instance-1', event: { kind: 'complete' } });
    expect(store.getRun(run.id)?.status).toBe('succeeded');
    expect(checkStore.getState(automation.id)?.baselineHash).toBe(hash(outcome === 'check-failed' ? 'old\n' : 'new\n'));
    expect(checkStore.getState(automation.id)?.pendingRunId).toBeNull();
  });

  it('clears the pending capture after the last failed attempt without moving the baseline', async () => {
    const automation = await makeCheckedJob();
    checkStore.setPending(automation.id, 'seed', hash('old\n'), 'old\n');
    checkStore.promotePending('seed', 500);
    const { runner, manager, retries, setNow } = makeRunner(2);
    const first = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: 1_000 });
    expect(first.status).toBe('started');
    expect(checkStore.getState(automation.id)?.pendingRunId).toBe(first.run!.id);
    manager.emit('provider:normalized-event', {
      instanceId: 'instance-1', event: { kind: 'error', message: 'transient', recoverable: false },
    });
    setNow(1_500);
    const retry = store.insertRetryRun(retries[0]!.run, 2, 2, 1_500, 1_500)!;
    await runner.dispatchRetryRun(retry);
    manager.emit('provider:normalized-event', {
      instanceId: 'instance-2', event: { kind: 'error', message: 'still failing', recoverable: false },
    });

    expect(retries).toHaveLength(1);
    expect(store.getRun(retry.id)?.status).toBe('failed');
    expect(checkStore.getState(automation.id)).toMatchObject({
      baselineHash: hash('old\n'), baselineOutput: 'old\n', baselineAt: 500,
      pendingRunId: null, pendingHash: null, pendingOutput: null,
    });
  });

  it('cancels a checked pending retry without advancing the baseline', async () => {
    const automation = await makeCheckedJob('queue');
    checkStore.setPending(automation.id, 'seed', hash('old\n'), 'old\n');
    checkStore.promotePending('seed', 500);
    const decision = store.decideAndInsertRun(automation, 'scheduled', 1_000, 1_000, {
      maxAttempts: 2, attempt: 1,
    });
    expect(decision.kind).toBe('started');
    if (decision.kind !== 'started') throw new Error('Expected first run');
    checkStore.setPending(automation.id, decision.run.id, hash('new\n'), 'new\n');
    const failed = store.terminalizeRun(decision.run.id, 'failed', 'transient', undefined, 1_200)!;
    const pendingRetry = store.insertPendingRetryRun(failed, 2, 2, 1_500, 1_500)!;
    expect(checkStore.getState(automation.id)?.pendingRunId).toBe(pendingRetry.id);

    const cancelled = store.cancelPending(automation.id, 1_600);
    expect(cancelled.map((run) => run.id)).toEqual([pendingRetry.id]);
    expect(store.getRun(pendingRetry.id)?.status).toBe('cancelled');
    expect(checkStore.getState(automation.id)).toMatchObject({
      baselineHash: hash('old\n'), baselineOutput: 'old\n', baselineAt: 500,
      pendingRunId: null, pendingHash: null, pendingOutput: null,
    });
  });
});
