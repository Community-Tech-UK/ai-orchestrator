import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import { AutomationRunSchema, AutomationUpdatePayloadSchema } from '@contracts/schemas/automation';
import type { input } from 'zod';
import type { IpcResponse } from '../../../shared/types/ipc.types';
import type { Automation } from '../../../shared/types/automation.types';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { AutomationStore } from '../../automations/automation-store';
import type { AutomationAttachmentService } from '../../automations/automation-attachment-service';
import { computeNextFireAt } from '../../automations/automation-schedule';

type Handler = (event: unknown, payload: unknown) => Promise<IpcResponse>;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  store: null as AutomationStore | null,
  schedule: vi.fn(), emitChanged: vi.fn(), handlePastOneTime: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) } }));
vi.mock('../../automations', async () => ({
  computeNextFireAt: (await import('../../automations/automation-schedule')).computeNextFireAt,
  getAutomationStore: () => mocks.store,
  getAutomationRunner: () => ({}),
  getAutomationScheduler: () => ({ schedule: mocks.schedule }),
}));
vi.mock('../../automations/automation-events', () => ({ getAutomationEvents: () => ({ emitChanged: mocks.emitChanged }) }));
vi.mock('../../automations/automation-create-service', () => ({
  createAutomationWithScheduling: vi.fn(), handlePastOneTimeAutomation: mocks.handlePastOneTime,
}));
vi.mock('../../security/task-preflight-service', () => ({ getTaskPreflightService: vi.fn() }));
vi.mock('../../automations/automation-templates', () => ({ listAutomationTemplates: vi.fn() }));

import { registerAutomationHandlers } from './automation-handlers';

describe('automation form scheduling', () => {
  const now = 1_700_000_000_000;
  let db: SqliteDriver;
  let store: AutomationStore;
  let automation: Automation;
  const slowedNextFireAt = now + 4 * 60 * 60_000;

  beforeEach(async () => {
    vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); mocks.handlers.clear();
    db = defaultDriverFactory(':memory:'); db.pragma('foreign_keys = ON');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    mocks.store = store;
    automation = await store.create({ name: 'Monitor', schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check status', workingDirectory: '/repo', slowWhenUnchanged: true } }, slowedNextFireAt, now);
    db.prepare(`INSERT INTO automation_monitor_state(automation_id, unchanged_checks, interval_multiplier, quiet_runs)
      VALUES (?, 4, 4, 10)`).run(automation.id);
    registerAutomationHandlers();
  });
  afterEach(() => { db.close(); mocks.store = null; vi.useRealTimers(); });

  async function update(updates: input<typeof AutomationUpdatePayloadSchema>['updates']): Promise<Automation> {
    const handler = mocks.handlers.get(IPC_CHANNELS.AUTOMATION_UPDATE);
    if (!handler) throw new Error('Update handler not registered');
    const response = await handler(undefined, { id: automation.id, updates });
    expect(response.success).toBe(true);
    return response.data as Automation;
  }

  it.each([
    { name: 'Renamed monitor' },
    { dismissModelHint: true as const },
    { action: { prompt: 'Check a different status', workingDirectory: '/repo', slowWhenUnchanged: true } },
  ])('preserves the slowed next fire on an ordinary save: %j', async updates => {
    const result = await update(updates);
    expect(result.nextFireAt).toBe(slowedNextFireAt);
    expect((await store.get(automation.id))?.nextFireAt).toBe(slowedNextFireAt);
    expect(mocks.schedule).toHaveBeenCalledWith(expect.objectContaining({ nextFireAt: slowedNextFireAt }));
    if ('dismissModelHint' in updates) expect(result.monitorState?.modelHintDismissed).toBe(true);
  });

  it('preserves the slowed time when the full form resubmits the unchanged schedule and action', async () => {
    const result = await update({ schedule: { ...automation.schedule }, trigger: { ...automation.trigger },
      enabled: true, active: true, action: { ...automation.action } });
    expect(result.nextFireAt).toBe(slowedNextFireAt);
  });

  it('recalculates after a meaningful schedule change', async () => {
    const schedule = { type: 'cron' as const, expression: '*/15 * * * *', timezone: 'UTC' };
    expect((await update({ schedule })).nextFireAt).toBe(computeNextFireAt(schedule, now));
  });

  it.each(['enabled', 'active'] as const)('clears the time on %s=false and recalculates on reactivation', async field => {
    expect((await update({ [field]: false })).nextFireAt).toBeNull();
    expect((await update({ [field]: true })).nextFireAt).toBe(computeNextFireAt(automation.schedule, now));
  });

  it('does not replay a consumed one-time job when dismissing its model hint', async () => {
    await store.update(automation.id, { schedule: { type: 'oneTime', runAt: now - 60_000 }, missedRunPolicy: 'runOnce' }, null, now);
    expect((await update({ dismissModelHint: true })).nextFireAt).toBeNull();
    expect(mocks.handlePastOneTime).not.toHaveBeenCalled();
  });

  it('does not replay a consumed one-time job on an unchanged full-form save', async () => {
    const consumed = await store.update(automation.id,
      { schedule: { type: 'oneTime', runAt: now - 60_000 }, missedRunPolicy: 'runOnce' }, null, now);
    expect((await update({ schedule: consumed.schedule, action: consumed.action, enabled: true })).nextFireAt).toBeNull();
    expect(mocks.handlePastOneTime).not.toHaveBeenCalled();
  });

  it('sends the saved retry time through the run-list contract and clears it when no retry remains', async () => {
    const decision = store.decideAndInsertRun(automation, 'manual', now, now);
    if (decision.kind !== 'started') throw new Error('Expected a running fixture');
    store.failRunningRuns('Interrupted by an app restart', now);
    const handler = mocks.handlers.get(IPC_CHANNELS.AUTOMATION_LIST_RUNS);
    if (!handler) throw new Error('List-runs handler not registered');
    const response = await handler(undefined, { automationId: automation.id });
    expect(response.success).toBe(true);
    const runs = response.data as unknown[];
    expect(AutomationRunSchema.parse(runs[0])).toMatchObject({ nextRetryAt: now + 15_000 });
    store.clearPendingRetry(decision.run.id);
    const cleared = await handler(undefined, { automationId: automation.id });
    expect(AutomationRunSchema.parse((cleared.data as unknown[])[0])).toMatchObject({ nextRetryAt: null });
  });
});
