import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { buildAutomationLoopConfig } from './automation-loop-run';
import { invokeLoopChildIteration } from '../orchestration/loop-child-invoker';
import { IPC_CHANNELS } from '@contracts/channels';
import type { IpcResponse } from '../../shared/types/ipc.types';
import { registerAutomationHandlers } from '../ipc/handlers/automation-handlers';
import { LoopConfigSchema } from '@contracts/schemas/loop';
import { prepareLoopStartConfig } from '../orchestration/loop-start-config';
import { materializeLoopConfig } from '../orchestration/loop-coordinator-state-helpers';
import { registerDefaultLoopInvoker } from '../orchestration/default-invokers';
import { runFreshEyesReviewGate } from '../orchestration/loop-coordinator-completion-gates';
import type { LoopIteration } from '../../shared/types/loop.types';
import { buildClaudeCliArgs } from '../cli/adapters/claude-cli-argv-builder';
import type { AutomationAttachmentService } from './automation-attachment-service';
import type { AutomationCallerAuthority } from './automation-agent-authority';
import type { AutomationAction, ClaimedAutomationRun } from '../../shared/types/automation.types';
import type { LoopConfig, LoopStage, LoopState } from '../../shared/types/loop.types';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

const h = vi.hoisted(() => ({
  coordinator: null as unknown as EventEmitter,
  store: null as unknown as AutomationStore,
  handlers: new Map<string, (_event: unknown, payload: unknown) => Promise<IpcResponse>>(),
  createAdapter: vi.fn(), resolveCliType: vi.fn(),
  settings: { defaultCli: 'claude', automationDefaultCli: 'claude', automationDefaultModel: 'sonnet',
    modelPickerFavorites: ['claude:sonnet'], loopModelByProvider: { claude: 'opus' },
    providerAccountProfiles: [], providerAccountPools: {}, auxiliaryLlmRoutingClassificationEnabled: false },
}));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => h.settings, get: () => undefined }) }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => h.coordinator }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: h.resolveCliType }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: h.createAdapter }) }));
vi.mock('../orchestration/loop-output-externalize', () => ({ maybeExternalizeLoopOutput: async (output: string) => output }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-loop-authority-test' },
  ipcMain: { handle: (channel: string, handler: (_event: unknown, payload: unknown) => Promise<IpcResponse>) => h.handlers.set(channel, handler) } }));
