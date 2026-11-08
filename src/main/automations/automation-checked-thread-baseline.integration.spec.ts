// Native provider transport is inert; admission, check command, park policy, receipts,
// terminal bookkeeping, and the migrated owned database execute their real paths.
import { SessionAdmissionStore } from '../session/session-admission-store';
import { getInstanceProviderLimitHandler, _resetInstanceProviderLimitHandlerForTesting } from '../instance/instance-provider-limit-handler';
import { createProviderLimitCommunicationCallbacks } from '../instance/instance-provider-limit-runtime';
import { getSessionAdmissionService, SessionAdmissionService } from '../session/session-admission-service';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleTerminalRun, type AutomationTerminalRunHost } from './automation-runner-terminal';
import type { AutomationAction, AutomationDestination, AutomationRun } from '../../shared/types/automation.types';
import { AutomationRunner } from './automation-runner';
import { ThreadWakeupRunner } from './thread-wakeup-runner';
import { AutomationStore } from './automation-store';
import { AutomationCheckStore } from './automation-check-store';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { createSqliteWasmDatabaseWithExport } from '../db/sqlite-wasm-driver';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import { GeminiCliAdapter } from '../cli/adapters/gemini-cli-adapter';
import { createInstance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { InstanceSendInputOptions } from '../instance/instance-input-cancellation';
import type { SqliteDriver } from '../db/sqlite-driver';
const slot = vi.hoisted(() => ({ db: null as SqliteDriver | null, directory: '/tmp/inert-checked-thread-probe', checkStore: null as AutomationCheckStore | null }));
vi.mock('electron', () => ({ app: { getPath: () => slot.directory, isPackaged: false }, Notification: { isSupported: () => false }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('./automation-check-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./automation-check-store')>()),
  getAutomationCheckStore: () => {
    if (!slot.checkStore) throw new Error('Test check store not initialized');
    return slot.checkStore;
  },
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn(), emitResponseSent: vi.fn() }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
let db: SqliteDriver;
let store: AutomationStore;
let checkStore: AutomationCheckStore;
beforeEach(() => {
  resetAutomationEventsForTesting();
  SessionAdmissionService._resetForTesting();
  SessionAdmissionStore._resetForTesting();
  _resetInstanceProviderLimitHandlerForTesting();
  slot.directory = mkdtempSync(join(tmpdir(), 'aio-checked-thread-gate-'));
  ({ driver: db } = createSqliteWasmDatabaseWithExport());
  slot.db = db;
  db.pragma('foreign_keys=ON');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as unknown as ConstructorParameters<typeof AutomationStore>[1]);
  checkStore = new AutomationCheckStore(db);
  slot.checkStore = checkStore;
});
afterEach(() => {
  SessionAdmissionService._resetForTesting();
  SessionAdmissionStore._resetForTesting();
  _resetInstanceProviderLimitHandlerForTesting();
  slot.db = null;
  slot.checkStore = null;
  db.close();
  rmSync(slot.directory, { recursive: true, force: true });
});
describe('checked thread baseline authority through actual communication', () => {
  it.each(['accepted', 'known-limit', 'unhandled', 'handled-late-limit'] as const)('%s: actual communication, runner, and persisted next tick', async (mode) => {
    let now = 1000;
    const instance = createInstance({ workingDirectory: slot.directory, provider: 'gemini' });
    instance.id = 'target';
    instance.status = 'idle';
    const adapter = new GeminiCliAdapter();
    const limit = getInstanceProviderLimitHandler();
    let parkedOnce = false;
    const scheduledPrompts: unknown[] = [];
    const resumedPrompts: string[] = [];
    limit.configure({ isEnabled: () => true, setWaitReason: (_id, reason) => { instance.waitReason = reason ?? undefined; },
      resendInput: (_id, prompt) => { resumedPrompts.push(prompt); }, getQuotaSnapshot: () => null,
      getWorkspaceCwd: () => slot.directory, scheduleResume: ({ request }) => { scheduledPrompts.push(request.resumePrompt); return () => undefined; } });
    const adapterSend = vi.spyOn(adapter, 'sendInput').mockImplementation(async (_message, _attachments, options) => {
      options?.dispatch?.beforeProviderDispatch?.();
      if (mode === 'handled-late-limit') {
        // A recognized limit plus a reset hint exercises actual park handling.
        throw new Error('429 RESOURCE_EXHAUSTED: quota exceeded; retry in 1 minute');
      }
      if (mode === 'unhandled') {
        throw new Error('inert provider refusal');
      }
    });
    const communication = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false,
      queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined,
      ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined,
      ...createProviderLimitCommunicationCallbacks(() => instance),
      refreshAdapterRuntimeConfig: async () => {
        if (mode === 'known-limit' && !parkedOnce) {
          parkedOnce = true;
          expect(limit.maybePark({ instanceId: instance.id, provider: 'gemini', resetAtHint: Date.now() + 60000,
            reason: 'inert unrelated existing turn', resumePrompt: 'old parked work' })).toBe('parked');
        }
      },
    });
    const sendInput = vi.fn(async (id: string, message: string, attachments: Parameters<InstanceManager['sendInput']>[2], options?: InstanceSendInputOptions) => communication.sendInput(id, message, attachments, null, options));
    const manager = Object.assign(new EventEmitter(), { sendInput, getInstance: () => instance, getAdapter: () => adapter, createInstance: vi.fn(async () => { throw new Error('unexpected fresh instance'); }) });
    const admission = getSessionAdmissionService();
    admission.setInstanceManager(manager);
    const admitSpy = vi.spyOn(admission, 'admitAutomatedWrite');
    const revival = { revive: async () => ({ status: 'live', instanceId: instance.id }) } as unknown as ConstructorParameters<typeof ThreadWakeupRunner>[1];
    const runner = new AutomationRunner(store, getAutomationEvents(), () => now, (_manager, automationStore, clock) => new ThreadWakeupRunner(manager as unknown as InstanceManager, revival, automationStore, clock), 1, 100, () => ({ automationDefaultCli: 'gemini', automationDefaultModel: '', modelPickerFavorites: [] }), undefined, async (_run, _store, dispatch) => dispatch());
    runner.initialize(manager as unknown as InstanceManager);
    const automation = await store.create({ name: 'Checked thread receipt probe', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' }, destination: { kind: 'thread', instanceId: instance.id, reviveIfArchived: false }, action: { prompt: 'Report changes', workingDirectory: slot.directory, provider: 'gemini', preCheck: { command: "printf 'new\\n'" } } }, 1000, 100);
    checkStore.setPending(automation.id, 'seed', hash('old\n'), 'old\n');
    checkStore.promotePending('seed', 500);
    const first = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: now });
    const firstRow = store.getRun(first.run!.id)!;
    const firstState = checkStore.getState(automation.id)!;
    expect(admitSpy.mock.results[0]?.value.kind).toBe('admitted');
    if (mode === 'known-limit') {
      expect(limit.isParked(instance.id)).toBe(true);
      expect(scheduledPrompts).toEqual(['old parked work']);
      expect(limit.resumeNow(instance.id)).toBe(true);
      expect(resumedPrompts).toEqual(['old parked work']);
      expect(instance.waitReason).toBeUndefined();
      expect(firstRow.threadPromptDelivered).toBe(false);
      expect(firstRow.status).toBe('succeeded');
      expect(adapterSend).not.toHaveBeenCalled();
    }
    now = 2000;
    const second = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: now });
    const secondRow = store.getRun(second.run!.id)!;
    if (mode === 'handled-late-limit') {
      expect(firstRow.status).toBe('succeeded');
      expect(firstRow.threadPromptDelivered).toBeNull();
      expect(firstState.baselineHash).toBe(hash('new\n'));
      expect(secondRow.outcome).toBe('no-change');
      expect(adapterSend).toHaveBeenCalledTimes(1);
      expect(scheduledPrompts).toHaveLength(1);
    } else if (mode === 'accepted') {
      expect(firstRow.threadPromptDelivered).toBe(true);
      expect(firstState.baselineHash).toBe(hash('new\n'));
      expect(secondRow.outcome).toBe('no-change');
      expect(sendInput).toHaveBeenCalledTimes(1);
    } else if (mode === 'unhandled') {
      expect(firstRow.status).toBe('failed');
      expect(firstState.baselineHash).toBe(hash('old\n'));
      expect(secondRow.outcome).toBe('changed');
      expect(sendInput).toHaveBeenCalledTimes(2);
    } else {
      expect(firstRow.threadPromptDelivered).toBe(false);
      expect(adapterSend).toHaveBeenCalledTimes(1);
      expect(secondRow.threadPromptDelivered).toBe(true);
      expect(firstState.pendingRunId).toBeNull();
      expect(firstState.baselineHash, 'undelivered changed check must retain old successful baseline').toBe(hash('old\n'));
      expect(secondRow.outcome, 'next identical tick must still see unprocessed change').toBe('changed');
      expect(sendInput, 'next tick must re-attempt the previously undelivered change').toHaveBeenCalledTimes(2);
    }
    if (mode === 'known-limit') {
      expect(checkStore.getState(automation.id)?.baselineHash).toBe(hash('new\n'));
      now = 3000;
      const third = await runner.fire(automation.id, { trigger: 'scheduled', scheduledAt: now });
      expect(store.getRun(third.run!.id)?.outcome).toBe('no-change');
      expect(sendInput).toHaveBeenCalledTimes(2);
      expect(adapterSend).toHaveBeenCalledTimes(1);
    }
  });
});
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({
    getRawDb: () => {
      if (!slot.db) throw new Error('Test database not initialized');
      return slot.db;
    },
  }),
}));
function terminalHost(): AutomationTerminalRunHost {
  return {
    events: getAutomationEvents(),
    store,
    retryScheduler: null,
    now: () => 2000,
    isOneTimeRun: () => false,
    notifyAutoDisabled: vi.fn(),
    emitAutomationState: vi.fn(),
    untrackInstances: vi.fn(),
    promotePendingIfAny: async () => undefined,
    baseRetryDelayMs: 100,
  };
}
async function pendingRun(destination: AutomationDestination = { kind: 'thread', instanceId: 'target', reviveIfArchived: false }, systemAction?: AutomationAction['systemAction']) {
  const automation = await store.create({
    name: 'Checked terminal boundary',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    destination,
    action: { prompt: 'Report changes', workingDirectory: slot.directory, systemAction, preCheck: { command: "printf 'new\\n'" } },
  }, 1000, 100);
  checkStore.setPending(automation.id, 'seed', hash('old\n'), 'old\n');
  checkStore.promotePending('seed', 500);
  const decision = store.decideAndInsertRun(automation, 'scheduled', 1000, 1000, { maxAttempts: 3, attempt: 1 });
  if (decision.kind !== 'started')
    throw new Error('Expected owned run');
  store.attachInstance(decision.run.id, 'target', 1000);
  checkStore.setPending(automation.id, decision.run.id, hash('new\n'), 'new\n');
  return store.getRun(decision.run.id)!;
}
function finish(run: AutomationRun, status: 'succeeded' | 'skipped' | 'failed' = 'succeeded'): AutomationRun {
  const terminal = store.terminalizeRun(run.id, status, status === 'failed' ? 'transient transport error' : undefined, undefined, 2000);
  if (!terminal)
    throw new Error('Expected terminal run');
  return terminal;
}
describe('checked terminal receipt compatibility', () => {
  it.each([true, false, null, undefined] as const)('ordinary succeeded thread receipt %s preserves its baseline authority', async (receipt) => {
    const run = await pendingRun();
    const terminal = { ...finish(run), threadPromptDelivered: receipt };
    handleTerminalRun(terminalHost(), terminal);
    expect(checkStore.getState(run.automationId)).toMatchObject({
      baselineHash: hash(receipt === false ? 'old\n' : 'new\n'), pendingRunId: null,
    });
    expect(store.getRun(run.id)?.status).toBe('succeeded');
  });
  it('new-instance success is independent of thread delivery evidence', async () => {
    const run = await pendingRun({ kind: 'newInstance' });
    handleTerminalRun(terminalHost(), { ...finish(run), threadPromptDelivered: false });
    expect(checkStore.getState(run.automationId)?.baselineHash).toBe(hash('new\n'));
  });
  it('an already-working system resume still succeeds and promotes without a new prompt', async () => {
    const run = await pendingRun(undefined, { type: 'instanceProviderLimitResume', instanceId: 'target' });
    const instance = createInstance({ workingDirectory: slot.directory });
    instance.id = 'target';
    instance.status = 'busy';
    const sendInput = vi.fn();
    const thread = new ThreadWakeupRunner({
      sendInput, getInstance: () => instance,
      interruptInstance: vi.fn(() => false), waitForInstanceSettled: vi.fn(async () => instance),
      on: vi.fn(), off: vi.fn(),
    }, {
      revive: async () => ({ status: 'live', instanceId: instance.id }),
    } as ConstructorParameters<typeof ThreadWakeupRunner>[1], store);
    const automation = (await store.get(run.automationId))!;
    const terminal = await thread.fireThreadWakeup({ run, automation, destination: { kind: 'thread', instanceId: instance.id, reviveIfArchived: false } });
    expect(terminal.threadPromptDelivered).toBe(false);
    expect(terminal.status).toBe('succeeded');
    expect(sendInput).not.toHaveBeenCalled();
    handleTerminalRun(terminalHost(), terminal);
    expect(checkStore.getState(run.automationId)?.baselineHash).toBe(hash('new\n'));
  });
  it('a stale no-delivery terminal cannot clear a newer pending capture', async () => {
    const run = await pendingRun();
    checkStore.setPending(run.automationId, 'newer-run', hash('newer\n'), 'newer\n');
    handleTerminalRun(terminalHost(), { ...finish(run), threadPromptDelivered: false });
    expect(checkStore.getState(run.automationId)).toMatchObject({
      baselineHash: hash('old\n'), pendingRunId: 'newer-run', pendingHash: hash('newer\n'),
    });
  });
  it('late run-scoped evidence stays monotonic and cannot consume a newer pending capture', async () => {
    const run = await pendingRun();
    store.markThreadPromptAttempt(run.id, 'target', true);
    handleTerminalRun(terminalHost(), finish(run));
    checkStore.setPending(run.automationId, 'newer-run', hash('newer\n'), 'newer\n');
    expect(store.markThreadPromptDelivered(run.id, 'wrong-target')).toBeNull();
    expect(store.markThreadPromptDelivered('missing-run', 'target')).toBeNull();
    expect(store.markThreadPromptDelivered(run.id, 'target')?.threadPromptDelivered).toBe(true);
    store.markThreadPromptAttempt(run.id, 'target', true);
    store.markThreadPromptAttempt(run.id, 'target', false);
    expect(store.getRun(run.id)?.threadPromptDelivered).toBe(true);
    expect(checkStore.getState(run.automationId)).toMatchObject({ baselineHash: hash('old\n'), pendingRunId: 'newer-run' });
  });
  it('a retry keeps its capture until the successor owns it and confirms delivery', async () => {
    const run = await pendingRun();
    const host = terminalHost();
    host.retryScheduler = vi.fn();
    const failed = finish(run, 'failed');
    handleTerminalRun(host, failed);
    expect(host.retryScheduler).toHaveBeenCalledOnce();
    expect(checkStore.getState(run.automationId)?.pendingRunId).toBe(run.id);
    const retry = store.insertRetryRun(failed, 2, 3, 3000, 3000)!;
    expect(checkStore.getState(run.automationId)?.pendingRunId).toBe(retry.id);
    store.attachInstance(retry.id, 'target', 3000);
    store.markThreadPromptDelivered(retry.id, 'target', 3000);
    handleTerminalRun(terminalHost(), finish(retry));
    expect(checkStore.getState(run.automationId)).toMatchObject({ baselineHash: hash('new\n'), pendingRunId: null });
  });
  it('a skipped run with later delivery evidence does not acquire succeeded baseline authority', async () => {
    const run = await pendingRun();
    store.markThreadPromptDelivered(run.id, 'target');
    handleTerminalRun(terminalHost(), finish(run, 'skipped'));
    expect(checkStore.getState(run.automationId)).toMatchObject({ baselineHash: hash('old\n'), pendingRunId: null });
  });
});
