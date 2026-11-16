import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInstanceRecord } from '../instance/lifecycle/instance-create-builder';
import type { AgentProfile } from '../../shared/types/agent.types';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { WorkAdmission } from '../work-admission/work-admission';
vi.mock('./source-update-maintenance-runtime', () => ({ createMaintenanceDependencies: vi.fn() }));
import { createSourceUpdateMaintenance, type SourceUpdateMaintenanceDependencies } from './source-update-maintenance';

function fixture() {
  const instance = { id: 'one', historyThreadId: 'thread', status: 'idle', provider: 'claude',
    workingDirectory: '/project', sessionId: 'native', providerSessionId: 'native', accountProfileId: 'account',
    lastActivity: 1, requestCount: 1, outputBuffer: [{ id: 'reply', type: 'assistant', content: 'private conversation', timestamp: 1 }],
  } as Instance;
  const instances = [instance];
  let busy = false;
  const entry = { id: 'history', originalInstanceId: 'one', historyThreadId: 'thread', provider: 'claude' as const,
    sessionId: 'native', workingDirectory: '/project', accountProfileId: 'account', nativeResumeFailedAt: undefined as number | undefined, isHiddenAutomation: undefined as boolean | undefined, hideFromProjectRail: undefined as boolean | undefined, executionLocation: undefined as Instance['executionLocation'] | undefined };
  const admission = new WorkAdmission();
  const archive = vi.fn(async () => undefined);
  const revive = vi.fn(async () => ({ status: 'revived' as const, instanceId: 'new' }));
  const deps = { admission, hasActiveWork: () => busy, hasSessionWork: () => false,
    archive, findHistoryEntry: () => entry, revive } satisfies SourceUpdateMaintenanceDependencies;
  const restoredInstance = { ...instance, id: 'new' };
  const manager = { getInstance: (id: string) => id === 'new' ? restoredInstance : instances.find(candidate => candidate.id === id), getAllInstances: () => instances, getAdapter: () => undefined } as unknown as InstanceManager;
  const maintenance = createSourceUpdateMaintenance(manager, deps);
  return { instance, instances, restoredInstance, entry, deps, admission, archive, revive, maintenance, setBusy: (value: boolean) => { busy = value; } };
}
afterEach(() => vi.restoreAllMocks());

