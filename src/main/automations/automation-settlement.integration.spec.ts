import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import type { InstanceManager } from '../instance/instance-manager';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { InstanceCommunicationManager } from '../instance/instance-communication';
import { AutomationRunner } from './automation-runner';
import { AutomationStore } from './automation-store';
import { getAutomationEvents, resetAutomationEventsForTesting, type AutomationEventMap } from './automation-events';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import type { AutomationAttachmentService } from './automation-attachment-service';
import { dispatchConnectorRpc } from '../mcp/connector-rpc';
import { ConnectorAccessRegistry } from '../mcp/connector-access';
import { GraphConnectorService } from '../graph/graph-connector-service';
import { GraphClient } from '../graph/graph-client';
import { AutomationLoopRunDispatcher } from './automation-loop-run';
import { automationInvocations } from './automation-invocation-context';
import { ProviderRuntimeService } from '../providers/provider-runtime-service';
import { OrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from '../mcp/orchestrator-tools-rpc-client';
import { createAutomationToolDefinitions } from '../mcp/orchestrator-automation-tools';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { createAutomationToolImplementations } from './automation-tool-impl';
import { AutomationUpdatePayloadSchema } from '@contracts/schemas/automation';
import { AutomationScheduler } from './automation-scheduler';

const fixture = vi.hoisted(() => ({ dir: '', send: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => fixture.dir }, powerMonitor: { on: vi.fn() } }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: () => ({ cost: 0 }) }) }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('../instance/instance-lifecycle-hooks', () => ({ dispatchInstanceLifecycleHook: vi.fn() }));
vi.mock('../session/artifact-attribution-store', () => ({ getArtifactAttributionStore: () => ({ registerArtifact: vi.fn() }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('./automation-account-rules', () => ({ automationAccountPreferences: async () => undefined }));
vi.mock('../channels/channel-manager', () => ({ getChannelManager: () => ({ getAdapter: () => ({ sendMessage: fixture.send }), emitResponseSent: vi.fn() }) }));

async function flush() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
const response = (id: string): CliResponse => ({ id, role: 'assistant', content: 'Checked.' });

describe('scheduled run settlement through provider communication', () => {
  let db: ReturnType<typeof defaultDriverFactory>;
  let store: AutomationStore;
  let runner: AutomationRunner;
  let clock: number;
  let instances: Map<string, Instance>;
  let adapters: Map<string, CliAdapter>;
  let communication: InstanceCommunicationManager;
  let manager: EventEmitter & { createInstance: ReturnType<typeof vi.fn>; getInstance: (id: string) => Instance | undefined;
    getAllInstances: () => Instance[]; getAdapter: (id: string) => CliAdapter | undefined; terminateInstance: ReturnType<typeof vi.fn>; queueInstanceUpdate: ReturnType<typeof vi.fn> };
  let add: (id: string, parentId?: string | null, metadata?: Record<string, unknown>) => { instance: Instance; adapter: CliAdapter };
  let terminal: Mock<(event: AutomationEventMap['runTerminal']) => void>;
  beforeEach(() => {
    vi.useFakeTimers(); clock = 10_000;
    fixture.dir = mkdtempSync(join(process.cwd(), '_scratch', 'automation-settlement-'));
    fixture.send.mockReset().mockResolvedValue({ messageId: 'sent' });
    db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new AutomationStore(db, { prepare: async () => [], replacePrepared: () => undefined, listForAutomation: async () => [] } as unknown as AutomationAttachmentService);
    instances = new Map(); adapters = new Map();
    manager = Object.assign(new EventEmitter(), {
      createInstance: vi.fn(async (config: InstanceCreateConfig) => add('root', null, config.metadata).instance),
      getInstance: (id: string) => instances.get(id), getAllInstances: () => [...instances.values()],
      getAdapter: (id: string) => adapters.get(id),
      terminateInstance: vi.fn(async (id: string) => { instances.delete(id); }), queueInstanceUpdate: vi.fn(),
    });
    communication = new InstanceCommunicationManager({
      getInstance: manager.getInstance, getAdapter: id => adapters.get(id), setAdapter: (id, a) => { adapters.set(id, a); }, deleteAdapter: id => adapters.delete(id),
      queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
      emitProviderRuntimeEvent: (instanceId, event, options) => manager.emit('provider:normalized-event', {
        instanceId, event, adapterGeneration: instances.get(instanceId)?.adapterGeneration, ...options,
      }),
    });
    add = (id, parentId = null, metadata = {}) => {
      const instance = { id, parentId, childrenIds: [], sessionId: `session-${id}`, status: 'busy', provider: 'claude', currentModel: 'sonnet',
        restartEpoch: 0, requestCount: 1, metadata, outputBuffer: [], contextUsage: { used: 0, total: 200000, percentage: 0 } } as unknown as Instance;
      const adapter = new EventEmitter() as CliAdapter;
      instances.set(id, instance); adapters.set(id, adapter); communication.setupAdapterEvents(id, adapter);
      return { instance, adapter };
    };
    resetAutomationEventsForTesting(); terminal = vi.fn<(event: AutomationEventMap['runTerminal']) => void>(); getAutomationEvents().on('automation:run-terminal', terminal);
    runner = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never, undefined, undefined,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'sonnet', modelPickerFavorites: [] }));
    runner.initialize(manager as unknown as InstanceManager);
  });
  afterEach(() => { vi.useRealTimers(); automationInvocations.reset(); resetAutomationEventsForTesting(); db.close(); rmSync(fixture.dir, { recursive: true, force: true }); });
  async function fire() {
    const a = await store.create({ name: 'Check', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check', workingDirectory: '/repo', maxProcessedTokens: 100, maxRunMinutes: 1 } }, 600_000, clock);
    await runner.fire(a.id, { trigger: 'channel', triggerSource: { type: 'channel', channel: 'discord:example' } });
    return () => store.listRuns({ automationId: a.id })[0];
  }
  function output() { manager.emit('provider:normalized-event', { instanceId: 'root', event: { kind: 'output', messageType: 'assistant', content: 'Checked.' } }); }
  function idle(id = 'root') {
    const instance = instances.get(id)!; instance.status = 'idle';
    manager.emit('instance:event', { instanceId: id, event: { kind: 'status_changed', status: 'idle' } });
  }
  it.each(['idle', 'exit', 'reconcile'] as const)('does not deliver ahead of late cache-only over-cap usage after %s', async mode => {
    let result!: CliResponse; let settle!: () => void;
    if (mode === 'reconcile') manager.createInstance.mockImplementation(async (config: InstanceCreateConfig) => {
      const { instance, adapter } = add('root', null, config.metadata);
      instance.outputBuffer.push({ id: 'out', type: 'assistant', content: 'Checked.', timestamp: clock });
      result = response('fast'); settle = deferResponseUsage(result); adapter.emit('complete', result); idle();
      return instance;
    });
    const run = await fire(); output();
    if (mode !== 'reconcile') {
      result = response('late'); settle = deferResponseUsage(result); adapters.get('root')!.emit('complete', result);
      if (mode === 'idle') idle();
      else manager.emit('provider:normalized-event', { instanceId: 'root', event: { kind: 'exit', code: 0, signal: null } });
    }
    await flush(); await vi.advanceTimersByTimeAsync(1);
    expect(run().status).toBe('running'); expect(terminal).not.toHaveBeenCalled(); expect(fixture.send).not.toHaveBeenCalled();
    result.usage = { cacheReadTokens: 60, cacheWriteTokens: 41 }; settle(); await flush();
    expect(run()).toMatchObject({ status: 'failed', error: 'Stopped: token cap', processedTokens: 101 });
    expect(terminal.mock.calls.map(([e]) => e.status)).toEqual(['failed']);
  });
  it('retains an actual first-turn receipt emitted before tracking', async () => {
    manager.createInstance.mockImplementation(async (config: InstanceCreateConfig) => {
      const { instance, adapter } = add('root', null, config.metadata);
      instance.outputBuffer.push({ id: 'out', type: 'assistant', content: 'Checked.', timestamp: clock });
      adapter.emit('complete', { ...response('fast'), usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30 } });
      await flush();
      return instance;
    });
    const run = await fire(); await flush();
    expect(run()).toMatchObject({ status: 'succeeded', processedTokens: 60 });
    expect(terminal).toHaveBeenCalledOnce(); expect(fixture.send).toHaveBeenCalledOnce();
  });
  it('counts old request costs without letting its receipt finish a newer request', async () => {
    const run = await fire(); output();
    const result = response('old'); const settle = deferResponseUsage(result);
    adapters.get('root')!.emit('complete', result); await flush(); instances.get('root')!.requestCount = 2;
    result.usage = { inputTokens: 20, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 5 }; settle(); await flush();
    expect(run()).toMatchObject({ status: 'running', processedTokens: 30 }); expect(fixture.send).not.toHaveBeenCalled();
    adapters.get('root')!.emit('complete', { ...response('new'), usage: { inputTokens: 10 } }); await flush();
    expect(run()).toMatchObject({ status: 'succeeded', processedTokens: 40 }); expect(terminal).toHaveBeenCalledOnce();
  });
  it.each([false, true])('waits for a child whose status preceded semantic completion (removed=%s)', async removed => {
    const run = await fire(); output(); const child = add('child', 'root'); idle('child');
    adapters.get('root')!.emit('complete', response('root')); await flush(); await vi.advanceTimersByTimeAsync(1);
    expect(run().status).toBe('running'); expect(fixture.send).not.toHaveBeenCalled();
    const result = response('child'); const settle = deferResponseUsage(result); child.adapter.emit('complete', result); await flush();
    if (removed) { manager.emit('instance:removed', 'child'); instances.delete('child'); adapters.delete('child'); }
    result.usage = { cacheReadTokens: 60, cacheWriteTokens: 41 }; settle(); await flush();
    expect(run()).toMatchObject({ status: 'failed', error: 'Stopped: token cap', processedTokens: 101 });
    expect(terminal.mock.calls.map(([e]) => e.status)).toEqual(['failed']);
  });
  it('retains failed cancellation, retries the stop and never accepts late success', async () => {
    const run = await fire(); output(); add('child', 'root');
    manager.terminateInstance.mockRejectedValueOnce(new Error('temporary stop failure'));
    clock += 60_001; await vi.advanceTimersByTimeAsync(60_001); await flush();
    expect(run()).toMatchObject({ status: 'failed' });
    expect(run().error).toContain('stop');
    await vi.advanceTimersByTimeAsync(5_000); await flush();
    expect(manager.terminateInstance.mock.calls.filter(([id]) => id === 'child')).toHaveLength(2);
    adapters.get('root')?.emit('complete', response('late')); await flush();
    expect(run().status).toBe('failed'); expect(terminal.mock.calls.map(([e]) => e.status)).toEqual(['failed']);
  });
  it('follows a replacement child adapter through removed zero-usage settlement', async () => {
    const run = await fire(); output(); const old = add('child', 'root'); idle('child');
    adapters.get('root')!.emit('complete', response('root')); await flush();
    const oldResponse = response('old-child'); const settleOld = deferResponseUsage(oldResponse); old.adapter.emit('complete', oldResponse); await flush();
    const replacement = add('child', 'root'); replacement.instance.adapterGeneration = 2; idle('child');
    settleOld(); await flush();
    expect(run().status).toBe('running');
    const current = response('replacement'); const settle = deferResponseUsage(current); replacement.adapter.emit('complete', current); await flush();
    manager.emit('instance:removed', 'child'); instances.delete('child'); adapters.delete('child');
    settle(); await flush();
    expect(run().status).toBe('succeeded'); expect(terminal).toHaveBeenCalledOnce();
  });
  it('keeps failed stops owned after bounded retries and stops a child discovered while stopping', async () => {
    const run = await fire(); output();
    manager.terminateInstance.mockRejectedValue(new Error('runtime stop failed'));
    clock += 60_001; await vi.advanceTimersByTimeAsync(60_001); await flush();
    add('late-child', 'root'); idle('late-child'); await flush();
    expect(manager.terminateInstance).toHaveBeenCalledWith('late-child', false);
    await vi.advanceTimersByTimeAsync(100_000); await flush();
    expect(manager.terminateInstance.mock.calls.filter(([id]) => id === 'root')).toHaveLength(3);
    expect(run().error).toContain('Could not stop');
    const late = { instanceId: 'late-child', eventId: 'settled-late-stop', event: { kind: 'complete', requestCountAtCompletion: 1,
      inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } };
    manager.emit('provider:normalized-event', late); manager.emit('provider:normalized-event', late);
    expect(run()).toMatchObject({ status: 'failed', processedTokens: 8 });
    const a = await store.get(run().automationId);
    await runner.fire(a!.id, { trigger: 'manual' });
    expect(manager.createInstance).toHaveBeenCalledOnce();
    expect(store.listRuns({ automationId: a!.id }).some(r => r.status === 'skipped')).toBe(true);
  });
  it.each(['timer', 'creation return'] as const)('keeps ownership of a late-created instance when its dispatch-deadline cancellation fails (%s)', async expiry => {
    let entered!: () => void; const creating = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    manager.createInstance.mockImplementation(async (config: InstanceCreateConfig) => { entered(); await waiting; return add('root', null, config.metadata).instance; });
    manager.terminateInstance.mockRejectedValueOnce(new Error('startup stop failed'));
    const a = await store.create({ name: 'Slow start', schedule: { type: 'oneTime', runAt: clock + 1000 },
      action: { prompt: 'Check', workingDirectory: '/repo', maxRunMinutes: 1 } }, clock + 1000, clock);
    const firing = runner.fire(a.id, { trigger: 'manual' }); await creating;
    clock += 60_001;
    if (expiry === 'timer') await vi.advanceTimersByTimeAsync(60_001);
    release(); await firing; await flush();
    const run = store.listRuns({ automationId: a.id })[0];
    expect(run).toMatchObject({ status: 'failed' });
    expect(run.error).toContain('Could not stop');
    expect(manager.terminateInstance).toHaveBeenCalledTimes(1);
    expect(runner.hasStoppingRun(a.id)).toBe(true);
    const result = response('late-root'); const settle = deferResponseUsage(result);
    adapters.get('root')!.emit('complete', result); await flush();
    result.usage = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }; settle(); await flush();
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', processedTokens: 8 });
    expect(terminal.mock.calls.map(([event]) => event.status)).toEqual(['failed']);
    expect(fixture.send).not.toHaveBeenCalled();
    await runner.fire(a.id, { trigger: 'manual' });
    expect(manager.createInstance).toHaveBeenCalledOnce();
    expect(store.listRuns({ automationId: a.id }).some(candidate => candidate.status === 'skipped')).toBe(true);
    await vi.advanceTimersByTimeAsync(5000); await flush();
    expect(manager.terminateInstance).toHaveBeenCalledTimes(2);
    expect(runner.hasStoppingRun(a.id)).toBe(false);
    expect(instances.has('root')).toBe(false);
    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', processedTokens: 8 });
    expect(terminal.mock.calls.map(([event]) => event.status)).toEqual(['failed']);
    expect(store.listPendingRetries()).toEqual([]);
  });
  it('accepts root success only after a removed child has an explicit settled accounting receipt', async () => {
    const run = await fire(); output(); const child = add('child', 'root'); idle('child');
    adapters.get('root')!.emit('complete', response('root')); await flush();
    const result = response('child'); const settle = deferResponseUsage(result); child.adapter.emit('complete', result); await flush();
    manager.emit('instance:removed', 'child'); instances.delete('child'); adapters.delete('child');
    expect(run().status).toBe('running');
    result.usage = { cacheReadTokens: 20, cacheWriteTokens: 20 }; settle(); await flush();
    expect(run()).toMatchObject({ status: 'succeeded', processedTokens: 40 });
    expect(terminal).toHaveBeenCalledOnce();
  });
  it('does not strand a removed child with an explicit zero-usage provider settlement', async () => {
    const run = await fire(); output(); const child = add('child', 'root'); idle('child');
    adapters.get('root')!.emit('complete', response('root')); await flush();
    const result = response('child'); const settle = deferResponseUsage(result); child.adapter.emit('complete', result); await flush();
    manager.emit('instance:removed', 'child'); instances.delete('child'); adapters.delete('child');
    expect(run().status).toBe('running');
    settle(); await flush();
    expect(run()).toMatchObject({ status: 'succeeded', processedTokens: 0 });
  });
  it.each(['graph_mail_send', 'graph_calendar_create_event', 'graph_calendar_update_event', 'graph_calendar_delete_event', 'graph_mail_create_draft'])('marks %s before the actual connector mutation, retaining ambiguous delivery on restart', async toolName => {
    const run = await fire(); add('child', 'root');
    const access = new ConnectorAccessRegistry(); access.grant('child', ['connector']);
    const fetch = vi.fn(async () => {
      expect(store.getRunFacts(run().id).deliveryStartedAt).not.toBeNull();
      throw new Error('ambiguous transport failure');
    });
    const account = { accountKey: 'account', username: 'sender@example.test', tenant: 'fixture-tenant', createdAt: 1, updatedAt: 1 };
    const graph = new GraphConnectorService({ authManager: { connectAccount: vi.fn(), listAccounts: async () => [], removeAccount: vi.fn() },
      listStoredAccounts: () => [account], writableAccountEmails: () => [account.username], updateWritableAccountEmails: vi.fn(),
      alwaysAllowedChanges: () => ({}), updateAlwaysAllowedChanges: vi.fn(),
      createGraphClient: requestContext => new GraphClient({ tokenProvider: { getAccessToken: async () => 'PLACEHOLDER_ACCESS' }, fetch, requestContext }),
    });
    const args = toolName === 'graph_mail_send' ? { messageId: 'draft' } : toolName === 'graph_calendar_delete_event' ? { eventId: 'event' }
      : toolName === 'graph_mail_create_draft' ? { subject: 'Example', body: { contentType: 'text', content: 'Example' }, toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }] }
      : { ...(toolName.includes('update') ? { eventId: 'event' } : {}), subject: 'Example', start: { dateTime: '2026-11-01T10:00:00', timeZone: 'UTC' }, end: { dateTime: '2026-11-01T11:00:00', timeZone: 'UTC' } };
    await expect(dispatchConnectorRpc('connectors.graph', 'child', { name: 'example', method: 'tools/call', params: { name: toolName, arguments: args } }, {
      access, repo: { list: () => [{ record: { id: 'connector', name: 'example', kind: 'microsoft365', autoConnect: true, accountId: 'account', mailEnabled: true } }] },
      auth: { getAccessToken: vi.fn() }, graph, authorizeMutation: async () => true,
    }, { beforeMutation: () => runner.markDeliveryStartedForCaller('child') })).rejects.toThrow('ambiguous transport failure');
    expect(fetch).toHaveBeenCalledOnce();
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never); fresh.initialize(manager as unknown as InstanceManager);
    expect(store.listPendingRetries()).toHaveLength(0);
    expect(store.getRunFacts(run().id).deliveryStartedAt).not.toBeNull();
  });
  it('binds the first loop invocation to its actual durable run and revokes the authenticated result route on completion', async () => {
    vi.useRealTimers();
    const a = await store.create({ name: 'Loop check', schedule: { type: 'cron', expression: '*/10 * * * *', timezone: 'UTC' },
      action: { prompt: 'Check', workingDirectory: '/repo', loop: { verifyCommand: 'example-command', isolateWorkspace: false } } }, 600_000, clock);
    const decision = store.decideAndInsertRun(a, 'manual', clock, clock);
    if (decision.kind !== 'started') throw new Error('No run');
    const server = new OrchestratorToolsRpcServer({ userDataPath: fixture.dir, registerCleanup: () => undefined,
      isKnownLocalInstance: () => false, canMintInstanceCapability: () => false, toolFactory: createAutomationToolDefinitions,
      automationResult: (result, meta) => runner.recordResult(meta.callerInstanceId, result),
    });
    await server.start();
    try {
      automationInvocations.configure((id, provider) => buildOrchestratorToolsMcpConfig({ aioMcpCliPath: 'test-cli', socketPath: server.getSocketPath()!,
        instanceId: id, capabilityToken: server.getInstanceCapability(id)!, provider, automationInvocation: true, exists: () => true })!);
      let env!: Record<string, string>;
      const adapter = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => undefined) }) as unknown as CliAdapter;
      const runtime = new ProviderRuntimeService({ createAdapter: input => { env = JSON.parse(input.options.mcpConfig![0]).mcpServers.orchestrator.env; return adapter; } });
      const terminalized = vi.fn();
      const dispatcher = new AutomationLoopRunDispatcher({ store, now: () => clock, onTerminal: terminalized, prepareConfig: async c => c,
        subscribeLoopStateChanged: vi.fn(), startLoop: async chatId => {
          runtime.createAdapter({ cliType: 'claude', options: { workingDirectory: '/repo', instanceId: chatId } });
          // The first request happens before startLoop returns or attaches a loop id.
          await new OrchestratorToolsRpcClient({ env }).call('orchestrator_tools.automation_result', { outcome: 'no_change', notify: false });
          return { id: 'loop-id' };
        },
      });
      await dispatcher.dispatch({ run: decision.run, automation: a, snapshot: decision.run.configSnapshot! });
      expect(store.getRun(decision.run.id)?.result).toEqual({ outcome: 'no_change', notify: false });
      expect(() => runner.recordResult('automation:forged:run', { outcome: 'done', notify: true })).toThrow();
      add('human');
      expect(() => runner.recordResult('human', { outcome: 'done', notify: true })).toThrow();
      expect(instances.get('human')?.status).toBe('busy');
      dispatcher.handleLoopStateChanged({ loopRunId: 'loop-id', state: { status: 'completed' } });
      expect(store.getRun(decision.run.id)).toMatchObject({ status: 'succeeded', result: { outcome: 'no_change', notify: false } });
      await expect(new OrchestratorToolsRpcClient({ env }).call('orchestrator_tools.automation_result', { outcome: 'done', notify: true })).rejects.toThrow();
      expect(terminalized).toHaveBeenCalledOnce(); expect(instances.get('human')?.status).toBe('busy');
    } finally { await server.stop(); }
  });
  it('enforces agent ceilings through authenticated RPC while preserving deliberate human form authority', async () => {
    vi.useRealTimers();
    const caller = { provider: 'claude', currentModel: 'sonnet', reasoningEffort: 'low' as 'low' | 'max', yoloMode: false };
    const tools = createAutomationToolImplementations({ store, runner, scheduler: { schedule: vi.fn(), deactivate: vi.fn() }, events: getAutomationEvents(),
      createWithScheduling: input => store.create(input, clock + 600_000, clock), handlePastOneTime: async () => undefined,
      resolveCaller: id => id === 'caller' ? caller : undefined, resolveWorkingDirectory: () => '/repo', now: () => clock,
    });
    const server = new OrchestratorToolsRpcServer({ userDataPath: fixture.dir, registerCleanup: () => undefined, isKnownLocalInstance: id => id === 'caller',
      toolFactory: createAutomationToolDefinitions, createAutomation: tools.createAutomation, updateAutomation: tools.updateAutomation });
    await server.start();
    try {
      const client = new OrchestratorToolsRpcClient({ env: { AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: server.getSocketPath()!,
        AI_ORCHESTRATOR_INSTANCE_ID: 'caller', AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY: server.getInstanceCapability('caller')! } });
      const created = await client.call('orchestrator_tools.create_automation', { name: 'Monitor server', prompt: 'Check status', cron: '*/10 * * * *', confirmedByUser: true }) as { id: string };
      expect((await store.get(created.id))?.action).toMatchObject({ model: 'sonnet', reasoningEffort: 'low', yoloMode: false });
      for (const change of [{ model: 'opus' }, { reasoningEffort: 'high' }, { yoloMode: true }]) {
        await expect(client.call('orchestrator_tools.update_automation', { id: created.id, ...change })).rejects.toThrow('calling session');
      }
      await expect(client.call('orchestrator_tools.update_automation', { id: created.id, model: 'opus', callerInstanceId: 'human' })).rejects.toThrow();
      caller.reasoningEffort = 'max';
      await client.call('orchestrator_tools.update_automation', { id: created.id, reasoningEffort: 'workflow' });
      expect((await store.get(created.id))?.action.reasoningEffort).toBe('max');
      const existing = (await store.get(created.id))!;
      const human = AutomationUpdatePayloadSchema.shape.updates.parse({ action: { ...existing.action, model: 'opus', reasoningEffort: 'workflow', yoloMode: true } });
      await store.update(created.id, human, undefined, clock);
      expect((await store.get(created.id))?.action).toMatchObject({ model: 'opus', reasoningEffort: 'workflow', yoloMode: true });
    } finally { await server.stop(); }
  });
  it('restarts a one-time job through the actual scheduler once, without a failure streak or duplicate scheduled fire', async () => {
    const a = await store.create({ name: 'Once', schedule: { type: 'oneTime', runAt: clock + 1000 },
      action: { prompt: 'Finish the report', workingDirectory: '/repo' } }, clock + 1000, clock);
    await runner.fire(a.id, { trigger: 'manual' });
    manager.removeAllListeners(); instances.clear(); adapters.clear();
    const fresh = new AutomationRunner(store, undefined, () => clock, (() => ({})) as never, undefined, undefined,
      () => ({ automationDefaultCli: 'claude', automationDefaultModel: 'sonnet', modelPickerFavorites: [] }), undefined,
      async (_r, _s, dispatch) => dispatch());
    fresh.initialize(manager as unknown as InstanceManager);
    const interrupted = store.listRuns({ automationId: a.id })[0];
    expect(interrupted.error).toBe('Interrupted by an app restart');
    const scheduler = new AutomationScheduler(store, fresh, { runResumeSweep: vi.fn() } as never, undefined, () => clock, async (_r, _s, dispatch) => dispatch());
    scheduler.initialize();
    clock += 15_000; await vi.advanceTimersByTimeAsync(15_000); await flush();
    expect(manager.createInstance).toHaveBeenCalledTimes(2);
    expect(manager.createInstance.mock.calls[1][0].initialPrompt).toContain('check what it already did before continuing');
    expect(store.listPendingRetries()).toHaveLength(0);
    output(); adapters.get('root')!.emit('complete', response('retry')); await flush();
    expect(store.listRuns({ automationId: a.id }).map(r => r.status).sort()).toEqual(['failed', 'succeeded']);
    expect(await store.get(a.id)).toMatchObject({ active: false, nextFireAt: null, consecutiveFailures: 0 });
    clock += 60_000; await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.createInstance).toHaveBeenCalledTimes(2); expect(store.listRuns({ automationId: a.id })).toHaveLength(2);
  });
});
