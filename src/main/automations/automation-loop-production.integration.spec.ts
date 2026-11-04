import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';
import { automationInvocations } from './automation-invocation-context';
import { getAutomationEvents, resetAutomationEventsForTesting, type AutomationEventMap } from './automation-events';
import { ProviderRuntimeService } from '../providers/provider-runtime-service';
import { registerDefaultLoopInvoker } from '../orchestration/default-invokers';
import { OrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from '../mcp/orchestrator-tools-rpc-client';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { AutomationLoopRunDispatcher } from './automation-loop-run';

const state = vi.hoisted(() => ({ dir: '', loop: null as unknown as EventEmitter, runtime: null as unknown as ProviderRuntimeService, strategy: 'fresh-child' }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir } }));
vi.mock('../providers/provider-runtime-service', async original => ({ ...(await original<typeof import('../providers/provider-runtime-service')>()), getProviderRuntimeService: () => state.runtime }));
vi.mock('../orchestration/loop-coordinator', () => ({ getLoopCoordinator: () => state.loop }));
vi.mock('../orchestration/loop-start-config', () => ({ prepareLoopStartConfig: async (c: unknown) => c }));
vi.mock('../orchestration/loop-safety-advisor', () => ({ registerLoopSafetyAdvisor: vi.fn() }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_p: unknown, options: unknown) => options }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({ defaultCli: 'claude', loopModelByProvider: {}, providerAccountProfiles: [], providerAccountPools: {} }) }) }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: (run: () => Promise<unknown>) => run() }) }) }));
vi.mock('../orchestration/invocation-model-resolver', () => ({ resolveModelForInvocation: () => 'sonnet', isExplicitModel: () => true, shouldPreferScaffoldingProvider: () => false }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: () => undefined }) }));