describe('source update maintenance', () => {
  it('accepts an ordinary local session built with the real creation defaults', async () => {
    const h = fixture();
    const ordinary = buildInstanceRecord({ workingDirectory: '/project', provider: 'claude' },
      { id: 'build', mode: 'build' } as AgentProfile, { defaultYoloMode: false, getParent: () => undefined });
    ordinary.status = 'idle';
    expect(ordinary.nodePlacement).toBeUndefined(); expect(ordinary.modelRuntimeTarget).toBeUndefined();
    const manager = { getAllInstances: () => [ordinary], getAdapter: () => undefined } as unknown as InstanceManager;
    const maintenance = createSourceUpdateMaintenance(manager, { ...h.deps, findHistoryEntry: () => ({
      ...h.entry, originalInstanceId: ordinary.id, historyThreadId: ordinary.historyThreadId,
      sessionId: ordinary.sessionId, accountProfileId: ordinary.accountProfileId, executionLocation: ordinary.executionLocation,
    }) });
    const lease = await maintenance.tryAcquire();
    expect(lease?.sessions[0].instanceId).toBe(ordinary.id); lease?.release();
  });
  it.each(['isHiddenAutomation', 'hideFromProjectRail'] as const)('keeps archived %s threads hidden without blocking an update', async field => {
    const h = fixture(); h.entry[field] = true;
    const lease = await h.maintenance.tryAcquire();
    expect(lease).not.toBeNull(); expect(lease?.sessions).toEqual([]); lease?.release();
  });
  it('defers a local conversation whose placement preferences could move it on restore', async () => {
    const h = fixture(); h.instance.executionLocation = { type: 'local' }; h.entry.executionLocation = { type: 'local' }; h.instance.nodePlacement = {};
    expect(await h.maintenance.tryAcquire()).toBeNull();
  });
  it('defers a model target that the existing History restore cannot faithfully carry', async () => {
    const h = fixture(); h.instance.modelRuntimeTarget = { kind: 'local-model' } as Instance['modelRuntimeTarget'];
    expect(await h.maintenance.tryAcquire()).toBeNull();
  });
  it('does not indefinitely block an already initialized empty conversation', async () => {
    const h = fixture(); h.instance.outputBuffer = [];
    const lease = await h.maintenance.tryAcquire();
    expect(lease?.sessions).toHaveLength(1); lease?.release();
  });
  it('captures idle identity only, saves latest history and restores without replaying input', async () => {
    const h = fixture();
    const lease = await h.maintenance.tryAcquire();
    expect(lease?.sessions).toEqual([{ instanceId: 'one', historyEntryId: 'history', providerSessionId: 'native', workingDirectory: '/project', accountProfileId: 'account' }]);
    expect(JSON.stringify(lease?.sessions)).not.toContain('private conversation');
    expect(h.archive).toHaveBeenCalledWith(h.instance);
    expect(h.admission.check('helper-agent')).toMatchObject({ allowed: false });
    expect(lease?.recheck()).toBe(true);
    lease?.release();
    await h.maintenance.restore(lease!.sessions);
    expect(h.revive).toHaveBeenCalledWith(expect.objectContaining({ historyEntryId: 'history', reviveIfArchived: true, reason: 'source-update' }));
  });
  it.each(['busy', 'processing', 'thinking_deeply', 'initializing', 'waiting_for_input', 'waiting_for_permission', 'interrupting', 'hibernating', 'waking', 'respawning'] as const)('defers while a session is %s', async status => {
    const h = fixture(); h.instance.status = status;
    expect(await h.maintenance.tryAcquire()).toBeNull();
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.admission.isInMaintenance()).toBe(false);
  });
  it.each(['readyPromise', 'activeTurnId', 'waitReason'] as const)('defers while an idle session has %s', async field => {
    const h = fixture();
    Object.assign(h.instance, { [field]: field === 'readyPromise' ? Promise.resolve() : field === 'waitReason' ? { kind: 'quota-park' } : 'turn' });
    expect(await h.maintenance.tryAcquire()).toBeNull();
  });
  it('defers for running engines even when every conversation appears idle', async () => {
    const h = fixture(); h.setBusy(true);
    expect(h.maintenance.isIdle()).toBe(false);
    expect(await h.maintenance.tryAcquire()).toBeNull();
  });
  it.each(['hasActiveTurn', 'hasActiveToolCalls'] as const)('defers for adapter %s despite idle status', async probe => {
    const h = fixture();
    const manager = { getAllInstances: () => h.instances, getAdapter: () => ({ [probe]: () => true }) } as unknown as InstanceManager;
    expect(await createSourceUpdateMaintenance(manager, h.deps).tryAcquire()).toBeNull();
  });
  it('defers for a live permission ask despite idle status', async () => {
    const h = fixture();
    const manager = { getAllInstances: () => h.instances, getAdapter: () => ({ isRunning: () => true, livePermissions: { hasPending: () => true } }) } as unknown as InstanceManager;
    expect(await createSourceUpdateMaintenance(manager, h.deps).tryAcquire()).toBeNull();
  });
  it('rechecks engine work and session identity after saving, and releases on failure', async () => {
    const h = fixture(); h.archive.mockImplementation(async () => { h.setBusy(true); });
    expect(await h.maintenance.tryAcquire()).toBeNull();
    expect(h.admission.isInMaintenance()).toBe(false);
  });
  it('rejects changed session identity and new work between prepare and commit', async () => {
    const h = fixture(); const lease = await h.maintenance.tryAcquire();
    h.instance.requestCount++;
    expect(lease?.recheck()).toBe(false);
    lease?.release();
    expect(lease?.recheck()).toBe(false);
  });
  it('cannot release another owners lease on dispose or failure', async () => {
    const h = fixture(); const other = h.admission.tryAcquireMaintenance();
    expect(await h.maintenance.tryAcquire()).toBeNull(); h.maintenance.dispose();
    expect(h.admission.isInMaintenance()).toBe(true); other?.release();
  });
  it('releases if persistence fails and retains the existing live instance', async () => {
    const h = fixture(); h.archive.mockRejectedValue(new Error('disk failure'));
    await expect(h.maintenance.tryAcquire()).rejects.toThrow('disk failure');
    expect(h.admission.isInMaintenance()).toBe(false);
    expect(h.instances).toEqual([h.instance]);
  });
  it('refuses a session whose account or routing is not safely represented in History', async () => {
    const h = fixture(); h.instance.accountProfileId = 'other';
    expect(await h.maintenance.tryAcquire()).toBeNull();
    expect(h.admission.isInMaintenance()).toBe(false);
  });
  it('retains a safely replayable conversation with an explicitly spent native handle', async () => {
    const h = fixture(); h.entry.sessionId = 'old-native'; h.entry.nativeResumeFailedAt = 1;
    const lease = await h.maintenance.tryAcquire();
    expect(lease?.sessions).toHaveLength(1); lease?.release();
  });
  it('does not confirm restoration before the new provider has finished initializing', async () => {
    const h = fixture(); const lease = await h.maintenance.tryAcquire(); lease?.release();
    let ready!: () => void;
    h.restoredInstance.readyPromise = new Promise<void>(resolve => { ready = resolve; });
    let settled = false;
    const restoring = h.maintenance.restore(lease!.sessions).then(() => { settled = true; });
    await vi.waitFor(() => expect(h.revive).toHaveBeenCalledOnce());
    expect(settled).toBe(false); ready(); await restoring;
    expect(settled).toBe(true);
  });
  it('reports restoration failure without issuing a continuation', async () => {
    const h = fixture(); const lease = await h.maintenance.tryAcquire(); lease?.release();
    h.revive.mockResolvedValue({ status: 'failed', instanceId: undefined } as never);
    await expect(h.maintenance.restore(lease!.sessions)).rejects.toThrow('could not be reopened');
  });
});
