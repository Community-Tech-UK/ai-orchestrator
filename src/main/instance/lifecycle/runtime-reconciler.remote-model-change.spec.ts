import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { RuntimeReconcilerDeps } from './runtime-reconciler.types';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
const worker = vi.hoisted(() => ({ capability: 1 as number | undefined }));
const workerFactory = vi.hoisted(() => vi.fn());
vi.mock('../../cli/adapters/adapter-factory', () => ({ createCliAdapter: workerFactory }));
const registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: { instanceModelChange: worker.capability, claudeSpawnPolicy: 2, codexHelperPolicy: 1 } }) });
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../session/session-mutex', () => ({ getSessionMutex: () => ({ acquire: async () => () => undefined }) }));
vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({ writeThroughIdentityLocked: async () => undefined }),
  getSessionContinuityManagerIfInitialized: () => undefined,
}));
vi.mock('./create-validation-helpers', () => ({ getKnownModelsForCli: async () => ['sonnet', 'opus', 'gpt-5.4', 'gpt-5.5'] }));
vi.mock('../../cli/adapters/context-ceiling', () => ({ resolveContextCeilingTokens: () => undefined }));
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import { RuntimeReconciler } from './runtime-reconciler';
import { _resetAdapterLoansForTesting } from './adapter-loan-registry';
import { LocalInstanceManager } from '../../../worker-agent/local-instance-manager';
import { WorkerRpcDispatcher } from '../../../worker-agent/worker-rpc-dispatcher';
import { RPC_ERROR_CODES } from '../../remote-node/worker-node-rpc';
import { IdleMonitor } from './idle-monitor';
import { InstanceStateMachine } from '../instance-state-machine';
import type { ActivityStateDetector } from '../../providers/activity-state-detector';

