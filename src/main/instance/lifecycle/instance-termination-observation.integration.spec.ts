import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { createInstance, type Instance } from '../../../shared/types/instance.types';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import type { CliResponse } from '../../cli/adapters/base-cli-adapter';
import { deferResponseUsage } from '../../cli/adapters/deferred-response-usage';
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import { markRemoteUsageSettlement } from '../../cli/adapters/remote-response-usage-settlement';
import { getWorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import { getCostTracker } from '../../core/system/cost-tracker';
import { subscribeCostAttribution, type CostAttributionRecord } from '../../core/system/cost-attribution';
import { ProviderRuntimeEventBus } from '../../providers/provider-runtime-event-bus';
import { toProviderOutputEvent } from '../../providers/provider-output-event';
import { InstanceCommunicationManager } from '../instance-communication';
import type { CommunicationDependencies } from '../instance-communication.types';
import { buildProviderRuntimeEventIngress } from '../instance-provider-event-ingress';
import { InstanceStateMachine } from '../instance-state-machine';
import { attachUsageOverageStopGuard, configureUsageOverageStop, resetUsageOverageStopForTesting } from '../instance-usage-overage-wiring';
import { InstanceTerminationCoordinator, type InstanceTerminationDeps } from './instance-termination';
import { deleteTurnSupervisor } from '../../session/session-turn-supervisor';

// Only host infrastructure is replaced: settings, disk storage, continuity,
// logging and executable plugin hooks. Communication, lifecycle, cost recording,
// attribution, deferred usage, state transitions and the provider bus are real.
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 1000, enableDiskStorage: false }) }),
}));
vi.mock('../../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../../remote-node/worker-node-registry', async () => {
  const { EventEmitter } = await import('node:events');
  const registry = new EventEmitter();
  return { getWorkerNodeRegistry: () => registry };
});
const hooks = vi.hoisted(() => ({ triggerLifecycleHooks: vi.fn(async () => ({ blocked: false })) }));
vi.mock('../../hooks/hook-manager', () => ({ getHookManager: () => hooks }));

function fixture() {
  const instance: Instance = {
    ...createInstance({ workingDirectory: '/synthetic/stop-observation', provider: 'claude', sessionId: 'live-provider-session' }),
    id: 'stop-observation', status: 'busy', currentModel: 'claude-sonnet-4-5',
    sessionId: 'live-provider-session', providerSessionId: 'live-provider-session',
    restartEpoch: 0, requestCount: 1, processId: 123,
    outputBuffer: [{ id: 'prompt', type: 'user', content: 'Check the work.', timestamp: 1 }],
    metadata: { spendPurpose: 'automation' },
  };
  const states = new InstanceStateMachine('busy');
  const instances = new Map([[instance.id, instance]]);
  const adapter = Object.assign(new EventEmitter(), {
    getName: () => 'claude-cli', getSessionId: () => 'live-provider-session',
    getCurrentTurnId: () => null, getPid: () => 123,
    terminate: vi.fn(async (_graceful?: boolean) => { adapter.emit('exit', 143, 'SIGTERM'); }),
  });
  const runtime = adapter as unknown as CliAdapter;
  const adapters = new Map([[instance.id, runtime]]);
  const events: ProviderRuntimeEventEnvelope[] = [];
  const order: string[] = [];
  const bus = new ProviderRuntimeEventBus(envelope => {
    events.push(envelope); order.push(envelope.event.kind);
  });
  const emit: NonNullable<CommunicationDependencies['emitProviderRuntimeEvent']> = (instanceId, event, options) => {
    const pending = buildProviderRuntimeEventIngress({ getInstance: id => instances.get(id), instanceId, event, options });
    if (pending) bus.enqueue(pending);
  };
  const effects: string[] = [];
  const transitionState: InstanceTerminationDeps['transitionState'] = (current, status) => {
    if (current.status !== status) states.transition(status);
    current.status = status;
  };
  const manager = new InstanceCommunicationManager({
    getInstance: id => instances.get(id), getAdapter: id => adapters.get(id),
    setAdapter: (id, value) => { adapters.set(id, value); }, deleteAdapter: id => adapters.delete(id),
    transitionState, queueUpdate: () => undefined,
    processOrchestrationOutput: () => { effects.push('orchestration'); },
    onInterruptedExit: async () => { effects.push('interrupt-respawn'); instance.sessionId = 'never-spawned-session'; },
    onUnexpectedExit: async () => { effects.push('unexpected-respawn'); instance.sessionId = 'never-spawned-session'; },
    onProviderLimitTurn: () => { effects.push('provider-resume'); return 'parked'; },
    onAuthFailureTurn: () => { effects.push('auth-replay'); },
    onStatusSettled: () => { effects.push('startup-recovery'); },
    onMcpServersStatus: () => { effects.push('mcp-recovery'); },
    compactContext: async () => { effects.push('compact-retry'); },
    ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined, emitProviderRuntimeEvent: emit,
  });
  manager.on('output', ({ instanceId, message, raw }) => emit(instanceId, toProviderOutputEvent(message), { raw }));
  manager.setupAdapterEvents(instance.id, runtime);
  const archives: { sessionId: string; providerSessionId: string; content: string[] }[] = [];
  const terminator = new InstanceTerminationCoordinator({
    getAdapter: id => adapters.get(id), getInstance: id => instances.get(id),
    deleteAdapter: id => adapters.delete(id), deleteInstance: id => instances.delete(id),
    forceReleaseSessionMutex: () => undefined, removeActivityDetector: () => undefined, clearRecoveryHistory: () => undefined,
    transitionState, terminateChild: async () => undefined, unregisterSupervisor: () => undefined,
    unregisterOrchestration: () => undefined, clearFirstMessageTracking: () => undefined, endRlmSession: () => undefined,
    deleteOutputStorage: async () => undefined, importTranscript: () => undefined, emitRemoved: () => undefined,
    archiveInstance: async current => { archives.push({ sessionId: current.sessionId,
      providerSessionId: current.providerSessionId, content: current.outputBuffer.map(message => message.content) }); },
  });
  const records: CostAttributionRecord[] = [];
  const unsubscribe = subscribeCostAttribution(record => { records.push(record); order.push('billed'); });
  return { instance, adapter, runtime, adapters, instances, events, order, effects, manager, terminator, archives, records,
    cleanup: () => { unsubscribe(); bus.flushPendingContext(); manager.cleanupCircuitBreaker(instance.id); deleteTurnSupervisor(instance.id); adapter.removeAllListeners(); } };
}