async function flush() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
describe('scheduled loop through the real default invoker', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let runner: AutomationRunner;
  let rpc: OrchestratorToolsRpcServer;
  let sent: Promise<void>;
  let onSent: () => void;
  let finish: Promise<void>;
  let onFinish: () => void;
  let settle: () => void;
  let response: CliResponse;
  let invocationEnv: Record<string, string>;
  let terminal: Mock<(event: AutomationEventMap['runTerminal']) => void>;
  let dispatcher: AutomationLoopRunDispatcher;
  let assistantText: string;
  beforeEach(async () => {
    state.dir = mkdtempSync(join(process.cwd(), '_scratch', 'automation-loop-production-'));
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as never);
    assistantText = '';
    sent = new Promise(resolve => { onSent = resolve; }); finish = new Promise(resolve => { onFinish = resolve; });
    resetAutomationEventsForTesting(); terminal = vi.fn<(event: AutomationEventMap['runTerminal']) => void>(); getAutomationEvents().on('automation:run-terminal', terminal);
    const manager = Object.assign(new EventEmitter(), { getInstance: () => undefined, queueInstanceUpdate: vi.fn(),
      emitProviderRuntimeEvent: (instanceId: string, event: unknown, options: unknown) => manager.emit('provider:normalized-event', { instanceId, event, ...options as object }),
    });
    runner = new AutomationRunner(store, undefined, () => Date.now(), (() => ({})) as never); runner.initialize(manager as never);
    rpc = new OrchestratorToolsRpcServer({ userDataPath: state.dir, registerCleanup: () => undefined, isKnownLocalInstance: () => false,
      toolFactory: createAutomationToolDefinitions, automationResult: (result, meta) => runner.recordResult(meta.callerInstanceId, result) });
    await rpc.start();
    automationInvocations.configure((id, provider) => buildOrchestratorToolsMcpConfig({ aioMcpCliPath: 'test-cli', socketPath: rpc.getSocketPath()!,
      instanceId: id, capabilityToken: rpc.getInstanceCapability(id)!, provider, automationInvocation: true, exists: () => true })!);
    state.runtime = new ProviderRuntimeService({ createAdapter: input => {
      invocationEnv = JSON.parse(input.options.mcpConfig![0]).mcpServers.orchestrator.env;
      const adapter = Object.assign(new EventEmitter(), {
        terminate: vi.fn(async () => undefined),
        sendMessage: async () => {
          await new OrchestratorToolsRpcClient({ env: invocationEnv }).call('orchestrator_tools.automation_result', { outcome: 'no_change', notify: false });
          if (assistantText) adapter.emit('output', { id: 'out', type: 'assistant', content: assistantText, timestamp: Date.now() });
          response = { id: 'response', role: 'assistant', content: assistantText }; settle = deferResponseUsage(response);
          adapter.emit('complete', response); onSent(); return response;
        },
      }) as unknown as CliAdapter;
      return adapter;
    } });
    state.loop = Object.assign(new EventEmitter(), {
      startLoop: async (chatId: string, config: Record<string, unknown>) => {
        queueMicrotask(() => state.loop.emit('loop:invoke-iteration', { loopRunId: 'loop', chatId, correlationId: 'loop::0',
          provider: 'claude', model: 'sonnet', workspaceCwd: join(state.dir, 'absent-workspace'), stage: 'IMPLEMENT', seq: 0, prompt: 'Check', idempotencyKey: 'loop:0',
          config: { ...config, contextStrategy: state.strategy }, callback: () => {
            state.loop.emit('loop:state-changed', { loopRunId: 'loop', state: { status: 'completed' } }); onFinish();
          },
        }));
        return { id: 'loop' };
      },
      cancelLoop: async () => { state.loop.emit('loop:state-changed', { loopRunId: 'loop', state: { status: 'cancelled' } }); return true; },
    });
    const coordinator = state.loop as EventEmitter & { startLoop: (chatId: string, config: unknown) => Promise<{ id: string }>; cancelLoop: () => Promise<boolean> };
    dispatcher = new AutomationLoopRunDispatcher({ store, now: Date.now, prepareConfig: async c => c,
      startLoop: (id, config) => coordinator.startLoop(id, config), cancelLoop: () => coordinator.cancelLoop(),
      subscribeLoopStateChanged: listener => { coordinator.on('loop:state-changed', listener); },
      onTerminal: run => getAutomationEvents().emitRunTerminal({ automationId: run.automationId, runId: run.id, status: run.status as 'failed' | 'succeeded' }),
    });
    manager.on('provider:normalized-event', envelope => dispatcher.observeProviderEvent(envelope));
    registerDefaultLoopInvoker(manager as never);
  });
  afterEach(async () => { await rpc.stop(); automationInvocations.reset(); resetAutomationEventsForTesting(); db.close(); rmSync(state.dir, { recursive: true, force: true }); });
  it.each(['fresh-child', 'same-session'])('keeps %s running until native usage settles and fails a late cache-only cap before callback completion', async strategy => {
    state.strategy = strategy;
    const a = await store.create({ name: 'Loop', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check', workingDirectory: join(state.dir, 'absent-workspace'), maxProcessedTokens: 100, loop: { verifyCommand: 'example-command', isolateWorkspace: false } } }, Date.now() + 1000);
    const decision = store.decideAndInsertRun(a, 'manual', Date.now());
    if (decision.kind !== 'started') throw new Error('No run');
    await dispatcher.dispatch({ run: decision.run, automation: a, snapshot: decision.run.configSnapshot! }); await sent; await flush();
    const run = () => store.listRuns({ automationId: a.id })[0];
    expect(run()).toMatchObject({ status: 'running', result: { outcome: 'no_change', notify: false } });
    expect(terminal).not.toHaveBeenCalled();
    response.usage = { cacheReadTokens: 60, cacheWriteTokens: 41 }; settle(); await finish; await flush();
    expect(run()).toMatchObject({ status: 'failed', error: 'Stopped: token cap', processedTokens: 101 });
    expect(terminal.mock.calls.map(([e]) => e.status)).toEqual(['failed']);
    await expect(new OrchestratorToolsRpcClient({ env: invocationEnv }).call('orchestrator_tools.automation_result', { outcome: 'done', notify: true })).rejects.toThrow();
  });
  it('uses actual loop output for unchanged cadence and resets when a meaningful count changes', async () => {
    state.strategy = 'fresh-child';
    const a = await store.create({ name: 'Monitor', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check', workingDirectory: join(state.dir, 'absent-workspace'), slowWhenUnchanged: true,
        loop: { verifyCommand: 'example-command', isolateWorkspace: false } } }, Date.now() + 1000);
    for (const [text, multiplier] of [['Count 1 at 2026-10-30T10:00:00Z', 1], ['Count 1 at 2026-10-31T10:00:00Z', 2], ['Count 2 at 2026-10-31T11:00:00Z', 1]] as const) {
      assistantText = text; sent = new Promise(resolve => { onSent = resolve; }); finish = new Promise(resolve => { onFinish = resolve; });
      const decision = store.decideAndInsertRun((await store.get(a.id))!, 'manual', Date.now());
      if (decision.kind !== 'started') throw new Error('No run');
      await dispatcher.dispatch({ run: decision.run, automation: a, snapshot: decision.run.configSnapshot! });
      await sent; response.usage = { inputTokens: 1 }; settle(); await finish; await flush();
      expect(store.getRun(decision.run.id)).toMatchObject({ status: 'succeeded', outputSummary: text });
      expect((await store.get(a.id))!.monitorState!.intervalMultiplier).toBe(multiplier);
    }
  });
});
