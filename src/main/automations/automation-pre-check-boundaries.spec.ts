import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../shared/types/ipc.types';
import type { Automation, ClaimedAutomationRun } from '../../shared/types/automation.types';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationCheckStore } from './automation-check-store';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { registerAutomationHandlers } from '../ipc/handlers/automation-handlers';
import { runAutomationPreCheckGate } from './automation-pre-check-gate';
import * as preCheck from './automation-pre-check';

const state = vi.hoisted(() => ({
  root: '', store: null as AutomationStore | null, checks: null as AutomationCheckStore | null,
  handlers: new Map<string, (_event: unknown, payload: unknown) => Promise<IpcResponse>>(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => state.root },
  ipcMain: { handle: (channel: string, handler: never) => state.handlers.set(channel, handler) },
}));
vi.mock('./index', () => ({
  getAutomationStore: () => state.store,
  getAutomationRunner: () => ({ untrackInstances: vi.fn(), fire: vi.fn() }),
  getAutomationScheduler: () => ({ schedule: vi.fn(), deactivate: vi.fn() }),
  computeNextFireAt: () => Date.now() + 3_600_000,
}));
vi.mock('./automation-check-store', async importOriginal => ({
  ...await importOriginal<typeof import('./automation-check-store')>(),
  getAutomationCheckStore: () => state.checks,
}));
vi.mock('./automation-create-service', () => ({
  createAutomationWithScheduling: async (input: Parameters<AutomationStore['create']>[0]) =>
    state.store!.create(input, Date.now() + 3_600_000),
  handlePastOneTimeAutomation: vi.fn(),
}));
vi.mock('./automation-events', () => ({ getAutomationEvents: () => ({ emitChanged: vi.fn() }) }));
vi.mock('../security/task-preflight-service', () => ({ getTaskPreflightService: vi.fn() }));
vi.mock('../notifications/notification-service', () => ({ getNotificationService: () => ({ notify: vi.fn() }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

describe('automation check update and dispatch boundaries', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  const invoke = (channel: string, payload: unknown) => state.handlers.get(channel)!({}, payload);
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'automation-boundary-'));
    db = defaultDriverFactory(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = state.store = new AutomationStore(db, {
      prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [],
    } as unknown as AutomationAttachmentService);
    state.checks = new AutomationCheckStore(db);
    state.handlers.clear();
    registerAutomationHandlers();
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); rmSync(state.root, { recursive: true, force: true }); });
  async function seed() {
    const result = await invoke(IPC_CHANNELS.AUTOMATION_CREATE, {
      name: 'Checked boundary fixture', schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
      action: { prompt: 'Do the job', provider: 'codex', workingDirectory: state.root,
        preCheck: { command: 'printf precheck-placeholder' } },
    });
    expect(result.success).toBe(true);
    return result.data as Automation;
  }
  function claim(automation: Automation): ClaimedAutomationRun {
    const result = store.decideAndInsertRun(automation, 'scheduled', Date.now());
    if (result.kind !== 'started') throw new Error(`Expected a started fixture: ${result.kind}`);
    return { run: result.run, automation, snapshot: result.run.configSnapshot! };
  }
  const host = () => ({ store, now: Date.now, handleTerminalRun: vi.fn() });

  it('rejects an IPC contained patch that omits and inherits the existing host check', async () => {
    const original = await seed();
    const result = await invoke(IPC_CHANNELS.AUTOMATION_UPDATE, { id: original.id, updates: {
      action: { prompt: 'Do the job', provider: 'codex', workingDirectory: state.root, executionProfile: 'contained' },
    } });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('contained jobs cannot have one');
    expect((await store.get(original.id))!.action.executionProfile).toBeUndefined();
  });

  it('retains the permitted standard check and clears it only on an explicit undefined patch', async () => {
    const original = await seed();
    const standard = await invoke(IPC_CHANNELS.AUTOMATION_UPDATE, { id: original.id, updates: {
      action: { prompt: 'Edited prompt', workingDirectory: state.root, executionProfile: 'standard' },
    } });
    expect(standard.success).toBe(true);
    const spy = vi.spyOn(preCheck, 'runAutomationPreCheck');
    const current = (await store.get(original.id))!;
    const claimed = claim(current);
    expect(await runAutomationPreCheckGate(claimed, host())).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    expect(state.checks!.getState(original.id)?.pendingOutput).toBe('precheck-placeholder');
    const cleared = await invoke(IPC_CHANNELS.AUTOMATION_UPDATE, { id: original.id, updates: {
      action: { prompt: 'Edited prompt', workingDirectory: state.root, executionProfile: 'contained', preCheck: undefined },
    } });
    expect(cleared.success).toBe(true);
    expect((await store.get(original.id))!.action.preCheck).toBeUndefined();
    expect(db.prepare('SELECT action_json FROM automations WHERE id=?').get<{ action_json: string }>(original.id)!.action_json)
      .not.toContain('preCheck');
    spy.mockClear();
    claimed.snapshot.action = (await store.get(original.id))!.action;
    expect(await runAutomationPreCheckGate(claimed, host())).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a worker pin inherited alongside an existing local check, and allows an explicit clear', async () => {
    const original = await seed();
    const action = { prompt: 'Edited prompt', workingDirectory: state.root,
      forceNodeId: '11111111-2222-4333-8444-555555555555' };
    const refused = await invoke(IPC_CHANNELS.AUTOMATION_UPDATE, { id: original.id, updates: { action } });
    expect(refused.success).toBe(false);
    expect(refused.error?.message).toContain('this computer');
    expect((await store.get(original.id))!.action.forceNodeId).toBeUndefined();
    const cleared = await invoke(IPC_CHANNELS.AUTOMATION_UPDATE, { id: original.id, updates: {
      action: { ...action, preCheck: undefined },
    } });
    expect(cleared.success).toBe(true);
    expect((await store.get(original.id))!.action.forceNodeId).toBe(action.forceNodeId);
    expect((await store.get(original.id))!.action.preCheck).toBeUndefined();
  });

  it.each([{}, { prompt: 'Edited prompt' }])('rejects MCP oneTime updates with inherited checks: %j', async extra => {
    const original = await seed();
    const tools = createAutomationToolImplementations({
      store, scheduler: { schedule: vi.fn(), deactivate: vi.fn() }, runner: { untrackInstances: vi.fn() },
      events: { emitChanged: vi.fn() }, createWithScheduling: vi.fn(), handlePastOneTime: vi.fn(),
      resolveWorkingDirectory: () => state.root, resolveTimezone: () => 'UTC', now: Date.now,
    });
    await expect(tools.updateAutomation({ id: original.id, runAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra }))
      .rejects.toThrow(/recurring schedule/);
    expect((await store.get(original.id))!.schedule.type).toBe('cron');
  });

  it.each(['contained', 'oneTime', 'worker'] as const)('refuses invalid stored %s snapshots before any host shell call', async invalid => {
    const original = await seed();
    // Model a legacy/corrupt record: normal APIs must reject these writes.
    if (invalid === 'contained') db.prepare("UPDATE automations SET action_json=json_set(action_json,'$.executionProfile','contained') WHERE id=?").run(original.id);
    else if (invalid === 'worker') db.prepare("UPDATE automations SET action_json=json_set(action_json,'$.forceNodeId',?) WHERE id=?")
      .run('11111111-2222-4333-8444-555555555555', original.id);
    else db.prepare("UPDATE automations SET schedule_type='oneTime',schedule_json=? WHERE id=?")
      .run(JSON.stringify({ type: 'oneTime', runAt: Date.now() }), original.id);
    const claimed = claim((await store.get(original.id))!);
    const spy = vi.spyOn(preCheck, 'runAutomationPreCheck');
    const terminal = host();
    expect(await runAutomationPreCheckGate(claimed, terminal)).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(store.getRun(claimed.run.id)?.status).toBe('failed');
    expect(terminal.handleTerminalRun).toHaveBeenCalledWith(expect.anything(), { retryable: false });
  });
});
