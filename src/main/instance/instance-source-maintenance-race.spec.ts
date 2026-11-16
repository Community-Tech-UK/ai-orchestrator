import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-test', isPackaged: false } }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }) }));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));
const resolveAgent = vi.hoisted(() => vi.fn());
vi.mock('../agents/agent-registry', () => ({ getAgentRegistry: () => ({ resolveAgent }) }));
vi.mock('../updates/source-update-maintenance-runtime', () => ({ createMaintenanceDependencies: vi.fn() }));
import { InstanceManager } from './instance-manager';
import { DesiredRuntimeQueue } from './lifecycle/desired-runtime-queue';
import { InstanceLifecycleManager } from './instance-lifecycle';
import { createSourceUpdateMaintenance } from '../updates/source-update-maintenance';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { getSessionMutex, _resetSessionMutexForTesting } from '../session/session-mutex';

afterEach(() => { WorkAdmission._resetForTesting(); _resetSessionMutexForTesting(); vi.clearAllMocks(); });
function fixture() {
  const instance = { id: 'one', status: 'idle', historyThreadId: 'thread', sessionId: 'native', providerSessionId: 'native',
    provider: 'claude', agentId: 'build', workingDirectory: '/project', restartEpoch: 0, restartCount: 0,
    executionLocation: { type: 'local' }, outputBuffer: [{ id: 'reply', type: 'assistant', content: 'finished', timestamp: 1 }],
  } as Instance;
  const lifecycle = { deps: { getInstance: () => instance, getAdapter: () => undefined } };
  const manager = Object.assign(Object.create(InstanceManager.prototype), {
    pendingSessionOperations: 0, lifecycle,
    orchestrationMgr: { getOrchestrationHandler: () => ({ getActiveConsensusQueryCount: () => 0, getPendingUserActionsForInstance: () => [] }) },
    state: { getInstance: () => instance, getAllInstances: () => [instance], getAdapter: () => undefined },
  }) as InstanceManager;
  const maintenance = createSourceUpdateMaintenance(manager, {
    admission: getWorkAdmission(), hasActiveWork: () => manager.hasPendingSourceUpdateOperations(), hasSessionWork: id => manager.hasActiveSessionWork(id),
    archive: async () => undefined,
    findHistoryEntry: () => ({ id: 'history', originalInstanceId: 'one', historyThreadId: 'thread', sessionId: 'native',
      provider: 'claude', workingDirectory: '/project', executionLocation: { type: 'local' } }),
    revive: async () => ({ status: 'live', instanceId: 'one' }),
  });
  return { instance, lifecycle, manager, maintenance };
}
describe('source restart admission during real delayed lifecycle work', () => {
  it('owns a lifecycle change from before its session mutex is acquired', async () => {
    const h = fixture(); const stop = new Error('Stop before changing the provider');
    resolveAgent.mockRejectedValue(stop);
    Object.assign(h.lifecycle, { changeAgentMode: (id: string, agent: string) => InstanceLifecycleManager.prototype.changeAgentMode.call(h.lifecycle as never, id, agent) });
    const unlock = await getSessionMutex().acquire('one', 'existing-operation');
    const changing = h.manager.changeAgentMode('one', 'plan').catch(error => error);
    let lease: Awaited<ReturnType<typeof h.maintenance.tryAcquire>>;
    try {
      expect(h.instance.status).toBe('idle'); expect(resolveAgent).not.toHaveBeenCalled();
      expect(h.manager.hasPendingSourceUpdateOperations()).toBe(true);
      lease = await h.maintenance.tryAcquire(); expect(lease).toBeNull();
    } finally { lease!?.release(); unlock(); await changing; h.maintenance.dispose(); }
    expect(h.manager.hasPendingSourceUpdateOperations()).toBe(false);
  });

  it('waits for a mode change paused in agent resolution before status changes', async () => {
    const h = fixture(); const stop = new Error('Stop the reproduction before any provider mutation');
    let rejectAgent!: (error: Error) => void;
    resolveAgent.mockImplementation(() => new Promise((_resolve, reject) => { rejectAgent = reject; }));
    Object.assign(h.lifecycle, { changeAgentMode: (id: string, agent: string) => InstanceLifecycleManager.prototype.changeAgentMode.call(h.lifecycle as never, id, agent) });
    const changing = h.manager.changeAgentMode('one', 'plan').catch(error => error);
    let lease: Awaited<ReturnType<typeof h.maintenance.tryAcquire>>;
    try {
      await vi.waitFor(() => expect(resolveAgent).toHaveBeenCalledOnce());
      expect(h.instance.status).toBe('idle');
      lease = await h.maintenance.tryAcquire();
      expect(lease).toBeNull();
      expect(h.manager.hasPendingSourceUpdateOperations()).toBe(true);
    } finally { lease!?.release(); rejectAgent(stop); await changing; h.maintenance.dispose(); }
    expect(h.manager.hasPendingSourceUpdateOperations()).toBe(false);
  });
  it('waits for restart teardown paused before the initializing status is published', async () => {
    const h = fixture(); let releaseTerminate!: () => void;
    const terminate = vi.fn(() => new Promise<void>(resolve => { releaseTerminate = resolve; }));
    Object.assign(h.lifecycle.deps, { getAdapter: () => ({ terminate }) });
    Object.assign(h.lifecycle, {
      restartInstance: (id: string) => InstanceLifecycleManager.prototype.restartInstance.call(h.lifecycle as never, id),
      resetTerminalStateForRestart: () => { throw new Error('Stop the reproduction before provider startup'); },
      disarmHoldsForRestart: () => undefined,
    });
    const restarting = h.manager.restartInstance('one').catch(error => error);
    let lease: Awaited<ReturnType<typeof h.maintenance.tryAcquire>>;
    try {
      await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
      expect(h.instance.status).toBe('idle');
      lease = await h.maintenance.tryAcquire();
      expect(lease).toBeNull();
      expect(h.manager.hasPendingSourceUpdateOperations()).toBe(true);
    } finally { lease!?.release(); releaseTerminate(); await restarting; h.maintenance.dispose(); }
    expect(h.manager.hasPendingSourceUpdateOperations()).toBe(false);
  });
});

