import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { CliAdapter } from '../../main/cli/adapters/adapter-factory';
import type { CliResponse } from '../../main/cli/adapters/base-cli-adapter';
import type { WorkerNodeConnectionServer } from '../../main/remote-node/worker-node-connection';
import type { WorkerNodeRegistry } from '../../main/remote-node/worker-node-registry';
import type { RpcNotification, RpcRequest } from '../../main/remote-node/worker-node-rpc';
import type { Instance } from '../../shared/types/instance.types';

const registry = Object.assign(new EventEmitter(), { getNode: (id: string) => id === 'windows-pc' ? {} : undefined });
const hookState = vi.hoisted(() => ({ trigger: vi.fn().mockResolvedValue({ blocked: false }) }));
let native: import('../../main/cli/adapters/claude-cli-adapter').ClaudeCliAdapter;
let child: ChildProcess;
vi.mock('../../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => native }));
vi.mock('../../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../main/auth/remote-auth', () => ({ getRemoteAuthService: () => ({ validateSessionToken: () => true }) }));
vi.mock('../../main/pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../../main/memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../../main/hooks/hook-manager', () => ({ getHookManager: () => ({ triggerLifecycleHooks: hookState.trigger }) }));
vi.mock('../../main/context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('../../main/cli/adapters/claude-transcript-registry', () => ({ nativeTranscriptExists: () => true, nativeSessionIdInUse: () => false, readLastClaudeCostState: () => undefined }));
vi.mock('../../main/cli/adapters/base-cli-process-utils', () => ({ killProcessGroup: () => {
  queueMicrotask(() => child.emit('exit', 0, null)); return true;
} }));

import { ClaudeCliAdapter } from '../../main/cli/adapters/claude-cli-adapter';
import { RemoteCliAdapter } from '../../main/cli/adapters/remote-cli-adapter';
import { getCostTracker } from '../../main/core/system/cost-tracker';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../main/core/system/cost-attribution';
import { InstanceCommunicationManager } from '../../main/instance/instance-communication';
import { recordCompletionCost } from '../../main/instance/communication-completion-cost';
import { buildInstanceRecord } from '../../main/instance/lifecycle/instance-create-builder';
import { InstanceCompleteParamsSchema } from '../../main/remote-node/rpc-schemas';
import { RpcEventRouter } from '../../main/remote-node/rpc-event-router';
import { LocalInstanceManager, type SpawnParams } from '../local-instance-manager';
import { wireInstanceEvents } from '../worker-event-wiring';
import { WorkerInstanceNotifier } from '../worker-instance-notifier';
import { WorkerStreamDurability } from '../worker-stream-durability';

const result = (cost: number, input: number, output: number) => ({
  type: 'result', subtype: 'success', total_cost_usd: cost,
  usage: { input_tokens: 100, output_tokens: 20 },
  modelUsage: { 'claude-opus-5': { inputTokens: input, outputTokens: output, costUSD: cost } },
});
const partial = { type: 'assistant', message: { content: [{ type: 'text', text: 'Partial worker reply' }], usage: { input_tokens: 100, output_tokens: 20 } } };
const overloaded = { type: 'error', error: { code: 'overloaded_error', message: 'Fixture overloaded' } };

describe('native failed Claude turn → durable worker transport → controller cost booking', () => {
  let manager: LocalInstanceManager;
  let router: RpcEventRouter;
  let notifier: WorkerInstanceNotifier;
  let durability: WorkerStreamDurability;
  let remote: RemoteCliAdapter;
  let socketOpen: boolean;
  let frames: (RpcNotification | RpcRequest)[];
  let controllerResponses: CliResponse[];
  let nativeResponses: CliResponse[];
  let instance: Instance;
  let records: CostAttributionRecord[];
  let stop: () => void;
  let bookDirectly: boolean;

  async function startTransport(legacyCoordinator = false): Promise<void> {
    vi.stubEnv('AIO_COST_ATTRIBUTION', '0');
    registry.removeAllListeners(); getCostTracker().clearEntries();
    hookState.trigger.mockReset().mockResolvedValue({ blocked: false });
    socketOpen = true; bookDirectly = true; frames = []; controllerResponses = []; nativeResponses = []; records = [];
    stop = subscribeCostAttribution(row => records.push(row));
    native = new ClaudeCliAdapter({ sessionId: 'worker-instance', workingDirectory: '/tmp', residentClaude: true, model: 'claude-opus-5' });
    child = Object.assign(new EventEmitter(), { pid: 987654321, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), exitCode: null }) as unknown as ChildProcess;
    vi.spyOn(native as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockReturnValue(child);
    native.on('complete', response => nativeResponses.push(response));
    manager = new LocalInstanceManager(['/tmp']);
    const connection = Object.assign(new EventEmitter(), {
      sendNotification: vi.fn(), sendResponse: vi.fn(),
      sendRpc: vi.fn(async (_node: string, method: string, params: SpawnParams & { message: string }) => {
        if (method === 'instance.spawn') {
          const request = { ...params };
          if (legacyCoordinator) delete request.usageSettlementProtocol;
          await manager.spawn(request);
          return { instanceId: params.instanceId };
        }
        if (method === 'instance.sendInput') return manager.sendInput(params.instanceId, params.message);
        if (method === 'instance.terminate') return manager.terminate(params.instanceId);
        return { cursors: [] };
      }),
    });
    router = new RpcEventRouter(connection as unknown as WorkerNodeConnectionServer, registry as unknown as WorkerNodeRegistry);
    router.start(); durability = new WorkerStreamDurability();
    const socket = { get readyState() { return socketOpen ? 1 : 3; }, send(data: string, done?: () => void) {
      const frame = JSON.parse(data) as RpcNotification | RpcRequest; frames.push(frame);
      connection.emit('id' in frame ? 'rpc:request' : 'rpc:notification', 'windows-pc', frame);
      done?.();
    } } as unknown as WebSocket;
    notifier = new WorkerInstanceNotifier({ getSocket: () => socket, getToken: () => undefined, durability });
    wireInstanceEvents(manager, new EventEmitter(), notifier);
    remote = new RemoteCliAdapter(connection as unknown as WorkerNodeConnectionServer, 'windows-pc', 'claude',
      { instanceId: 'controller-instance', sessionId: 'worker-instance', workingDirectory: '/tmp', model: 'claude-opus-5' });
    instance = buildInstanceRecord({ sessionId: 'controller-session', provider: 'claude', modelOverride: 'claude-opus-5', workingDirectory: '/tmp', metadata: {} },
      { id: 'build', name: 'Fixture', description: 'Fixture agent', mode: 'build', color: '#000000', icon: 'hammer', builtin: true,
        permissions: { read: 'allow', write: 'allow', bash: 'allow', web: 'allow', task: 'allow' } },
      { defaultYoloMode: false, getParent: () => undefined });
    instance.id = 'controller-instance'; instance.status = 'busy'; instance.requestCount = 1;
    remote.on('complete', response => { controllerResponses.push(response); if (bookDirectly) recordCompletionCost(instance.id, instance, response); });
    await remote.spawn();
  }
  beforeEach(() => startTransport());

  afterEach(async () => {
    remote.forceCleanup(); await native.terminate(false); await manager.terminateAll();
    notifier.flushOutputBuffer(); router.stop(); stop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); getCostTracker().clearEntries();
  });

  function emit(...values: unknown[]): void {
    child.stdout?.emit('data', Buffer.from(values.map(value => JSON.stringify(value)).join('\n') + '\n'));
  }
  function completeFrames(): (RpcNotification | RpcRequest)[] { return frames.filter(frame => frame.method === 'instance.complete'); }

  it.each([[false, false], [false, true], [true, false], [true, true]] as const)('serializes one settled row per turn, offline=%s, sameChunk=%s', async (offline, sameChunk) => {
    await remote.sendInput('First'); emit(result(0.5, 100, 20));
    expect(controllerResponses).toHaveLength(1);
    socketOpen = !offline;
    await remote.sendInput('Failed');
    if (sameChunk) emit(partial, overloaded, result(0.75, 200, 40));
    else {
      emit(partial, overloaded);
      expect(nativeResponses).toHaveLength(2); // Native/UI completion stays immediate.
      expect(controllerResponses).toHaveLength(offline ? 1 : 2); // Semantic completion stays early.
      expect(getCostTracker().getEntries()).toHaveLength(1); // Only billing awaits native usage.
      expect(completeFrames()).toHaveLength(offline ? 1 : 2);
      if (!offline) expect(frames.some(frame => frame.method === 'instance.stateChange' && (frame.params as { state?: unknown })?.state === 'idle')).toBe(true);
      notifier.flushOutputBuffer();
      emit(result(0.75, 200, 40));
    }
    expect(nativeResponses).toHaveLength(2);
    if (offline) {
      expect(controllerResponses).toHaveLength(1);
      socketOpen = true;
      notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    }
    expect(controllerResponses).toHaveLength(2);
    expect(controllerResponses[1].metadata?.['turnErrored']).toBe(true);
    expect(controllerResponses[1].usage).toMatchObject({ cost: 0.25, byModel: [{ model: 'claude-opus-5', inputTokens: 100, outputTokens: 20, costUsd: 0.25 }] });
    await remote.sendInput('Final'); emit(result(1, 300, 60));
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(nativeResponses).toHaveLength(3); expect(controllerResponses).toHaveLength(3);
    expect(completeFrames().every(frame => InstanceCompleteParamsSchema.safeParse(frame.params).success)).toBe(true);
    expect(controllerResponses.every(response => response.metadata?.['aioRemoteUsageSettlement'] === undefined)).toBe(true);
    expect(controllerResponses.map(response => response.usage?.cost)).toEqual([0.5, 0.25, 0.25]);
    expect(controllerResponses[2].usage?.byModel).toEqual([{ model: 'claude-opus-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 }]);
    expect(getCostTracker().getEntries()).toHaveLength(3);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(1, 8);
    expect(instance.contextUsage.costEstimate).toBeCloseTo(1, 8);
    expect(records).toHaveLength(3);
    expect(records.every(row => row.instanceId === 'controller-instance' && row.provider === 'claude')).toBe(true);
    const storedCompletions = durability.replayAfter('worker-instance', 0).events.filter(event => event.method === 'instance.complete');
    expect(storedCompletions).toHaveLength(4);
    const semanticFrames = storedCompletions.filter(event => (event.params['response'] as CliResponse).metadata?.['aioRemoteUsageSettlement'] !== 'settled');
    expect(semanticFrames).toHaveLength(3);
    const finalization = storedCompletions.find(event => (event.params['response'] as CliResponse).metadata?.['aioRemoteUsageSettlement'] === 'settled');
    expect((finalization?.params['response'] as CliResponse).id).toBe(controllerResponses[1].id);
    expect(storedCompletions.filter(event => (event.params['response'] as CliResponse).metadata?.['aioRemoteUsageSettlement'] !== 'pending')
      .map(event => (event.params['response'] as CliResponse).usage?.cost)).toEqual([0.5, 0.25, 0.25]);
    expect(nativeResponses.every(response => Object.values(response).every(value => !(value instanceof Promise)))).toBe(true);
    expect(storedCompletions.every(event => Object.values(event.params['response'] as CliResponse).every(value => !(value instanceof Promise)))).toBe(true);
  });

  it('attributes delayed failed completion to its old controller request after newer remote input', async () => {
    bookDirectly = false;
    const published: { kind: string; requestCountAtCompletion?: number }[] = [];
    const toolState = vi.fn();
    const communication = new InstanceCommunicationManager({
      getInstance: () => instance, getAdapter: () => remote as CliAdapter, setAdapter: vi.fn(), deleteAdapter: () => false,
      queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), onToolStateChange: toolState,
      emitProviderRuntimeEvent: (_id, event) => published.push(event),
    });
    communication.setupAdapterEvents(instance.id, remote as CliAdapter);
    await remote.sendInput('Failed old request'); emit(partial, overloaded);
    expect(nativeResponses).toHaveLength(1); expect(controllerResponses).toHaveLength(1);
    expect(getCostTracker().getEntries()).toHaveLength(0);
    instance.requestCount = 2;
    await remote.sendInput('Newer request');
    toolState.mockClear();
    emit(result(0.25, 100, 20));
    await vi.waitFor(() => expect(controllerResponses).toHaveLength(1));
    expect(nativeResponses).toHaveLength(1); // The old result cannot finish the new native input.
    expect(controllerResponses[0].metadata?.['turnErrored']).toBe(true);
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(published.filter(event => event.kind === 'complete')).toEqual([
      expect.objectContaining({ requestCountAtCompletion: 1 }),
    ]);
    expect(toolState).not.toHaveBeenCalledWith(instance.id, 'idle');
    expect(hookState.trigger.mock.calls.filter(call => call[0] === 'Stop')).toHaveLength(1);
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'New reply' }] } });
    emit(result(0.5, 200, 40));
    await vi.waitFor(() => expect(controllerResponses).toHaveLength(2));
    expect(controllerResponses[1].content).toBe('New reply');
    expect(published.filter(event => event.kind === 'complete').at(-1)).toMatchObject({ requestCountAtCompletion: 2 });
    expect(hookState.trigger.mock.calls.filter(call => call[0] === 'Stop')).toHaveLength(2);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(0.5, 8);
  });

  it.each(['terminate', 'force-cleanup', 'exit'] as const)('settles pending controller billing once on remote %s cleanup', async ending => {
    await remote.sendInput('Failed before transport cleanup'); emit(partial, overloaded);
    expect(controllerResponses).toHaveLength(1); expect(getCostTracker().getEntries()).toHaveLength(0);
    if (ending === 'terminate') await remote.terminate(false);
    else if (ending === 'force-cleanup') remote.forceCleanup();
    else remote.handleRemoteExit(0, null);
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(records).toHaveLength(1); expect(records[0].costSource).toBe('priced');
    expect(registry.listenerCount('remote:instance-complete')).toBe(0);
    // A late finalization after teardown cannot produce a second completion or charge.
    if (ending !== 'terminate') emit(result(0.25, 100, 20));
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(controllerResponses).toHaveLength(1); expect(getCostTracker().getEntries()).toHaveLength(1);
  });

  it('flushes one honest fallback when the worker terminates without a trailing result', async () => {
    await remote.sendInput('Failed without native result'); emit(partial, overloaded);
    expect(nativeResponses).toHaveLength(1); expect(controllerResponses).toHaveLength(1);
    expect(getCostTracker().getEntries()).toHaveLength(0);
    await manager.terminate('worker-instance');
    expect(controllerResponses).toHaveLength(1);
    expect(controllerResponses[0].metadata?.['turnErrored']).toBe(true);
    expect(controllerResponses[0].usage?.cost).toBeUndefined();
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(records).toHaveLength(1); expect(records[0].costSource).toBe('priced');
    expect(durability.replayAfter('worker-instance', 0).events.filter(event => event.method === 'instance.complete')).toHaveLength(2);
    expect(native.listenerCount('complete')).toBe(1); // Only this test's raw observer remains.
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(getCostTracker().getEntries()).toHaveLength(1);
  });

  it('keeps native paid finalization available during the awaited controller termination RPC', async () => {
    await remote.sendInput('Failed before controller termination'); emit(partial, overloaded);
    expect(controllerResponses).toHaveLength(1);
    expect(getCostTracker().getEntries()).toHaveLength(0);
    const terminating = remote.terminate(false);
    await Promise.resolve(); await Promise.resolve();
    emit(result(0.25, 100, 20));
    await terminating;
    expect(controllerResponses).toHaveLength(1);
    expect(getCostTracker().getEntries()).toHaveLength(1);
    expect(getCostTracker().getSummary().totalCost).toBeCloseTo(0.25, 8);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costSource: 'provider', costKnown: true, usage: { cost: 0.25 } });
    expect(registry.listenerCount('remote:instance-complete')).toBe(0);
  });

  it('keeps a legacy controller on one early completion when it did not opt into settlement updates', async () => {
    await remote.terminate(false); notifier.flushOutputBuffer(); router.stop(); stop(); vi.restoreAllMocks();
    await startTransport(true);
    // Legacy RemoteCliAdapter forwards every completion notification unchanged.
    vi.spyOn(remote, 'handleRemoteComplete').mockImplementation(response => remote.emit('complete', response));
    await remote.sendInput('First'); emit(result(0.5, 100, 20));
    await remote.sendInput('Failed'); emit(partial, overloaded);
    expect(controllerResponses).toHaveLength(2);
    expect(completeFrames()).toHaveLength(2);
    emit(result(0.75, 200, 40));
    expect(controllerResponses).toHaveLength(2);
    expect(getCostTracker().getEntries()).toHaveLength(2);
    expect(completeFrames()).toHaveLength(2);
    expect(controllerResponses[1].metadata?.['turnErrored']).toBe(true);
    expect(controllerResponses.every(response => response.metadata?.['aioRemoteUsageSettlement'] === undefined)).toBe(true);
    notifier.replayDurableEvents([{ instanceId: 'worker-instance', afterSeq: 0 }]);
    expect(controllerResponses).toHaveLength(2);
  });
});
