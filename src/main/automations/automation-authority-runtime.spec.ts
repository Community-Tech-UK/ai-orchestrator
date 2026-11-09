import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import type { AutomationCallerAuthority } from './automation-agent-authority';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { CreateAutomationInput, AutomationAction } from '../../shared/types/automation.types';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { getDefaultAgent } from '../../shared/types/agent.types';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import { resolveSpawnReasoningEffort } from '../instance/lifecycle/reasoning-effort-resolution';
import type { InstanceManager } from '../instance/instance-manager';

const settings = vi.hoisted(() => ({ automationDefaultCli: 'claude' as const, automationDefaultModel: 'sonnet', modelPickerFavorites: ['claude:sonnet'] }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => settings }) }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-authority-runtime' } }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: vi.fn() }) }));

const NOW = Date.UTC(2026, 9, 20, 12);
describe('automation caller authority through MCP, persistence and real spawn defaults', () => {
  let db: SqliteDriver;
  let store: AutomationStore;
  let caller: AutomationCallerAuthority | undefined;
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    settings.automationDefaultModel = 'sonnet'; settings.modelPickerFavorites = ['claude:sonnet'];
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false };
    resetAutomationEventsForTesting();
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); db.close(); });
  function tools(callerInstanceId: string | null = 'caller') {
    const impl = createAutomationToolImplementations({ store, scheduler: { schedule: vi.fn(), deactivate: vi.fn() },
      runner: { untrackInstances: vi.fn() }, events: getAutomationEvents(),
      createWithScheduling: (input: CreateAutomationInput) => store.create(input, NOW + 600_000),
      handlePastOneTime: async () => undefined, resolveCaller: id => id === 'caller' ? caller : undefined,
      resolveWorkingDirectory: () => '/repo', resolveTimezone: () => 'UTC', now: () => NOW });
    return createAutomationToolDefinitions({ instanceId: callerInstanceId, ...impl });
  }
  async function invoke(name: string, args: Record<string, unknown>, id: string | null = 'caller') {
    // These cases are about authority, not how often a job runs, so the person has confirmed the cadence.
    const confirmed = name === 'create_automation' || name === 'update_automation' ? { confirmedByUser: true, ...args } : args;
    return tools(id).find(tool => tool.name === name)!.handler(confirmed);
  }
  async function seed(action: Partial<AutomationAction> = {}) {
    return store.create({ name: 'Existing job', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Original instructions', workingDirectory: '/repo', provider: 'claude', model: 'sonnet', reasoningEffort: 'low', yoloMode: false, ...action } }, NOW + 600_000);
  }
  async function spawn(id: string) {
    let spawned: Instance | undefined;
    const manager = Object.assign(new EventEmitter(), {
      createInstance: async (config: InstanceCreateConfig) => {
        spawned = buildInstanceRecord(config, getDefaultAgent(), { defaultYoloMode: true, getParent: () => undefined });
        spawned.reasoningEffort = resolveSpawnReasoningEffort(config, spawned.provider, spawned.currentModel);
        spawned.status = 'busy';
        return spawned;
      },
      getInstance: () => spawned, terminateInstance: async () => undefined,
    });
    const runner = new AutomationRunner(store, getAutomationEvents(), () => Date.now(), vi.fn(), undefined, undefined,
      () => settings, () => false, async (_r, _s, dispatch) => { await dispatch(); });
    runner.initialize(manager as unknown as InstanceManager);
    await runner.fire(id, { trigger: 'manual' });
    return spawned!;
  }

  it('inherits an auto-approving caller when auto-approval is omitted, so unattended runs can use tools', async () => {
    caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: true };
    await invoke('create_automation', { name: 'Record connector result', prompt: 'Edit the register', runAt: new Date(NOW + 3_600_000).toISOString() });
    const [job] = await store.list();
    expect(job.action).toMatchObject({ yoloMode: true, executionAuthority: { yoloMode: true } });
    expect((await spawn(job.id)).yoloMode).toBe(true);
  });

  it('pins omitted auto-approval before saving, even when instance creation defaults it on', async () => {
    await invoke('create_automation', { name: 'Monitor status', prompt: 'Check status', cron: '*/10 * * * *' });
    const [job] = await store.list();
    const instance = await spawn(job.id);
    expect(instance.yoloMode).toBe(false);
    expect(job.action.yoloMode).toBe(false);
    expect(instance).toMatchObject({ currentModel: 'sonnet', reasoningEffort: 'low' });
  });

  it('pins omitted model and effort during instruction replacement before favourites change', async () => {
    caller!.reasoningEffort = 'high';
    const job = await seed({ model: undefined, reasoningEffort: undefined, yoloMode: undefined });
    await invoke('update_automation', { id: job.id, prompt: 'Replacement instructions' });
    settings.automationDefaultModel = 'opus'; settings.modelPickerFavorites = ['claude:opus'];
    expect(await spawn(job.id)).toMatchObject({ currentModel: 'sonnet', reasoningEffort: 'high', yoloMode: false });
    expect((await store.get(job.id))?.action).toMatchObject({ model: 'sonnet', reasoningEffort: 'high', yoloMode: false });
  });

  it('pins omitted approval on a reused legacy job before returning the existing schedule', async () => {
    const job = await seed({ yoloMode: undefined });
    const result = await invoke('create_automation', { name: 'Monitor status', prompt: 'Original instructions', cron: '*/10 * * * *' });
    expect(result).toMatchObject({ id: job.id, reused: true });
    expect((await store.list())).toHaveLength(1);
    expect(await spawn(job.id)).toMatchObject({ yoloMode: false });
    expect((await store.get(job.id))?.action.yoloMode).toBe(false);
  });

  it('pins omitted approval when an agent persists an effort-only legacy action update', async () => {
    const job = await seed({ yoloMode: undefined });
    await invoke('update_automation', { id: job.id, reasoningEffort: 'low' });
    expect(await spawn(job.id)).toMatchObject({ yoloMode: false });
    expect((await store.get(job.id))?.action.yoloMode).toBe(false);
  });

  it.each([{ model: 'opus' }, { reasoningEffort: 'max' as const }, { yoloMode: true }])('refuses prompt-only replacement using inherited higher authority %j', async authority => {
    const job = await seed(authority);
    await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement instructions' })).rejects.toThrow(/calling session/);
    expect((await store.get(job.id))?.action).toEqual(job.action);
  });

  it('refuses working-directory replacement under inherited higher authority', async () => {
    const job = await seed({ yoloMode: true });
    await expect(invoke('update_automation', { id: job.id, workingDirectory: '/other' })).rejects.toThrow(/auto-approval/);
    expect((await store.get(job.id))?.action).toEqual(job.action);
  });

  it.each(['missing', null])('does not invent a caller for instruction replacement (%s)', async id => {
    const job = await seed();
    await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement instructions' }, id)).rejects.toThrow(/calling session/);
    expect((await store.get(job.id))?.action).toEqual(job.action);
  });

  it('rejects a failed caller lookup and preserves higher-authority jobs during benign metadata updates', async () => {
    const job = await seed({ model: 'opus', reasoningEffort: 'max', yoloMode: true });
    await invoke('update_automation', { id: job.id, name: 'New label', description: 'Operator note', hidden: true });
    expect((await store.get(job.id))?.action).toEqual(job.action);
    caller = undefined;
    await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement instructions' })).rejects.toThrow(/could not be resolved/);
    expect((await store.get(job.id))?.action).toEqual(job.action);
  });
  it.each([{ model: 'opus' }, { reasoningEffort: 'max' as const }, { yoloMode: true }])('refuses duplicate reuse with inherited higher authority %j', async patch => {
    const job = await seed(patch);
    await expect(invoke('create_automation', { name: 'Monitor status', prompt: 'Original instructions', cron: '*/10 * * * *' }))
      .rejects.toThrow(/calling session/);
    expect((await store.get(job.id))?.action).toEqual(job.action);
    expect(await store.list()).toHaveLength(1);
  });

  it('persists an explicit trusted tier when non-check creation omits all authority fields', async () => {
    await invoke('create_automation', { name: 'Write report', prompt: 'Write report', cron: '*/10 * * * *' });
    const [job] = await store.list();
    expect(job.action.executionAuthority).toEqual({ provider: 'claude', model: 'sonnet', modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false });
    expect(await spawn(job.id)).toMatchObject({ currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false });
  });

  it('does not raise a fast caller to the check-job Sonnet preference when fields are omitted', async () => {
    caller!.currentModel = 'haiku';
    await invoke('create_automation', { name: 'Monitor status', prompt: 'Check status', cron: '*/10 * * * *' });
    const [job] = await store.list();
    expect(await spawn(job.id)).toMatchObject({ currentModel: 'haiku', reasoningEffort: 'low', yoloMode: false });
  });

});