const mutations: Record<string, (manager: InstanceManager) => Promise<unknown>> = {
  restartFreshInstance: manager => manager.restartFreshInstance('one'),
  changeAgentMode: manager => manager.changeAgentMode('one', 'plan'),
  toggleYoloMode: manager => manager.toggleYoloMode('one'),
  requestYoloModeToggle: manager => manager.requestYoloModeToggle('one'),
  failoverNow: manager => manager.failoverNow('one'),
  setYoloMode: manager => manager.setYoloMode('one', true),
  toggleFastMode: manager => manager.toggleFastMode('one'),
  setFastMode: manager => manager.setFastMode('one', true),
  changeModel: manager => manager.changeModel('one', 'model'),
  applyAccountHandoff: manager => manager.applyAccountHandoff('one', { provider: 'claude' } as never),
  requestModelChange: manager => manager.requestModelChange('one', {}),
  hibernateInstance: manager => manager.hibernateInstance('one'),
  wakeInstance: manager => manager.wakeInstance('one'),
  respawnAfterUnexpectedExit: manager => manager.respawnAfterUnexpectedExit('one'),
};
describe('admitted asynchronous session mutations', () => {
  it.each(Object.keys(mutations))('keeps %s owned through its wait and releases after failure', async method => {
    const h = fixture(); let reject!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, rejectOperation) => { reject = rejectOperation; });
    Object.assign(h.lifecycle, { [method]: () => operation });
    const outcome = mutations[method]!(h.manager).catch(error => error);
    let lease: Awaited<ReturnType<typeof h.maintenance.tryAcquire>>;
    try {
      expect(h.instance.status).toBe('idle');
      expect(h.manager.hasPendingSourceUpdateOperations()).toBe(true);
      lease = await h.maintenance.tryAcquire();
      expect(lease).toBeNull();
    } finally { lease!?.release(); reject(new Error('Operation ended')); await outcome; }
    expect(h.manager.hasPendingSourceUpdateOperations()).toBe(false);
    const after = await h.maintenance.tryAcquire(); expect(after).not.toBeNull(); after?.release(); h.maintenance.dispose();
  });
});

describe('parked runtime changes after the request has returned', () => {
  it.each(['apply', 'cancel'] as const)('keeps an acknowledged change visible until actual queue %s clears it', async completion => {
    const h = fixture(); h.instance.currentModel = 'old-model';
    const queue = new DesiredRuntimeQueue({
      getInstance: () => h.instance, isAdapterOnLoan: () => false,
      applyChange: async (_id, desired) => { h.instance.currentModel = desired.model; return h.instance; },
      publishPendingState: () => undefined, notifyApplyFailure: () => undefined,
    });
    Object.assign(h.lifecycle, { requestModelChange: (id: string, desired: object) => queue.requestChange(id, { provider: 'claude', ...desired }) });
    h.instance.status = 'busy';
    await h.manager.requestModelChange('one', { model: 'next-model' });
    expect(h.manager.hasPendingSourceUpdateOperations()).toBe(false);
    h.instance.status = 'idle';
    const before = await h.maintenance.tryAcquire(); const deferred = before === null; before?.release();
    if (completion === 'cancel') await h.manager.requestModelChange('one', { model: 'old-model' });
    else { queue.onSettled(h.instance); await queue.whenSettled('one'); }
    expect(h.instance.desiredRuntime).toBeUndefined();
    const after = await h.maintenance.tryAcquire(); after?.release(); h.maintenance.dispose();
    expect(deferred).toBe(true); expect(after).not.toBeNull();
  });
});
