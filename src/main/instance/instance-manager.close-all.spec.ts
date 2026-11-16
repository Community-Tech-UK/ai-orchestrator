import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aio-test', isPackaged: false } }));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => undefined, getAll: () => ({}) }),
}));
vi.mock('../commands/command-manager', () => ({ getCommandManager: vi.fn() }));

import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { afterEach } from 'vitest';
afterEach(() => WorkAdmission._resetForTesting());

import { InstanceManager } from './instance-manager';

describe('InstanceManager deliberate Close all versus app quit', () => {
  it('closes a snapshot of each session gracefully through the normal public teardown', async () => {
    const sessions = [{ id: 'a' }, { id: 'b' }];
    const terminateInstance = vi.fn(async () => { sessions.length = 0; });
    const terminateAll = vi.fn();
    const receiver = {
      state: { getAllInstances: () => sessions },
      terminateInstance,
      lifecycle: { terminateAll },
    };
    await InstanceManager.prototype.terminateAllInstances.call(receiver as never);
    expect(terminateInstance.mock.calls).toEqual([['a', true], ['b', true]]);
    expect(terminateAll).not.toHaveBeenCalled();
  });

  it('retains the lifecycle bulk path for app quit', async () => {
    const terminateAll = vi.fn(async () => undefined);
    const terminateInstance = vi.fn();
    await InstanceManager.prototype.terminateAll.call({ lifecycle: { terminateAll }, terminateInstance } as never);
    expect(terminateAll).toHaveBeenCalledOnce();
    expect(terminateInstance).not.toHaveBeenCalled();
  });
});

describe('source update session start fencing', () => {
  it('does not confuse an idle retained helper with active consensus or a live user ask', () => {
    let consensus = 0; let asks: unknown[] = [];
    const receiver = { state: { getInstance: () => undefined }, orchestrationMgr: { hasActiveWork: () => true, getOrchestrationHandler: () => ({
      getActiveConsensusQueryCount: () => consensus, getPendingUserActionsForInstance: () => asks,
    }) } };
    expect(InstanceManager.prototype.hasActiveSessionWork.call(receiver as never, 'one')).toBe(false);
    consensus = 1;
    expect(InstanceManager.prototype.hasActiveSessionWork.call(receiver as never, 'one')).toBe(true);
    consensus = 0; asks = [{}];
    expect(InstanceManager.prototype.hasActiveSessionWork.call(receiver as never, 'one')).toBe(true);
  });

  it('accounts for asynchronous create and input preparation before a provider is active', async () => {
    let finish!: () => void;
    const receiver = Object.assign(Object.create(InstanceManager.prototype), {
      pendingSessionOperations: 0,
      createAdmittedInstance: () => new Promise<void>(resolve => { finish = resolve; }),
      sendAdmittedInput: () => new Promise<void>(resolve => { finish = resolve; }),
    });
    const creating = receiver.createInstance({ workingDirectory: '/tmp/project' });
    expect(receiver.hasPendingSourceUpdateOperations()).toBe(true); finish(); await creating;
    expect(receiver.hasPendingSourceUpdateOperations()).toBe(false);
    const sending = receiver.sendInput('one', 'input');
    expect(receiver.hasPendingSourceUpdateOperations()).toBe(true); finish(); await sending;
    expect(receiver.hasPendingSourceUpdateOperations()).toBe(false);
  });

  it('refuses direct restart, wake and provider changes during the handoff', async () => {
    const lease = getWorkAdmission().tryAcquireMaintenance();
    const receiver = Object.create(InstanceManager.prototype) as InstanceManager;
    try {
      await expect(InstanceManager.prototype.restartInstance.call(receiver, 'one')).rejects.toThrow('updating');
      await expect(InstanceManager.prototype.wakeInstance.call(receiver, 'one')).rejects.toThrow('updating');
      await expect(InstanceManager.prototype.changeModel.call(receiver, 'one', 'model')).rejects.toThrow('updating');
    } finally { lease?.release(); }
  });
  it('refuses direct create and send before any runtime or user-input side effects', async () => {
    const lease = getWorkAdmission().tryAcquireMaintenance();
    const receiver = Object.create(InstanceManager.prototype) as InstanceManager;
    await expect(InstanceManager.prototype.createInstance.call(receiver, { workingDirectory: '/tmp/project' })).rejects.toThrow('updating');
    await expect(InstanceManager.prototype.sendInput.call(receiver, 'one', 'input')).rejects.toThrow('updating');
    lease?.release();
  });
});