async function flush() { for (let index = 0; index < 20; index++) await Promise.resolve(); }

describe('deliberate termination preserves runtime observation until a successful stop', () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { vi.stubEnv('AIO_COST_ATTRIBUTION', '0'); hooks.triggerLifecycleHooks.mockClear(); getCostTracker().clearEntries(); f = fixture(); });
  afterEach(() => { f.cleanup(); resetUsageOverageStopForTesting(); getCostTracker().clearEntries(); vi.unstubAllEnvs(); });

  it('observes later errors and output, settles actual usage once, then retries the retained runtime', async () => {
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id, false)).rejects.toThrow('stop refused');
    expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
    expect(f.instances.get(f.instance.id)).toBe(f.instance);
    expect(f.archives).toEqual([]);
    expect(() => f.adapter.emit('error', new Error('later provider error'))).not.toThrow();
    f.adapter.emit('output', { id: 'answer', type: 'assistant', content: 'Final observed answer.', timestamp: 2 });
    const response: CliResponse = { id: 'settled-turn', role: 'assistant', content: 'Final observed answer.' };
    const settle = deferResponseUsage(response);
    try {
      f.adapter.emit('complete', response);
      f.adapter.emit('status', 'idle');
      await flush();
      expect(f.events.some(({ event }) => event.kind === 'error' && event.message === 'later provider error')).toBe(true);
      expect(f.instance.outputBuffer.map(message => message.content)).toContain('Final observed answer.');
      expect(f.events.filter(({ event }) => event.kind === 'complete')).toEqual([]);
      expect(f.records).toEqual([]);
      response.usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 0.25 };
      settle(); settle(); await flush();
      expect(f.records).toHaveLength(1);
      expect(f.records[0]).toMatchObject({ instanceId: f.instance.id, purpose: 'automation', costSource: 'provider',
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, cost: 0.25 } });
      expect(getCostTracker().getEntries()).toMatchObject([{ sessionId: 'live-provider-session', cost: 0.25 }]);
      expect(f.events.filter(({ event }) => event.kind === 'complete')).toHaveLength(1);
      expect(f.events.filter(({ event }) => event.kind === 'complete').map(({ event }) => event)).toEqual([
        { kind: 'complete', inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
          requestCountAtCompletion: 1, costUsd: 0.25, turnEnding: { reason: 'completed', evidence: 'provider_completed' } },
      ]);
      expect(f.order.indexOf('billed')).toBeLessThan(f.order.indexOf('complete'));
      expect(f.effects).toEqual([]);
      expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
      await f.terminator.terminateInstance(f.instance.id, false);
      expect(f.adapter.terminate.mock.calls).toEqual([[false], [false]]);
      expect(f.instances.has(f.instance.id)).toBe(false);
      expect(f.adapters.has(f.instance.id)).toBe(false);
      expect(f.archives).toEqual([{ sessionId: 'live-provider-session', providerSessionId: 'live-provider-session',
        // The transcript says it in plain words; the provider's own text stays in the message's Details.
        content: ['Check the work.', "Claude couldn't finish this request. What to do: Check Details, then try again. Your message and the work above are kept.", 'Final observed answer.'] }]);
      expect(f.effects).toEqual([]);
    } finally { settle(); await flush(); }
  });

  it.each([false, true])('observes deliberate exit without respawning or changing the archive anchor (interrupted=%s)', async interrupted => {
    if (interrupted) f.manager.markInterrupted(f.instance.id);
    await f.terminator.terminateInstance(f.instance.id);
    expect(f.events.filter(({ event }) => event.kind === 'exit').map(({ event }) => event)).toEqual([
      { kind: 'exit', code: 143, signal: 'SIGTERM' },
    ]);
    expect(f.effects).toEqual([]);
    expect(f.instance.restartCount).toBe(0);
    expect(f.archives[0]).toMatchObject({ sessionId: 'live-provider-session', providerSessionId: 'live-provider-session' });
    expect(f.manager.isInterrupted(f.instance.id)).toBe(false);
  });

  it('keeps observing a later exit after refusal without deleting the runtime or scheduling recent-exit recovery', async () => {
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    f.instance.lastRespawnAt = Date.now();
    f.manager.markInterrupted(f.instance.id);
    f.adapter.emit('exit', 1, null);
    await flush();
    expect(f.events.some(({ event }) => event.kind === 'exit')).toBe(true);
    expect(f.effects).toEqual([]);
    expect(f.instance.restartCount).toBe(0);
    expect(f.instance.sessionId).toBe('live-provider-session');
    expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
    expect(f.instance.processId).toBeNull();
    await f.terminator.terminateInstance(f.instance.id, false);
    expect(f.archives[0].sessionId).toBe('live-provider-session');
  });

  it.each(['Prompt is too long', 'user messages must have non-empty content'])('retains error output without recovery or silent cleanup: %s', async content => {
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    f.adapter.emit('output', { id: 'failure', type: 'error', content, timestamp: 2 });
    await flush();
    expect(f.instance.outputBuffer.map(message => message.content)).toContain(content);
    expect(f.effects).toEqual([]);
    expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
    expect(f.adapter.terminate).toHaveBeenCalledTimes(1);
  });

  it('publishes a provider-limit completion without rearming resume or startup recovery', async () => {
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    f.adapter.emit('complete', { id: 'limit', role: 'assistant', content: "You've hit your session limit", usage: { inputTokens: 5 } });
    f.adapter.emit('status', 'idle');
    f.adapter.emit('mcp_servers', []);
    await flush();
    expect(f.events.filter(({ event }) => event.kind === 'complete')).toHaveLength(1);
    expect(f.records).toHaveLength(1);
    expect(f.effects).toEqual([]);
    expect(hooks.triggerLifecycleHooks).not.toHaveBeenCalled();
  });

  it('still performs normal unexpected-exit recovery when no stop was requested', async () => {
    f.adapter.emit('exit', 1, null);
    await flush();
    expect(f.effects).toEqual(['unexpected-respawn']);
    expect(f.instance.restartCount).toBe(1);
    expect(f.instance.sessionId).toBe('never-spawned-session');
  });

  it('does not interrupt and rearm account failover from late provider telemetry after a refused stop', async () => {
    configureUsageOverageStop({
      getAllowOverageSetting: () => false,
      interruptInstance: () => { f.effects.push('overage-interrupt'); return true; },
      holdOnUsageLimit: () => { f.effects.push('overage-resume'); },
    });
    attachUsageOverageStopGuard(f.adapter, f.instance.id);
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    f.adapter.emit('rate-limit-telemetry', { status: 'rejected', rateLimitType: 'five_hour' });
    await flush();
    expect(f.effects).toEqual([]);
    expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
  });

  it('cancels an already scheduled recent-exit respawn when the subsequent stop refuses', async () => {
    vi.useFakeTimers();
    f.instance.lastRespawnAt = Date.now() - 4900;
    f.adapter.emit('exit', 1, null);
    expect(f.instance.status).toBe('respawning');
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.effects).toEqual([]);
    expect(f.instance.sessionId).toBe('live-provider-session');
    expect(f.adapters.get(f.instance.id)).toBe(f.runtime);
  });

  it('records deferred completion before removal when retry termination itself finalizes the usage', async () => {
    f.adapter.terminate.mockRejectedValueOnce(new Error('stop refused'));
    await expect(f.terminator.terminateInstance(f.instance.id)).rejects.toThrow('stop refused');
    const response: CliResponse = { id: 'finalized-by-stop', role: 'assistant', content: 'Settled during retry.' };
    const settle = deferResponseUsage(response);
    try {
      f.adapter.emit('complete', response);
      await flush();
      f.adapter.terminate.mockImplementationOnce(async () => {
        response.usage = { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, cost: 0.1 };
        settle();
        f.adapter.emit('exit', 143, 'SIGTERM');
      });
      await f.terminator.terminateInstance(f.instance.id);
      await flush();
      expect(f.records).toHaveLength(1);
      expect(f.events.filter(({ event }) => event.kind === 'complete')).toHaveLength(1);
      expect(f.order.indexOf('billed')).toBeLessThan(f.order.indexOf('complete'));
      expect(f.effects).toEqual([]);
    } finally { settle(); await flush(); }
  });

  it('observes real remote worker output and final usage after a refused stop, then retries that same remote identity', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ instanceId: 'live-provider-session' })
      .mockRejectedValueOnce(new Error('worker stop refused')).mockResolvedValueOnce(undefined);
    const connection = { sendRpc: rpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer;
    const remote = new RemoteCliAdapter(connection, 'fixture-worker', 'claude', {
      sessionId: 'live-provider-session', workingDirectory: '/synthetic/stop-observation',
    });
    const registry = getWorkerNodeRegistry();
    f.manager.setupAdapterEvents(f.instance.id, remote);
    f.adapters.set(f.instance.id, remote);
    try {
      await remote.spawn();
      remote.handleRemotePermissionRequest({ id: 'pending-approval', prompt: 'Approve?', timestamp: Date.now() });
      await expect(f.terminator.terminateInstance(f.instance.id, false)).rejects.toThrow('worker stop refused');
      remote.handleRemoteError('later remote error');
      registry.emit('remote:instance-output', { nodeId: 'fixture-worker', instanceId: 'live-provider-session',
        message: { id: 'remote-answer', type: 'assistant', content: 'Remote answer.', timestamp: 2 } });
      const response: CliResponse = { id: 'remote-turn', role: 'assistant', content: 'Remote answer.' };
      registry.emit('remote:instance-complete', { nodeId: 'fixture-worker', instanceId: 'live-provider-session',
        response: markRemoteUsageSettlement(response, 'pending') });
      await flush();
      expect(f.instance.outputBuffer.map(message => message.content)).toContain('Remote answer.');
      expect(f.events.filter(({ event }) => event.kind === 'complete')).toEqual([]);
      response.usage = { inputTokens: 11, outputTokens: 12, cacheReadTokens: 13, cacheWriteTokens: 14, cost: 0.5 };
      registry.emit('remote:instance-complete', { nodeId: 'fixture-worker', instanceId: 'live-provider-session',
        response: markRemoteUsageSettlement(response, 'settled') });
      await flush();
      expect(f.records).toHaveLength(1);
      expect(f.records[0].usage).toEqual({ inputTokens: 11, outputTokens: 12, cacheReadTokens: 13,
        cacheWriteTokens: 14, reasoningTokens: 0, cost: 0.5 });
      expect(f.events.filter(({ event }) => event.kind === 'complete')).toHaveLength(1);
      expect(f.adapters.get(f.instance.id)).toBe(remote);
      await expect(remote.sendInput('must not resume')).rejects.toThrow(/stopping/);
      await expect(remote.sendRaw('yes', 'pending-approval')).rejects.toThrow(/stopping/);
      await expect(remote.spawn()).rejects.toThrow(/stopping/);
      await f.terminator.terminateInstance(f.instance.id, false);
      expect(rpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.terminate', 'instance.terminate']);
      expect(f.archives[0]).toMatchObject({ sessionId: 'live-provider-session', providerSessionId: 'live-provider-session' });
      expect(f.effects).toEqual([]);
    } finally { remote.forceCleanup(); remote.removeAllListeners(); await flush(); }
  });
});
