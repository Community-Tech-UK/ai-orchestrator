import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { AutomationStore } from './automation-store';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import type { AutomationCallerAuthority } from './automation-agent-authority';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { CreateAutomationInput } from '../../shared/types/automation.types';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

const NOW = Date.UTC(2026, 9, 31, 12);
describe('authenticated automation execution transitions', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let impl: ReturnType<typeof createAutomationToolImplementations>;
  let caller: AutomationCallerAuthority | undefined;
  let scheduled: string[];
  let settled: string[];

  beforeEach(() => {
    db = rlmTemplate.open();
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    resetAutomationEventsForTesting();
    caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false };
    scheduled = []; settled = [];
    impl = createAutomationToolImplementations({ store,
      scheduler: { schedule: job => { scheduled.push(job.id); }, deactivate: () => undefined },
      runner: { untrackInstances: () => undefined }, events: getAutomationEvents(),
      createWithScheduling: input => store.create(input, NOW + 600_000, NOW),
      handlePastOneTime: async job => { settled.push(job.id); },
      resolveCaller: id => id === 'caller' ? caller : undefined,
      resolveWorkingDirectory: () => '/repo', resolveTimezone: () => 'UTC', now: () => NOW });
  });
  afterEach(() => { resetAutomationEventsForTesting(); db.close(); });

  function update(args: Record<string, unknown>, id: string | null = 'caller') {
    return createAutomationToolDefinitions({ instanceId: id, ...impl })
      .find(tool => tool.name === 'update_automation')!.handler({ confirmedByUser: true, ...args }); // authority cases, not cadence
  }
  function postpone(args: Record<string, unknown>) {
    return createAutomationToolDefinitions({ instanceId: 'caller', ...impl })
      .find(tool => tool.name === 'postpone_automation')!.handler(args);
  }
  function seed(patch: Partial<CreateAutomationInput> = {}, next = NOW + 600_000) {
    return store.create({ name: 'Human job', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check server', workingDirectory: '/repo', provider: 'claude', model: 'opus', reasoningEffort: 'max', yoloMode: true },
      ...patch }, patch.enabled === false ? null : next, NOW);
  }

  it.each([{ model: 'opus' }, { reasoningEffort: 'max' as const }, { yoloMode: true }])(
    'refuses reactivation above the real caller ceiling %j without an action patch', async higher => {
      const job = await seed({ enabled: false, action: { prompt: 'Check', workingDirectory: '/repo',
        provider: 'claude', model: 'sonnet', reasoningEffort: 'low', yoloMode: false, ...higher } });
      await expect(update({ id: job.id, enabled: true })).rejects.toThrow(/calling session/);
      expect(await store.get(job.id)).toMatchObject({ enabled: false, nextFireAt: null, action: job.action });
      expect(scheduled).toEqual([]);
      expect(settled).toEqual([]);
    });

  it.each([
    { cron: '* * * * *' }, { runAt: new Date(NOW + 60_000).toISOString() },
    { timezone: 'Europe/London' }, { missedRunPolicy: 'runOnce' }, { concurrencyPolicy: 'queue' },
  ])('refuses work-triggering scheduling changes under inherited higher authority %j', async patch => {
    const job = await seed();
    await expect(update({ id: job.id, ...patch })).rejects.toThrow(/calling session/);
    expect(await store.get(job.id)).toEqual(job);
    expect(scheduled).toEqual([]);
    expect(settled).toEqual([]);
  });

  it('keeps operator authority and a postponed fire time on harmless metadata and policy reductions', async () => {
    const job = await seed({ concurrencyPolicy: 'queue', missedRunPolicy: 'runOnce' }, NOW + 3_600_000);
    caller = undefined;
    await update({ id: job.id, name: 'Renamed', description: 'Operator note', hidden: true,
      missedRunPolicy: 'skip', concurrencyPolicy: 'skip' });
    expect(await store.get(job.id)).toMatchObject({ name: 'Renamed', description: 'Operator note', hidden: true,
      action: job.action, nextFireAt: NOW + 3_600_000, missedRunPolicy: 'skip', concurrencyPolicy: 'skip' });
    expect(settled).toEqual([]);
  });

  it('allows a lower caller to disable and edit the schedule while the higher-authority job stays disabled', async () => {
    const job = await seed();
    await update({ id: job.id, enabled: false, cron: '* * * * *' });
    await update({ id: job.id, runAt: new Date(NOW + 60_000).toISOString() });
    expect(await store.get(job.id)).toMatchObject({ enabled: false, nextFireAt: null, action: job.action,
      schedule: { type: 'oneTime', runAt: NOW + 60_000 } });
    expect(settled).toEqual([]);
  });

  it('allows lowering authority and reactivation together and pins effective inherited limits', async () => {
    const job = await seed({ enabled: false });
    await update({ id: job.id, enabled: true, model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
    expect(await store.get(job.id)).toMatchObject({ enabled: true, nextFireAt: NOW + 600_000,
      action: { executionAuthority: { provider: 'claude', model: 'sonnet', modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false } } });
  });

  it('pins safe inherited limits when resuming or rescheduling without an action patch', async () => {
    const job = await seed({ enabled: false, action: { prompt: 'Check', workingDirectory: '/repo' } });
    await update({ id: job.id, enabled: true });
    caller = { provider: 'claude', currentModel: 'opus', reasoningEffort: 'max', yoloMode: true };
    await update({ id: job.id, cron: '* * * * *' });
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: NOW + 60_000,
      action: { model: 'sonnet', reasoningEffort: 'low', yoloMode: false,
        executionAuthority: { modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false } } });
  });

  it('allows unchanged scheduling fields without resetting a human postponement', async () => {
    const job = await seed({}, NOW + 3_600_000);
    caller = undefined;
    await update({ id: job.id, enabled: true, cron: '*/10 * * * *', timezone: 'UTC' });
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: NOW + 3_600_000, action: job.action });
    expect(settled).toEqual([]);
  });

  it.each(['cron', 'oneTime'] as const)('does not let postpone bring higher-authority %s work forward', async type => {
    const job = await seed(type === 'oneTime' ? { schedule: { type, runAt: NOW + 600_000, timezone: 'UTC' } } : {});
    await expect(postpone({ id: job.id, untilIso: new Date(NOW + 60_000).toISOString() })).rejects.toThrow(/calling session/);
    expect(await store.get(job.id)).toEqual(job);
  });

  it('allows postponing higher-authority work later without changing its authority', async () => {
    const job = await seed();
    caller = undefined;
    await postpone({ id: job.id, delayMinutes: 10 });
    expect(await store.get(job.id)).toMatchObject({ nextFireAt: NOW + 1_200_000, action: job.action });
  });

  it.each(['missing', null])('refuses unresolved authenticated reactivation (%s)', async id => {
    const job = await seed({ enabled: false });
    await expect(update({ id: job.id, enabled: true }, id)).rejects.toThrow(/calling session/);
    expect((await store.get(job.id))?.enabled).toBe(false);
  });

  it('lets a Codex session on gpt-6.1-sol rewrite the prompt of a gpt-6.1-sol job', async () => {
    const job = await seed({ action: { prompt: 'Old search', workingDirectory: '/repo', provider: 'codex',
      model: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    caller = { provider: 'codex', currentModel: 'gpt-6.1-sol', reasoningEffort: 'high', yoloMode: false };
    await update({ id: job.id, prompt: 'New search' });
    expect(await store.get(job.id)).toMatchObject({ action: { prompt: 'New search', provider: 'codex', model: 'gpt-6.1-sol',
      executionAuthority: { model: 'gpt-6.1-sol', modelTier: 'powerful', reasoningEffort: 'medium' } } });
  });

  it('still refuses a balanced Codex session editing a gpt-6.1-sol job', async () => {
    const job = await seed({ action: { prompt: 'Old search', workingDirectory: '/repo', provider: 'codex',
      model: 'gpt-6.1-sol', reasoningEffort: 'medium' } });
    caller = { provider: 'codex', currentModel: 'gpt-5.6-terra', reasoningEffort: 'high', yoloMode: false };
    await expect(update({ id: job.id, prompt: 'New search' })).rejects.toThrow(/model above the calling session/);
    expect(await store.get(job.id)).toEqual(job);
  });

  it('names a job model whose tier Harness does not know', async () => {
    const job = await seed({ action: { prompt: 'Old search', workingDirectory: '/repo', provider: 'codex',
      model: 'gpt-9-unlisted', reasoningEffort: 'medium' } });
    caller = { provider: 'codex', currentModel: 'gpt-5.6-sol', reasoningEffort: 'high', yoloMode: false };
    await expect(update({ id: job.id, prompt: 'New search' })).rejects.toThrow(/job's model "gpt-9-unlisted" is not in Harness's model list/);
  });

  it('leaves human reactivation and schedule updates unrestricted', async () => {
    const job = await seed({ enabled: false });
    await impl.updateAutomation({ id: job.id, enabled: true, cron: '* * * * *', confirmedByUser: true });
    expect(await store.get(job.id)).toMatchObject({ enabled: true, action: job.action, nextFireAt: NOW + 60_000 });
  });
});