describe('RuntimeReconciler remote model changes', () => {
  beforeEach(() => { registry.removeAllListeners(); worker.capability = 1; _resetAdapterLoansForTesting(); });
  async function harness(provider: 'claude' | 'codex' = 'claude') {
    const sendRpc = vi.fn().mockImplementation(async (_node, method, params) => method === 'instance.sendInput'
      ? undefined : { instanceId: params.replacement?.instanceId ?? params.instanceId });
    const connection = { sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer;
    const old = new RemoteCliAdapter(connection, 'worker', provider, { sessionId: 'old-session', workingDirectory: '/tmp', model: provider === 'claude' ? 'sonnet' : 'gpt-5.4' });
    await old.spawn();
    const instance = { id: 'session', sessionId: 'old-session', status: 'idle', provider, currentModel: provider === 'claude' ? 'sonnet' : 'gpt-5.4',
      workingDirectory: '/tmp', yoloMode: false, executionLocation: { type: 'remote', nodeId: 'worker' },
      outputBuffer: [{ type: 'user', content: 'hello' }, { type: 'assistant', content: 'hi' }],
      contextUsage: { used: 10, total: 200_000, percentage: 0.005 } } as unknown as Instance;
    let current: CliAdapter | undefined = old;
    const deps = {
      getInstance: () => instance, getAdapter: () => current, setAdapter: (_id: string, adapter: CliAdapter) => { current = adapter; },
      deleteAdapter: vi.fn(() => { current = undefined; return true; }), setupAdapterEvents: vi.fn(),
      transitionState: (value: Instance, status: Instance['status']) => { value.status = status; },
      resolveCliTypeForInstance: async () => provider,
      getAdapterRuntimeCapabilities: () => ({ supportsResume: true, supportsForkSession: false }),
      residentClaudeForSpawn: () => false,
      createRuntimeAdapter: vi.fn(async (_provider, options) => new RemoteCliAdapter(connection, 'worker', provider, options)),
      evaluateResumeHealth: vi.fn().mockResolvedValue('healthy'), waitForInputReadinessBoundary: async () => undefined,
      prepareStatusForAdapterInput: vi.fn(), buildReplayContinuityMessage: () => 'REPLAY HISTORY', buildFallbackHistory: async () => 'FALLBACK HISTORY',
      holdContinuityUntilAnswered: vi.fn(),
      emitModelSelectionDegradation: vi.fn(), emitSystemNotice: vi.fn(), emitRuntimeChanged: vi.fn(), emitYoloToggled: vi.fn(),
      getSettings: () => ({ defaultCli: provider }), queueUpdate: vi.fn(),
      spawnConfigBuilder: { getMcpConfig: () => undefined, getChromeDevtoolsMcpOptions: () => undefined,
        getBrowserGatewayMcpOptions: () => undefined, getPermissionHookPath: () => undefined, getRtkSpawnConfig: () => undefined },
    } as unknown as RuntimeReconcilerDeps;
    return { old, instance, deps, sendRpc, reconciler: new RuntimeReconciler(deps), current: () => current,
      cleanup: () => { old.forceCleanup(); if (current instanceof RemoteCliAdapter) current.forceCleanup(); } };
  }
  it('uses the real remote adapter through the shared Claude fresh-session and replay path', async () => {
    const h = await harness();
    try {
      await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus', reasoningEffort: 'high' });
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel', 'instance.sendInput']);
      expect(h.sendRpc.mock.calls[1][2]).toMatchObject({ previousInstanceId: 'old-session', replacement: { model: 'opus', reasoningEffort: 'high', resume: false, forkSession: false } });
      expect(h.instance.sessionId).not.toBe('old-session');
      expect(h.sendRpc.mock.calls[2][2].message).toContain('REPLAY HISTORY');
      expect(h.instance.currentModel).toBe('opus'); expect(h.old.isRunning()).toBe(false);
    } finally { h.cleanup(); }
  });
  it('retains native session continuity for a resumable non-Claude provider', async () => {
    const h = await harness('codex');
    try {
      await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' });
      expect(h.sendRpc.mock.calls[1][2]).toMatchObject({ previousInstanceId: 'old-session', replacement: { instanceId: 'old-session', resume: true } });
      expect(h.instance.sessionId).toBe('old-session'); expect(h.deps.evaluateResumeHealth).toHaveBeenCalled();
      expect(h.sendRpc.mock.calls[2][2].message).not.toContain('REPLAY HISTORY');
    } finally { h.cleanup(); }
  });
  it('rejects unsupported workers before detaching or changing the coordinator runtime', async () => {
    const h = await harness(); worker.capability = undefined;
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' })).rejects.toThrow(/Update the worker/);
      expect(h.deps.deleteAdapter).not.toHaveBeenCalled(); expect(h.current()).toBe(h.old);
      expect(h.instance.status).toBe('idle'); expect(h.instance.currentModel).toBe('sonnet'); expect(h.sendRpc).toHaveBeenCalledOnce();
    } finally { h.cleanup(); }
  });
  it('restores the previous runtime after a worker refusal without bypassing its guard', async () => {
    const h = await harness('codex'); h.sendRpc.mockRejectedValueOnce(new Error(`RPC error ${RPC_ERROR_CODES.MODEL_CHANGE_REJECTED}: A turn is still running.`));
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' })).rejects.toThrow(/still running/);
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel']);
      expect(h.current()).toBe(h.old); expect(h.instance.currentModel).toBe('gpt-5.4'); expect(h.instance.sessionId).toBe('old-session');
      expect(h.deps.evaluateResumeHealth).not.toHaveBeenCalled(); expect(h.old.isRunning()).toBe(true);
    } finally { h.cleanup(); }
  });
  it('retains the coordinator mid-turn guard before any remote request', async () => {
    const h = await harness(); h.instance.status = 'busy';
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' })).rejects.toThrow(/Model changes/);
      expect(h.sendRpc).toHaveBeenCalledOnce(); expect(h.deps.deleteAdapter).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
  function connectWorker(manager: LocalInstanceManager, sendRpc: ReturnType<typeof vi.fn>) {
    sendRpc.mockImplementation(async (_node, method, params) => new Promise((resolve, reject) => {
      const dispatcher = new WorkerRpcDispatcher({
        config: { workingDirectories: ['/tmp'] }, instanceManager: manager,
        sendResult: (_id: string | number, result: unknown) => resolve(result),
        // Match the real coordinator connection's error reconstruction.
        sendError: (_id: string | number, code: number, message: string) => reject(new Error(`RPC error ${code}: ${message}`)),
      } as unknown as ConstructorParameters<typeof WorkerRpcDispatcher>[0]);
      void dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, params });
    }));
  }
  function managedAdapter() {
    return Object.assign(new EventEmitter(), { spawn: vi.fn().mockResolvedValue(1), sendInput: vi.fn().mockResolvedValue(undefined),
      terminate: vi.fn().mockResolvedValue(undefined), interrupt: vi.fn() });
  }
  it('does not reattach the destroyed old runtime when actual worker replacement fails after teardown', async () => {
    const h = await harness(); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'claude', workingDirectory: '/tmp', model: 'sonnet' });
    workerOld.emit('status', 'idle'); workerFactory.mockImplementationOnce(() => { throw new Error('replacement spawn failed'); });
    connectWorker(manager, h.sendRpc);
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' })).rejects.toThrow(/replacement spawn failed/);
      expect(workerOld.terminate).toHaveBeenCalledOnce(); expect(manager.getInstance('old-session')).toBeUndefined();
      expect(h.old.isRunning()).toBe(false); expect(h.current()).not.toBe(h.old); expect(h.instance.status).toBe('error');
      expect(h.deps.setupAdapterEvents).not.toHaveBeenLastCalledWith(h.instance.id, h.old);
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it('retains an actual worker session refused before teardown without starting an unguarded fallback', async () => {
    const h = await harness('codex'); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'codex', workingDirectory: '/tmp', model: 'gpt-5.4' });
    workerOld.emit('status', 'busy'); connectWorker(manager, h.sendRpc);
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' })).rejects.toThrow(/Model changes/);
      expect(workerOld.terminate).not.toHaveBeenCalled(); expect(manager.getInstance('old-session')?.adapter).toBe(workerOld);
      expect(h.old.isRunning()).toBe(true); expect(h.current()).toBe(h.old);
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel']);
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it.each(['idle', 'ready', 'waiting_for_input'] as const)('keeps a refused %s worker session usable and out of zombie cleanup after the lifecycle lock releases', async previousStatus => {
    const h = await harness('codex'); const manager = new LocalInstanceManager(['/tmp']);
    h.instance.status = previousStatus;
    const machine = new InstanceStateMachine(previousStatus);
    h.deps.transitionState = (instance, status) => { machine.transition(status); instance.status = machine.current; };
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'codex', workingDirectory: '/tmp', model: 'gpt-5.4' });
    workerOld.emit('status', 'busy'); connectWorker(manager, h.sendRpc);
    const monitor = new IdleMonitor({
      getSettings: () => ({ autoTerminateIdleMinutes: 0 }), getRecoveryEngine: () => null,
      getActivityDetectors: () => new Map<string, ActivityStateDetector>(),
      getInstance: () => h.instance, getAdapter: h.current,
      forEachInstance: cb => cb(h.instance, h.instance.id),
      deleteAdapter: h.deps.deleteAdapter, transitionState: h.deps.transitionState,
      queueUpdate: vi.fn(), isLifecycleLocked: () => false,
      terminateInstance: async () => undefined, hibernateInstance: async () => undefined,
      dispatchRecovery: async () => undefined,
    });
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' })).rejects.toThrow(/Model changes/);
      monitor.cleanupZombieProcesses();
      expect(h.instance.status).toBe(previousStatus);
      expect(workerOld.terminate).not.toHaveBeenCalled();
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel']);
      workerOld.emit('status', 'idle');
      await expect(h.old.sendInput('Continue this retained conversation.')).resolves.toBeUndefined();
      expect(workerOld.sendInput).toHaveBeenCalledOnce();
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it('does not restore or respawn an old session when the transport cannot report the replacement outcome', async () => {
    const h = await harness('codex'); h.sendRpc.mockRejectedValueOnce(new Error('connection lost'));
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' })).rejects.toThrow(/connection lost/);
      expect(h.old.isRunning()).toBe(true); expect(h.current()).not.toBe(h.old);
      await expect(h.old.sendInput('unsafe')).rejects.toThrow(/stopping/);
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel']);
    } finally { h.cleanup(); }
  });
  it('keeps the local fresh-respawn fallback after a confirmed worker teardown and resume failure', async () => {
    const h = await harness('codex'); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'codex', workingDirectory: '/tmp', model: 'gpt-5.4' });
    workerOld.emit('status', 'idle'); const fresh = managedAdapter();
    workerFactory.mockImplementationOnce(() => { throw new Error('native resume failed'); }).mockReturnValue(fresh);
    connectWorker(manager, h.sendRpc);
    try {
      await h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'codex', model: 'gpt-5.5' });
      expect(workerOld.terminate).toHaveBeenCalledOnce(); expect(h.old.isRunning()).toBe(false); expect(h.current()).not.toBe(h.old);
      expect(h.sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel', 'instance.terminate', 'instance.spawn', 'instance.sendInput']);
      expect(h.sendRpc.mock.calls[2][2]).toEqual({ instanceId: h.sendRpc.mock.calls[1][2].replacement.instanceId });
      expect(h.instance.sessionId).not.toBe('old-session'); expect(manager.getInstance(h.instance.sessionId)?.adapter).toBe(fresh);
      expect(manager.getAllInstanceIds()).toEqual([h.instance.sessionId]);
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it.each(['claude', 'codex'] as const)('retains failed-stop ownership for cleanup and retry with %s continuity', async provider => {
    const h = await harness(provider); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: provider, workingDirectory: '/tmp' });
    workerOld.emit('status', 'idle');
    workerOld.terminate.mockRejectedValueOnce(new Error('First stop failed')).mockRejectedValueOnce(new Error('Cleanup stop failed'));
    connectWorker(manager, h.sendRpc);
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider, model: provider === 'claude' ? 'opus' : 'gpt-5.5' })).rejects.toThrow('First stop failed');
      expect(h.current()).not.toBe(h.old);
      expect(manager.getInstance('old-session')?.adapter).toBe(workerOld);
      await expect(h.old.sendInput('unsafe')).rejects.toThrow(/stopping/);
      const current = h.current() as RemoteCliAdapter;
      await expect(current.terminate()).rejects.toThrow('Cleanup stop failed');
      expect(manager.getInstance('old-session')?.adapter).toBe(workerOld);
      await current.terminate();
      expect(manager.getAllInstanceIds()).toEqual([]);
      expect(workerOld.terminate).toHaveBeenCalledTimes(3);
      expect(h.sendRpc.mock.calls.filter(call => call[1] === 'instance.spawn')).toHaveLength(1);
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it('stops both possible identities when the worker replaced successfully but its reply was lost', async () => {
    const h = await harness(); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'claude', workingDirectory: '/tmp' });
    workerOld.emit('status', 'idle'); const replacement = managedAdapter(); workerFactory.mockReturnValue(replacement);
    connectWorker(manager, h.sendRpc);
    const dispatch = h.sendRpc.getMockImplementation()!;
    h.sendRpc.mockImplementationOnce(async (node, method, params) => { await dispatch(node, method, params); throw new Error('Reply lost'); });
    try {
      await expect(h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' })).rejects.toThrow('Reply lost');
      const replacementId = h.sendRpc.mock.calls[1][2].replacement.instanceId;
      expect(replacementId).not.toBe('old-session'); expect(manager.getAllInstanceIds()).toEqual([replacementId]);
      await (h.current() as RemoteCliAdapter).terminate();
      expect(h.sendRpc.mock.calls.filter(call => call[1] === 'instance.terminate').map(call => call[2].instanceId)).toEqual(['old-session', replacementId]);
      expect(manager.getAllInstanceIds()).toEqual([]); expect(replacement.terminate).toHaveBeenCalledOnce();
    } finally { h.cleanup(); await manager.terminateAll(); }
  });
  it('cancels an in-flight replacement and confirms the original stopped before releasing cleanup', async () => {
    const h = await harness(); const manager = new LocalInstanceManager(['/tmp']);
    const workerOld = managedAdapter(); workerFactory.mockReturnValue(workerOld);
    await manager.spawn({ instanceId: 'old-session', cliType: 'claude', workingDirectory: '/tmp' });
    workerOld.emit('status', 'idle'); let stopped!: () => void;
    const factoryCallsBeforeChange = workerFactory.mock.calls.length;
    workerOld.terminate.mockImplementationOnce(() => new Promise<void>(resolve => { stopped = resolve; }));
    connectWorker(manager, h.sendRpc);
    const changing = h.reconciler.applyRuntimeChange(h.instance.id, { provider: 'claude', model: 'opus' }).catch(error => error);
    try {
      await vi.waitFor(() => expect(stopped).toBeTypeOf('function'));
      await (h.current() as RemoteCliAdapter).terminate();
      stopped();
      expect(await changing).toMatchObject({ message: expect.stringMatching(/cancelled/) });
      expect(manager.getAllInstanceIds()).toEqual([]); expect(workerFactory.mock.calls).toHaveLength(factoryCallsBeforeChange);
      expect(h.old.isRunning()).toBe(false);
    } finally { stopped?.(); await changing; h.cleanup(); await manager.terminateAll(); }
  });
});
