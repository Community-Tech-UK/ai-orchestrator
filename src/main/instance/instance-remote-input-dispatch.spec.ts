import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance } from '../../shared/types/instance.types';

const lifecycleHookMocks = vi.hoisted(() => ({
  triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }),
  }),
}));
vi.mock('../memory/output-storage', () => ({
  getOutputStorageManager: () => ({ storeMessages: vi.fn() }),
}));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'system' }) }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 0 }) }));
vi.mock('../hooks/hook-manager', () => ({
  getHookManager: () => ({
    triggerHooks: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: lifecycleHookMocks.triggerLifecycleHooks,
  }),
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../core/error-recovery', () => ({
  getErrorRecoveryManager: () => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
  }),
}));

import { InstanceCommunicationManager } from './instance-communication';

const holder = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock('../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => holder.registry }));
vi.mock('../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { GlobalPauseService } from '../global-pause/global-pause-service';
import { RemoteCliAdapter } from '../cli/adapters/remote-cli-adapter';
const admission = vi.hoisted(() => ({ recordUserSend: vi.fn(() => ({ admissionId: 'fixture-admission' })), markDelivered: vi.fn(), markFailed: vi.fn() }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => admission }));

describe('communication to remote prompt admission', () => {
  it.each(['cross-session', 'timed-continuation'] as const)('holds %s delivery at a delayed native provider checkpoint', async mode => {
    WorkAdmission._resetForTesting();
    holder.registry = new EventEmitter();
    const instance = createInstance();
    let held = false, releaseCheckpoint!: () => void;
    const pause = Object.assign(new EventEmitter(), { holdsAutomaticInput: () => held, manualInput: vi.fn() });
    const peek = vi.spyOn(GlobalPauseService, 'peek').mockReturnValue(pause as unknown as GlobalPauseService);
    const checkpoint = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { releaseCheckpoint = resolve; })).mockResolvedValue(undefined);
    const sendRpc = vi.fn(async (_node: string, _method: string, _params: unknown) => ({ instanceId: instance.id }));
    const adapter = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as never, 'worker', 'opencode', {
      sessionId: instance.id, workingDirectory: '/tmp', beforeProviderPrompt: checkpoint,
    });
    await adapter.spawn();
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(), deleteAdapter: vi.fn(() => true), queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn() });
    let finished = false;
    const sending = manager.sendInput(instance.id, 'Helper result', undefined, undefined, mode === 'cross-session' ? { crossSessionSourceId: 'helper' } : { autoContinuation: true }).then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
      if (mode === 'cross-session') held = true; else getWorkAdmission().setGlobalPhase('holding');
      releaseCheckpoint();
      await new Promise<void>(resolve => setImmediate(resolve));
      const beforeResume = { finished, sent: sendRpc.mock.calls.filter(call => call[1] === 'instance.sendInput').length };
      held = false; getWorkAdmission().setGlobalPhase('none'); pause.emit('state-changed'); await sending;
      expect(beforeResume).toEqual({ finished: false, sent: 0 });
      expect(sendRpc.mock.calls.filter(call => call[1] === 'instance.sendInput')).toHaveLength(1);
      expect(pause.manualInput).not.toHaveBeenCalled();
    } finally { held = false; getWorkAdmission().setGlobalPhase('none'); pause.emit('state-changed'); releaseCheckpoint?.(); await sending; peek.mockRestore(); adapter.forceCleanup(); manager.cleanupCircuitBreaker(instance.id); WorkAdmission._resetForTesting(); }
  });

  it.each([
    [false, 'checkpoint'], [true, 'checkpoint'], [false, 'admission'], [true, 'admission'],
  ] as const)('keeps cancelled input unsent and receipts accurate (autoContinuation=%s, cancellation=%s)', async (autoContinuation, cancelAt) => {
    holder.registry = new EventEmitter();
    const instance = createInstance();
    let release!: () => void;
    const checkpoint = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; })).mockResolvedValue(undefined);
    const sendRpc = vi.fn(async (_node: string, _method: string, _params: unknown) => ({ instanceId: instance.id }));
    const adapter = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as never, 'worker', 'opencode', {
      sessionId: instance.id, workingDirectory: '/tmp', beforeProviderPrompt: checkpoint,
    });
    await adapter.spawn();
    const createSnapshot = vi.fn(); const onToolStateChange = vi.fn();
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(), deleteAdapter: vi.fn(() => true), queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), createSnapshot, onToolStateChange });
    const abort = new AbortController();
    const commit = vi.fn(() => { instance.requestCount++; if (cancelAt === 'admission') abort.abort(); });
    const add = vi.spyOn(abort.signal, 'addEventListener'); const remove = vi.spyOn(abort.signal, 'removeEventListener');
    admission.recordUserSend.mockClear(); admission.markDelivered.mockClear(); admission.markFailed.mockClear();
    let receiptCount = 0;
    admission.recordUserSend.mockImplementation(() => ({ admissionId: `fixture-admission-${++receiptCount}` }));
    manager.queueContinuityPreamble(instance.id, 'CONTINUITY');
    adapter.queueNextPromptContext('ACCOUNT');
    const sending = manager.sendInput(instance.id, 'cancelled input', undefined, undefined, { autoContinuation, signal: abort.signal, beforeProviderDispatch: commit });
    const result = sending.then(() => 'resolved', (error: Error) => error.name);
    try {
      await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
      expect(commit).not.toHaveBeenCalled();
      expect(admission.recordUserSend).not.toHaveBeenCalled();
      if (cancelAt === 'checkpoint') abort.abort();
      release();
      expect(await result).toBe(autoContinuation ? 'resolved' : 'AbortError');
      expect(sendRpc.mock.calls.filter(call => call[1] === 'instance.sendInput')).toHaveLength(0);
      expect(commit).toHaveBeenCalledTimes(cancelAt === 'admission' ? 1 : 0);
      const cancelledAdmissions = cancelAt === 'admission' ? 1 : 0;
      expect(admission.recordUserSend).toHaveBeenCalledTimes(cancelledAdmissions);
      expect(admission.markDelivered).not.toHaveBeenCalled();
      expect(admission.markFailed).toHaveBeenCalledTimes(cancelledAdmissions);
      if (cancelledAdmissions) expect(admission.markFailed).toHaveBeenCalledWith('fixture-admission-1', expect.stringContaining('cancelled'));
      expect(createSnapshot).not.toHaveBeenCalled();
      expect(onToolStateChange).not.toHaveBeenCalled();
      for (const call of add.mock.calls) expect(remove).toHaveBeenCalledWith(call[0], call[1]);
      commit.mockClear();
      await manager.sendInput(instance.id, 'next input', undefined, undefined, { beforeProviderDispatch: commit });
      const rpc = sendRpc.mock.calls.filter(call => call[1] === 'instance.sendInput');
      expect(rpc).toHaveLength(1);
      expect(rpc[0][2]).toEqual({ instanceId: instance.id, message: 'ACCOUNT\n\nCONTINUITY\n\nnext input', attachments: undefined });
      expect(commit).toHaveBeenCalledOnce();
      expect(admission.recordUserSend).toHaveBeenCalledTimes(cancelledAdmissions + 1);
      expect(admission.markDelivered).toHaveBeenCalledOnce();
      expect(admission.markDelivered).toHaveBeenCalledWith(`fixture-admission-${cancelledAdmissions + 1}`);
      expect(admission.markFailed).toHaveBeenCalledTimes(cancelledAdmissions);
      expect(createSnapshot).toHaveBeenCalledOnce();
      expect(onToolStateChange).toHaveBeenCalledOnce();
    } finally { release?.(); adapter.forceCleanup(); manager.cleanupCircuitBreaker(instance.id); }
  });

  it('records one admitted receipt across an asynchronous attachment retry and releases its abort listener', async () => {
    holder.registry = new EventEmitter();
    const instance = createInstance();
    let promptCalls = 0;
    const sendRpc = vi.fn(async (_node: string, method: string, _params: unknown) => {
      if (method === 'instance.sendInput' && ++promptCalls === 1) {
        await Promise.resolve();
        throw new Error('Fixture provider does not support attachments in orchestrator mode');
      }
      return { instanceId: instance.id };
    });
    const adapter = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as never, 'worker', 'opencode', {
      sessionId: instance.id, workingDirectory: '/tmp', beforeProviderPrompt: async () => undefined,
    });
    await adapter.spawn();
    const manager = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as unknown as CliAdapter,
      setAdapter: vi.fn(), deleteAdapter: vi.fn(() => true), queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(),
      onInterruptedExit: vi.fn().mockResolvedValue(undefined), ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn() });
    const abort = new AbortController(); const commit = vi.fn();
    const add = vi.spyOn(abort.signal, 'addEventListener'); const remove = vi.spyOn(abort.signal, 'removeEventListener');
    admission.recordUserSend.mockReset(); admission.recordUserSend.mockReturnValue({ admissionId: 'retry-admission' });
    admission.markDelivered.mockClear(); admission.markFailed.mockClear();
    manager.queueContinuityPreamble(instance.id, 'CONTINUITY');
    try {
      await manager.sendInput(instance.id, 'work', [{ name: 'fixture.txt', type: 'text/plain', size: 0, data: '' }], undefined, {
        signal: abort.signal, beforeProviderDispatch: commit,
      });
      const prompts = sendRpc.mock.calls.filter(call => call[1] === 'instance.sendInput');
      expect(prompts).toHaveLength(2);
      expect(prompts.map(call => call[2])).toEqual([
        { instanceId: instance.id, message: 'CONTINUITY\n\nwork', attachments: [{ name: 'fixture.txt', type: 'text/plain', size: 0, data: '' }] },
        { instanceId: instance.id, message: 'CONTINUITY\n\nwork', attachments: undefined },
      ]);
      expect(commit).toHaveBeenCalledOnce();
      expect(admission.recordUserSend).toHaveBeenCalledOnce();
      expect(admission.markFailed).toHaveBeenCalledExactlyOnceWith('retry-admission', expect.stringContaining('does not support attachments'));
      expect(admission.markDelivered).toHaveBeenCalledExactlyOnceWith('retry-admission');
      for (const call of add.mock.calls) expect(remove).toHaveBeenCalledWith(call[0], call[1]);
      await manager.sendInput(instance.id, 'next');
      expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.sendInput', { instanceId: instance.id, message: 'next', attachments: undefined }, 0);
    } finally { adapter.forceCleanup(); manager.cleanupCircuitBreaker(instance.id); }
  });
});
function createInstance(): Instance {
  return {
    id: 'instance-1', displayName: 'Cancellation', createdAt: 1,
    historyThreadId: 'history-1',
    parentId: null, childrenIds: [], supervisorNodeId: '', depth: 0,
    terminationPolicy: 'terminate-children', launchMode: 'orchestrated',
    executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build', agentMode: 'build', planMode: { enabled: false, state: 'off' },
    status: 'idle', contextUsage: { used: 0, total: 1_000, percentage: 0 },
    lastActivity: 1, processId: 1, sessionId: 'session-1',
    providerSessionId: 'provider-session-1', restartEpoch: 0,
    workingDirectory: '/tmp', yoloMode: false, provider: 'opencode',
    outputBuffer: [], outputBufferMaxSize: 100,
    communicationTokens: new Map(), subscribedTo: [], totalTokensUsed: 0,
    requestCount: 0, errorCount: 0, restartCount: 0,
  };
}