vi.mock('../automations', async () => ({ ...await import('./automation-schedule'),
  getAutomationStore: () => h.store, getAutomationScheduler: () => ({ schedule: vi.fn() }),
  getAutomationRunner: () => ({ untrackInstances: vi.fn() }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));

const NOW = Date.UTC(2026, 9, 20, 12);
describe('approved automation LOOP authority reaches actual adapter options', () => {
  const rlmTemplate = useSqliteTemplate((db) => {
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });
  let db: SqliteDriver;
  let store: AutomationStore;
  let caller: AutomationCallerAuthority | undefined;
  beforeEach(() => {
    h.coordinator = Object.assign(new EventEmitter(), { registerIterationHook: vi.fn(() => vi.fn()) });
    h.resolveCliType.mockReset().mockResolvedValue('claude');
    h.createAdapter.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), {
      sendMessage: vi.fn(async () => ({ content: 'ok', usage: { totalTokens: 1 } })),
      terminate: vi.fn(async () => undefined), setResume: vi.fn(),
    }));
    h.settings.automationDefaultModel = 'sonnet'; h.settings.modelPickerFavorites = ['claude:sonnet'];
    caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low', yoloMode: false };
    db = rlmTemplate.open();
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined,
      listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
  });
  afterEach(() => { db.close(); h.handlers.clear(); });
  function impl() {
    return createAutomationToolImplementations({ store, scheduler: { schedule: vi.fn(), deactivate: vi.fn() },
      runner: { untrackInstances: vi.fn() }, events: { emitChanged: vi.fn() },
      createWithScheduling: input => store.create(input, NOW + 600_000), handlePastOneTime: async () => undefined,
      resolveCaller: id => id === 'caller' ? caller : undefined, resolveWorkingDirectory: () => '/missing-authority-fixture',
      resolveTimezone: () => 'UTC', now: () => NOW });
  }
  async function seed(action: Partial<AutomationAction> = {}) {
    return store.create({ name: 'Loop job', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Original', workingDirectory: '/missing-authority-fixture', provider: 'claude',
        model: 'sonnet', reasoningEffort: 'low', yoloMode: false,
        loop: { verifyCommand: 'npm test', isolateWorkspace: false }, ...action } }, NOW + 600_000);
  }
  async function update(id: string, args: Record<string, unknown> = {}, instanceId: string | null = 'caller') {
    const tool = createAutomationToolDefinitions({ instanceId, ...impl() }).find(t => t.name === 'update_automation')!;
    return tool.handler({ id, prompt: 'Replacement instructions', ...args });
  }
  async function configFor(id: string): Promise<LoopConfig> {
    const automation = (await store.get(id))!;
    const claimed: ClaimedAutomationRun = { automation, snapshot: automation,
      run: { id: 'run', automationId: id, status: 'running', trigger: 'manual',
        scheduledAt: NOW, startedAt: NOW, finishedAt: null, instanceId: null, loopRunId: null,
        error: null, outputSummary: null, outputFullRef: null, idempotencyKey: null,
        triggerSource: null, deliveryMode: 'notify', seenAt: null, createdAt: NOW, updatedAt: NOW,
        configSnapshot: automation, attempt: 1, maxAttempts: 1 } };
    return materializeLoopConfig(buildAutomationLoopConfig(claimed));
  }
  async function iterate(config: LoopConfig, stage: LoopStage = 'IMPLEMENT', manager = {}) {
    registerDefaultLoopInvoker(manager as never);
    return invokeLoopChildIteration({ emitter: h.coordinator, state: { id: 'loop', chatId: 'chat', totalIterations: 0, config } as LoopState,
      prompt: 'Do approved work', stage, forceContextReset: false, idempotencyKey: 'loop:0' });
  }

  it.each(['same-session', 'fresh-child', 'hybrid'] as const)('MCP -> saved snapshot -> payload -> %s factory preserves Sonnet/low/no auto-approval', async contextStrategy => {
    const job = await seed(); await update(job.id);
    const config = await configFor(job.id); config.contextStrategy = contextStrategy;
    // The caller can disappear and all global/preset defaults can increase afterwards.
    caller = undefined; h.settings.automationDefaultModel = 'opus'; h.settings.modelPickerFavorites = ['claude:opus'];
    await iterate(JSON.parse(JSON.stringify(config)));
    const options = h.createAdapter.mock.calls[0][0].options;
    expect(options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
    const args = buildClaudeCliArgs({ spawnOptions: options, sessionId: null, excludeDynamicSectionsSupported: false,
      cliVersion: '2.1.288', disallowedToolsOverride: null, shouldUseNativeResume: false,
      shouldUsePermissionHook: false, materializeInlineJsonArg: value => value });
    expect(args).toEqual(expect.arrayContaining(['--model', 'sonnet', '--effort', 'low', '--permission-mode', 'acceptEdits']));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it.each(['PLAN', 'REVIEW', 'IMPLEMENT'] as const)('uses approved settings during the %s role', async stage => {
    const job = await seed(); await update(job.id); await iterate(await configFor(job.id), stage);
    expect(h.createAdapter.mock.calls[0][0].options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
  });

  it('does not borrow a live adapter with stronger spawn permissions', async () => {
    const job = await seed(); await update(job.id);
    const sendMessage = vi.fn(async () => ({ content: 'unauthorized', usage: { totalTokens: 1 } }));
    await iterate(await configFor(job.id), 'IMPLEMENT', {
      getInstance: () => ({ provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'max', yoloMode: true }),
      getAdapter: () => Object.assign(new EventEmitter(), { sendMessage }),
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(h.createAdapter.mock.calls[0][0].options).toMatchObject({ yoloMode: false, reasoningEffort: 'low' });
  });

  it('fails closed when CLI availability resolves an approved provider to another provider', async () => {
    const job = await seed(); await update(job.id); h.resolveCliType.mockResolvedValue('codex');
    await expect(iterate(await configFor(job.id))).rejects.toThrow(/authority|approved/i);
    expect(h.createAdapter).not.toHaveBeenCalled();
  });

  it('refuses unknown nested loop runtime configuration before saving new executable instructions', async () => {
    const job = await seed({ loop: { verifyCommand: 'npm test', config: { model: 'opus', yoloMode: true } } as AutomationAction['loop'] });
    await expect(update(job.id)).rejects.toThrow(/loop|Automations form/);
    expect((await store.get(job.id))?.action.prompt).toBe('Original');
  });

  it('retains the snapshot through contract validation and real start-config preparation', async () => {
    const job = await seed(); await update(job.id);
    const config = await configFor(job.id);
    const prepared = await prepareLoopStartConfig(LoopConfigSchema.parse(config));
    expect(prepared).toMatchObject({ executionAuthority: { model: 'sonnet', reasoningEffort: 'low', yoloMode: false },
      completion: { crossModelReview: { enabled: false } } });
    await iterate(materializeLoopConfig(prepared));
    expect(h.createAdapter.mock.calls[0][0].options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
  });

  it('recycles a previously stronger persistent adapter before a lowered snapshot runs', async () => {
    const job = await seed({ reasoningEffort: 'max', yoloMode: true });
    await iterate(await configFor(job.id));
    await store.update(job.id, { action: { ...(await store.get(job.id))!.action, reasoningEffort: 'low', yoloMode: false } }, undefined);
    await iterate(await configFor(job.id));
    expect(h.createAdapter).toHaveBeenCalledTimes(2);
    expect(h.createAdapter.mock.calls[1][0].options).toMatchObject({ reasoningEffort: 'low', yoloMode: false });
  });

  it.each([
    { completion: { mode: 'review-driven' } },
    { completion: { crossModelReview: { enabled: true } } },
    { exploration: { enabled: true } }, { failover: { enabled: true } },
    { semanticProgress: { enabled: true } }, { nextObjectivePlanning: { enabled: true } },
    { phase4: { subagentContracts: { enabled: true } } },
  ])('refuses unsupported additional model roles before engine startup %j', async patch => {
    const job = await seed(); await update(job.id);
    const config = await configFor(job.id);
    expect(() => materializeLoopConfig({ ...config, ...patch } as LoopConfig)).toThrow(/additional model roles/);
    expect(h.createAdapter).not.toHaveBeenCalled();
  });

  it.each(['missing', null])('cannot forge caller identity (%s)', async instanceId => {
    const job = await seed();
    await expect(update(job.id, {}, instanceId)).rejects.toThrow(/calling session/);
    expect((await store.get(job.id))?.action.prompt).toBe('Original');
  });

  it.each([{ callerInstanceId: 'powerful-human' }, { executionAuthority: { model: 'opus', yoloMode: true } },
    { loop: { config: { yoloMode: true } } }])('rejects request-supplied authority or nested raw config %j', async forged => {
    const job = await seed(); await expect(update(job.id, forged)).rejects.toThrow();
    expect((await store.get(job.id))?.action.prompt).toBe('Original');
  });

  it.each([{ provider: 'copilot', model: 'claude-sonnet-4.6', reasoningEffort: 'low' },
    { provider: 'claude', model: 'sonnet', reasoningEffort: 'none' },
    { provider: 'claude', model: 'default', reasoningEffort: 'low' }] as const)('refuses unsupported effective runtime targets %j', async action => {
    const job = await seed(action);
    await expect(update(job.id)).rejects.toThrow();
    expect((await store.get(job.id))?.action.prompt).toBe('Original');
  });

  it.each(['same-session', 'fresh-child', 'hybrid'] as const)('honors Codex model/effort/approval in %s including persistent vs ephemeral transport', async contextStrategy => {
    caller = { provider: 'codex', currentModel: 'gpt-5.5', reasoningEffort: 'low', yoloMode: false };
    h.resolveCliType.mockResolvedValue('codex');
    const job = await seed({ provider: 'codex', model: 'gpt-5.5' }); await update(job.id);
    const config = await configFor(job.id); config.contextStrategy = contextStrategy;
    await iterate(config);
    expect(h.createAdapter.mock.calls[0][0]).toMatchObject({ cliType: 'codex', options: {
      model: 'gpt-5.5', reasoningEffort: 'low', yoloMode: false,
      ...(contextStrategy === 'same-session' ? { ephemeral: false } : {}),
    } });
  });

  it.each([false, true])('only auto-answers permission requests with approved auto-approval=%s', async yoloMode => {
    const sendRaw = vi.fn(async () => undefined);
    h.createAdapter.mockImplementation(() => {
      const adapter = Object.assign(new EventEmitter(), { sendRaw, terminate: vi.fn(async () => undefined),
        sendMessage: async () => {
          adapter.emit('input_required', { id: 'acp_permission:fixture', prompt: 'Permission required',
            metadata: { type: 'acp_permission_request', action: 'acp_permission' } });
          return { content: 'ok', usage: { totalTokens: 1 } };
        } });
      return adapter;
    });
    caller!.yoloMode = yoloMode;
    const job = await seed({ yoloMode }); await update(job.id); await iterate(await configFor(job.id));
    if (yoloMode) expect(sendRaw).toHaveBeenCalledWith('allow', 'acp_permission:fixture');
    else expect(sendRaw).not.toHaveBeenCalled();
  });

  it('teaches a refusal when new instructions request an implicitly enabled independent reviewer', async () => {
    const job = await seed();
    await expect(update(job.id, { prompt: 'Review with fresh eyes and fix all findings until clean' }))
      .rejects.toThrow(/reviewer|model roles/);
    expect((await store.get(job.id))?.action.prompt).toBe('Original');
  });

  it.each(['none', 'minimal', 'max', 'ultra'] as const)('preserves explicit human Codex effort %s rather than imposing an agent ceiling', async reasoningEffort => {
    h.resolveCliType.mockResolvedValue('codex');
    const job = await seed({ provider: 'codex', model: 'gpt-5.5', reasoningEffort });
    await iterate(await configFor(job.id));
    expect(h.createAdapter.mock.calls[0][0].options).toMatchObject({ model: 'gpt-5.5', reasoningEffort, yoloMode: false });
  });

  it('keeps explicit higher human authority through the actual human IPC -> store -> loop -> factory path', async () => {
    const job = await seed();
    await update(job.id);
    const saved = (await store.get(job.id))!;
    h.store = store; registerAutomationHandlers();
    const response = await h.handlers.get(IPC_CHANNELS.AUTOMATION_UPDATE)!(null, { id: job.id,
      updates: { action: { ...saved.action, prompt: 'Human authorized', model: 'opus', reasoningEffort: 'max', yoloMode: true } } });
    expect(response.success).toBe(true);
    expect((await store.get(job.id))?.action.executionAuthority).toBeUndefined();
    await iterate(await configFor(job.id));
    expect(h.createAdapter.mock.calls[0][0].options).toMatchObject({ model: 'opus', reasoningEffort: 'max', yoloMode: true });
  });
  it('refuses a contradiction-forced extra reviewer even when the saved config disables it', async () => {
    const job = await seed(); await update(job.id);
    const config = await configFor(job.id);
    const reviewer = vi.fn(async () => ({ reviewersUsed: ['unapproved'], findings: [], summary: 'clean' }));
    const iteration: LoopIteration = {
      id: 'bounded-iteration', loopRunId: 'bounded-loop', seq: 0, stage: 'IMPLEMENT',
      startedAt: NOW, endedAt: NOW, childInstanceId: null, tokens: 0, costCents: 0,
      filesChanged: [], toolCalls: [], errors: [], testPassCount: null, testFailCount: null,
      workHash: '', outputSimilarityToPrev: null, outputExcerpt: '', outputFull: '',
      progressVerdict: 'OK', progressSignals: [], completionSignalsFired: [],
      verifyStatus: 'not-run', verifyOutputExcerpt: '',
    };
    await expect(runFreshEyesReviewGate({
      state: { id: 'bounded-loop', config, freshEyesForcedByContradiction: true } as LoopState,
      signalId: 'done-promise', iteration,
      verifyOutput: '', reviewer, emit: vi.fn(), setConvergenceNote: vi.fn(),
    })).rejects.toThrow(/authority|saved limits/);
    expect(reviewer).not.toHaveBeenCalled();
  });

  it.each(['same-session', 'fresh-child', 'hybrid'] as const)('preserves the ceiling across repeated %s turns and context reset', async contextStrategy => {
    const job = await seed(); await update(job.id);
    const config = await configFor(job.id); config.contextStrategy = contextStrategy;
    await iterate(config); await iterate(JSON.parse(JSON.stringify(config)));
    expect(h.createAdapter).toHaveBeenCalledTimes(contextStrategy === 'same-session' ? 1 : 2);
    for (const [input] of h.createAdapter.mock.calls) {
      expect(input.options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false, instanceId: 'chat', automationAuthority: { modelTier: 'balanced' } });
    }
    if (contextStrategy === 'same-session') {
      await invokeLoopChildIteration({ emitter: h.coordinator, state: { id: 'loop', chatId: 'chat', totalIterations: 1, config } as LoopState,
        prompt: 'Continue approved work', stage: 'IMPLEMENT', forceContextReset: true, idempotencyKey: 'loop:1' });
      expect(h.createAdapter).toHaveBeenCalledTimes(2);
      expect(h.createAdapter.mock.calls[1][0].options).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
    }
  });

});
