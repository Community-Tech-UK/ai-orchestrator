import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMocks, makeHarness, makeFakeAdapter } from '../instance/__tests__/instance-lifecycle-source-diagnostics.fixture';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { getAutomationEvents, resetAutomationEventsForTesting } from './automation-events';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { AutomationCallerAuthority } from './automation-agent-authority';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { _setSettingsReaderForTesting } from '../cli/adapters/claude-env-pack';
import { attemptInstanceFailover } from '../instance/instance-failover';
import { AutomationRunSchema, AutomationSchema } from '@contracts/schemas/automation';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

const detection = vi.hoisted(() => ({ available: ['claude', 'codex'] }));
vi.mock('../cli/cli-detection', async importOriginal => ({
  ...await importOriginal<typeof import('../cli/cli-detection')>(),
  CliDetectionService: { getInstance: () => ({ detectAll: async () => ({
    available: detection.available.map(name => ({ name })), detected: [], unavailable: [], timestamp: new Date(),
  }) }) },
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));

const mocks = getMocks();
const NOW = Date.UTC(2026, 9, 20, 12);
describe('one-shot MCP authority through persistence, actual lifecycle and actual provider/model resolution', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let db: SqliteDriver;
  let store: AutomationStore;
  let harness: ReturnType<typeof makeHarness>;
  let caller: AutomationCallerAuthority | undefined;
  let spawned: Instance | undefined;
  let startup: Promise<void> | undefined;
  let runner: AutomationRunner;
  beforeEach(async () => {
    vi.clearAllMocks();
    detection.available = ['claude', 'codex'];
    const actualFactory = await vi.importActual<typeof import('../cli/adapters/adapter-factory')>('../cli/adapters/adapter-factory');
    mocks.resolveCliType.mockImplementation(actualFactory.resolveCliType);
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.getKnownModelsForCli.mockImplementation(async (provider: string) => provider === 'claude' ? ['sonnet', 'opus'] : ['gpt-5.6-sol']);
    mocks.settings.defaultModel = 'opus'; mocks.settings.defaultModelByProvider = {};
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false };
    spawned = undefined; startup = undefined;
    db = rlmTemplate.open();
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    harness = makeHarness(); resetAutomationEventsForTesting();
  });
  afterEach(() => { _setSettingsReaderForTesting(null); harness.manager.destroy(); db.close(); });
  async function invoke(name: string, args: Record<string, unknown>) {
    const impl = createAutomationToolImplementations({ store,
      scheduler: { schedule: vi.fn(), deactivate: vi.fn() }, runner: { untrackInstances: vi.fn() }, events: getAutomationEvents(),
      createWithScheduling: input => store.create(input, NOW + 600_000), handlePastOneTime: async () => undefined,
      resolveCaller: () => caller, resolveWorkingDirectory: () => '/missing-authority-fixture', resolveTimezone: () => 'UTC', now: () => NOW });
    // These cases are about authority and one-shot handling, not cadence, so the person has confirmed it.
    const confirmed = name === 'create_automation' || name === 'update_automation' ? { confirmedByUser: true, ...args } : args;
    return createAutomationToolDefinitions({ instanceId: 'caller', ...impl }).find(t => t.name === name)!.handler(confirmed);
  }
  async function createJob() {
    await invoke('create_automation', { name: 'Monitor status', prompt: 'Check status', cron: '*/10 * * * *' });
    return (await store.list())[0];
  }
  async function fire(id: string) {
    const manager = Object.assign(new EventEmitter(), {
      createInstance: async (config: InstanceCreateConfig) => {
        spawned = await harness.manager.createInstance(config); startup = spawned.readyPromise;
        return spawned;
      }, getInstance: (id: string) => harness.instances.get(id), terminateInstance: vi.fn(async () => undefined),
    });
    runner = new AutomationRunner(store, getAutomationEvents(), () => NOW, vi.fn(), undefined, undefined,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'opus', modelPickerFavorites: ['claude:opus'] }),
      () => false, async (_run, _store, dispatch) => { await dispatch(); });
    runner.initialize(manager as unknown as InstanceManager);
    await runner.fire(id, { trigger: 'manual' });
    await startup?.catch(() => undefined);
    return store.listRuns({ automationId: id })[0];
  }

  it('refuses actual Codex/powerful fallback when approved Sonnet becomes unavailable before dispatch', async () => {
    const job = await createJob();
    expect(job.action).toMatchObject({ provider: 'claude', model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
    caller = undefined; detection.available = ['codex'];
    const run = await fire(job.id);
    expect(mocks.createAdapter.mock.calls.map(([input]) => ({ provider: input.cliType, model: input.options.model }))).toEqual([]);
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/approved|authority/i) });
  });

  it('retains the trusted ceiling through response and run-snapshot validation before actual dispatch', async () => {
    const job = await createJob();
    expect(AutomationSchema.parse(job).action.executionAuthority).toEqual({ provider: 'claude', model: 'sonnet', modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false });
    const run = await fire(job.id);
    expect(AutomationRunSchema.parse(run).configSnapshot?.action.executionAuthority).toEqual(job.action.executionAuthority);
    expect(mocks.createAdapter.mock.calls[0][0]).toMatchObject({ cliType: 'claude', options: { model: 'sonnet', reasoningEffort: 'low', yoloMode: false } });
  });

  it('refuses provider availability changing during asynchronous startup', async () => {
    const job = await createJob();
    harness.initializeRlm.mockImplementationOnce(async () => { detection.available = ['codex']; });
    const run = await fire(job.id);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(run.status).toBe('failed');
  });

  it('refuses same-provider model degradation to a powerful default', async () => {
    const job = await createJob();
    mocks.getKnownModelsForCli.mockImplementation(async () => {
      mocks.settings.defaultModel = 'opus';
      return ['opus'];
    });
    const run = await fire(job.id);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/model|authority/i) });
  });

  it('normalizes a legitimate model alias before the actual resolver and pins native fallback away from global Opus', async () => {
    const job = await createJob();
    await invoke('update_automation', { id: job.id, model: 'Sonnet latest' });
    caller = undefined;
    _setSettingsReaderForTesting(key => key === 'claudeFallbackModel' ? 'opus' : undefined);
    const run = await fire(job.id);
    expect(run.status).toBe('running');
    const input = mocks.createAdapter.mock.calls[0][0];
    expect(input).toMatchObject({ cliType: 'claude', options: { model: 'sonnet', reasoningEffort: 'low', yoloMode: false } });
    const factory = await vi.importActual<typeof import('../cli/adapters/adapter-factory')>('../cli/adapters/adapter-factory');
    const native = factory.createClaudeAdapter(input.options);
    const args = Reflect.get(native, 'buildArgs').call(native) as string[];
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'low']));
    expect(args).not.toContain('--fallback-model');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it.each(['restart-fresh', 'wake'] as const)('enforces the original approval on actual %s recovery provider fallback', async mode => {
    const job = await createJob(); await fire(job.id);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
    const instance = spawned!;
    instance.status = 'idle';
    if (mode === 'wake') await harness.manager.hibernateInstance(instance.id);
    detection.available = ['codex'];
    const recovery = mode === 'wake' ? harness.manager.wakeInstance(instance.id) : harness.manager.restartFreshInstance(instance.id);
    await expect(recovery).rejects.toThrow();
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
  });

  it.each([{ model: 'opus' }, { reasoningEffort: 'high' }, { yoloMode: true }, { reasoningEffort: null }] as const)('refuses stronger actual runtime replacement %j', async desired => {
    const job = await createJob(); await fire(job.id);
    spawned!.status = 'idle';
    await expect(harness.manager.applyAccountHandoff(spawned!.id, { provider: 'claude', ...desired })).rejects.toThrow(/approved|authority/i);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit same-tier Codex selection through actual resolution', async () => {
    const job = await createJob();
    await invoke('update_automation', { id: job.id, provider: 'codex', model: 'gpt-5.6-terra' });
    caller = undefined;
    const run = await fire(job.id);
    expect(run.status).toBe('running');
    expect(mocks.createAdapter.mock.calls[0][0]).toMatchObject({ cliType: 'codex', options: {
      model: 'gpt-5.6-terra', reasoningEffort: 'low', yoloMode: false,
    } });
  });

  it('allows an actual catalogue fallback within the approved model tier', async () => {
    caller!.currentModel = 'opus'; caller!.reasoningEffort = 'high';
    const job = await createJob();
    await invoke('update_automation', { id: job.id, model: 'opus[1m]' });
    mocks.getKnownModelsForCli.mockResolvedValue(['opus']);
    const run = await fire(job.id);
    expect(run.status).toBe('running');
    expect(mocks.createAdapter.mock.calls[0][0]).toMatchObject({ cliType: 'claude', options: { model: 'opus' } });
  });

  it('normalizes the trusted caller alias as well as the scheduled model', async () => {
    caller!.currentModel = 'Sonnet latest';
    const job = await createJob(); await fire(job.id);
    expect(mocks.createAdapter.mock.calls[0][0].options.model).toBe('sonnet');
  });

  it('never adopts a prewarmed adapter whose approval cannot be attested', async () => {
    caller!.reasoningEffort = 'high';
    const job = await createJob();
    await invoke('update_automation', { id: job.id, reasoningEffort: 'high' });
    const warm = makeFakeAdapter();
    const consume = vi.fn(() => warm);
    harness.deps.warmStartManager = { consume, preWarm: vi.fn(async () => undefined) } as unknown as NonNullable<typeof harness.deps.warmStartManager>;
    await fire(job.id);
    expect(consume).not.toHaveBeenCalled();
    expect(warm.sendInput).not.toHaveBeenCalled();
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
  });

  it('refuses automatic remote placement before constructing a remote runtime', async () => {
    const job = await createJob();
    mocks.resolveExecutionLocation.mockReturnValueOnce({ type: 'remote', nodeId: 'worker-placeholder' });
    const run = await fire(job.id);
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/remote execution/) });
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('rejects request-supplied authority and caller identity before persistence', async () => {
    await expect(invoke('create_automation', { name: 'Monitor status', prompt: 'Check status', cron: '*/10 * * * *',
      executionAuthority: { provider: 'codex', modelTier: 'powerful', model: 'gpt-5.6-sol', reasoningEffort: 'max', yoloMode: true },
      callerInstanceId: 'powerful-human' })).rejects.toThrow();
    expect(await store.list()).toHaveLength(0);
  });

  it('keeps the original ceiling on the actual durable retry dispatch after the job changes', async () => {
    const job = await createJob(); const original = await fire(job.id);
    const failed = store.terminalizeRun(original.id, 'failed', 'Transient provider failure')!;
    await store.update(job.id, { action: { ...job.action, executionAuthority: undefined, model: 'opus', yoloMode: true } }, undefined);
    const retry = store.insertRetryRun(failed, 2, 3, NOW + 1000)!;
    expect(retry.configSnapshot?.action).toMatchObject({ model: 'sonnet', executionAuthority: { modelTier: 'balanced' } });
    detection.available = ['codex']; startup = undefined;
    await runner.dispatchRetryRun(retry); await Promise.resolve(startup).catch(() => undefined);
    expect(store.getRun(retry.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/approved|authority/i) });
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
  });

  it('refuses bounded current-thread delivery and agent replacement before any existing adapter receives new instructions', async () => {
    const job = await createJob();
    await store.update(job.id, { destination: { kind: 'thread', instanceId: 'higher-human-thread', reviveIfArchived: true } }, undefined);
    await expect(invoke('update_automation', { id: job.id, prompt: 'Agent replacement' })).rejects.toThrow(/existing threads/);
    const run = await fire(job.id);
    expect(run).toMatchObject({ status: 'failed', error: expect.stringMatching(/existing threads/) });
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('does not reuse an equivalent human thread job under the agent approval snapshot', async () => {
    const job = await createJob();
    await store.update(job.id, { action: { ...job.action, executionAuthority: undefined },
      destination: { kind: 'thread', instanceId: 'human-thread', reviveIfArchived: true } }, undefined);
    await expect(createJob()).rejects.toThrow(/existing threads/);
    expect((await store.list())).toHaveLength(1);
  });

  it('refuses the actual exhausted-recovery provider failover before dispatching a replacement', async () => {
    const job = await createJob(); await fire(job.id);
    const instance = spawned!; instance.status = 'error'; instance.failoverProviders = ['codex'];
    const result = await attemptInstanceFailover(instance, new Error('Provider unavailable'), {
      classify: () => ({ axes: { shouldFailover: true }, reason: 'provider-unavailable', message: 'Provider unavailable' }),
      maxSwitches: 1, selectTarget: () => ({ to: 'codex', considered: [] }),
      installedProviders: new Set(['codex']), isProviderParked: () => false,
      swapProvider: (id, provider) => Reflect.get(harness.manager, 'failoverSwapProvider').call(harness.manager, id, provider),
      notify: vi.fn(), emitActivity: vi.fn(),
    });
    expect(result).toMatchObject({ switched: false, note: expect.stringMatching(/approved|authority/i) });
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
  });

  it.each([{ provider: 'copilot', model: 'claude-sonnet-4.6' }, { reasoningEffort: 'none' }, { model: 'default' }])(
    'teaches unsupported runtime bounds before persisting new executable instructions %j', async patch => {
      const job = await createJob();
      await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement', ...patch })).rejects.toThrow();
      expect((await store.get(job.id))?.action).toEqual(job.action);
    });

  it.each([undefined, { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false }] as const)(
    'rejects forged authority/removal without changing a saved job (caller=%j)', async value => {
      const job = await createJob(); caller = value;
      for (const executionAuthority of [null, { provider: 'codex', model: 'gpt-5.6-sol', modelTier: 'powerful', reasoningEffort: 'max', yoloMode: true }]) {
        await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement', executionAuthority })).rejects.toThrow();
      }
      if (!value) await expect(invoke('update_automation', { id: job.id, prompt: 'Replacement' })).rejects.toThrow(/could not be resolved/);
      expect((await store.get(job.id))?.action).toEqual(job.action);
    });

  it('does not let replacement instructions inherit higher human authority but allows human metadata edits', async () => {
    const job = await store.create({ name: 'Human job', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Human instructions', workingDirectory: '/missing-authority-fixture', provider: 'claude', model: 'opus', reasoningEffort: 'max', yoloMode: true } }, NOW + 600_000);
    await invoke('update_automation', { id: job.id, name: 'Label', hidden: true });
    await expect(invoke('update_automation', { id: job.id, prompt: 'Agent replacement' })).rejects.toThrow(/calling session/);
    await fire(job.id);
    expect(mocks.createAdapter.mock.calls[0][0]).toMatchObject({ cliType: 'claude', options: { model: 'opus', reasoningEffort: 'max', yoloMode: true } });
  });
  it('carries saved authority through real restart reconciliation and retry dispatch after defaults change', async () => {
    const job = await createJob(); const original = await fire(job.id);
    caller = undefined;
    // Reconstruct the store over the persisted rows, as at startup; no caller/default cache remains.
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    const interrupted = store.failRunningRuns('Interrupted by an app restart', NOW + 1000);
    expect(interrupted.map(run => run.id)).toContain(original.id);
    const pending = store.listPendingRetries()[0];
    if (!pending) throw new Error('Restart did not schedule its retry');
    const retry = store.insertRetryRun(store.getRun(original.id)!, pending.nextRetryAttempt, pending.nextRetryMaxAttempts, pending.nextRetryAt)!;
    expect(retry.configSnapshot?.action.executionAuthority).toEqual({ provider: 'claude', model: 'sonnet', modelTier: 'balanced', reasoningEffort: 'low', yoloMode: false });
    startup = undefined;
    await runner.dispatchRetryRun(retry); await Promise.resolve(startup).catch(() => undefined);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(2);
    expect(mocks.createAdapter.mock.calls[1][0].options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false, fallbackModel: 'sonnet' });
  });

});
