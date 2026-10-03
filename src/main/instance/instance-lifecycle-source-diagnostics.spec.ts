import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { getDefaultAgent } from '../../shared/types/agent.types';
import { getMocks, makeHarness, makeFakeAdapter } from './__tests__/instance-lifecycle-source-diagnostics.fixture';
import { InstanceManager } from './instance-manager';
vi.mock('../process/resource-governor', () => ({ getResourceGovernor: () => ({ getCreationBlockReason: () => 'memory-critical' }) }));

const mocks = getMocks();
const source = 'local_source_sink_sentinel';
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item instanceof Error
    ? Object.fromEntries(Object.getOwnPropertyNames(item).map((key) => [key, Reflect.get(item, key)])) : item);
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdapter.mockReset();
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
  });
    mocks.continuityStartTracking.mockResolvedValue(undefined);
    mocks.continuityStopTracking.mockResolvedValue(undefined);
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.continuityMarkNativeResumeFailed.mockResolvedValue(undefined);
    mocks.continuityUpdateState.mockResolvedValue(undefined);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockImplementation((config: InstanceCreateConfig) =>
      config.modelRuntimeTarget?.kind === 'local-model' && config.modelRuntimeTarget.nodeId
      ? { type: 'remote', nodeId: config.modelRuntimeTarget.nodeId }
      : { type: 'local' });
    mocks.getKnownModelsForCli.mockResolvedValue([]);
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
    mocks.logManager!.clearBuffer();
  });
describe('actual high-level native failure and recovery source diagnostics', () => {
  it.each(['spawn', 'rlm', 'initial-send', 'hibernate', 'wake', 'restart-fresh', 'rollback-cleanup', 'nudge', 'create-summary', 'title'] as const)('%s keeps source visible and out of the real sink', async (mode) => {
    const harness = makeHarness(); const adapter = makeFakeAdapter();
    const failure = Object.assign(new Error(source), { cause: new Error(source), code: source, metadata: { source } });
    mocks.createAdapter.mockReturnValue(adapter);
    if (mode === 'title') mocks.maybeGenerateTitle.mockImplementationOnce((id: string, _prompt: string, callback: (id: string, title: string, source: string) => void) => { callback(id, source, 'ai'); return Promise.resolve(); });
    if (mode === 'spawn' || mode === 'rollback-cleanup') adapter.spawn.mockRejectedValueOnce(failure);
    if (mode === 'rlm') harness.initializeRlm.mockRejectedValueOnce(failure);
    if (mode === 'initial-send') adapter.sendInput.mockRejectedValueOnce(failure);
    if (mode === 'rollback-cleanup') harness.endRlmSession.mockImplementationOnce(() => { throw failure; });
    const log = vi.spyOn(mocks.logManager!, 'log'); const logError = vi.spyOn(mocks.logManager!, 'logError');
    let instance: Instance | undefined;
    try {
      instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude',
        initialPrompt: source, displayName: source, attachments: [{ name: source, type: 'text/plain', size: 1, data: 'x' }],
        initialOutputBuffer: [{ id: 'local-output', timestamp: 1, type: 'assistant', content: source, metadata: { [source]: source } }] });
      const ready = instance.readyPromise;
      if (mode === 'spawn' || mode === 'rlm' || mode === 'rollback-cleanup') {
        await expect(ready).rejects.toBe(failure); expect(serialize(instance.outputBuffer)).toContain(source);
      } else {
        await ready;
        expect(adapter.sendInput).toHaveBeenCalledWith(source, expect.any(Array));
        expect(serialize(instance.outputBuffer)).toContain(source);
        if (mode === 'hibernate') { adapter.terminate.mockRejectedValueOnce(failure); await expect(harness.manager.hibernateInstance(instance.id)).rejects.toBe(failure); }
        if (mode === 'wake') { await harness.manager.hibernateInstance(instance.id); adapter.spawn.mockRejectedValueOnce(failure); await expect(harness.manager.wakeInstance(instance.id)).rejects.toBe(failure); }
        if (mode === 'restart-fresh') { adapter.spawn.mockRejectedValueOnce(failure); await harness.manager.restartFreshInstance(instance.id); expect(instance.status).toBe('error'); }
        if (mode === 'nudge') {
          const owner = harness.manager as unknown as { interruptRespawn: { interrupt(id: string): boolean }; dispatchRecoveryActions(id: string, failure: unknown): Promise<void> };
          vi.spyOn(owner.interruptRespawn, 'interrupt').mockReturnValue(true);
          await owner.dispatchRecoveryActions(instance.id, { context: { sendInterrupt: true, injectMessage: source } });
          expect(adapter.sendInput).toHaveBeenLastCalledWith(source);
          expect(mocks.logManager!.getRecentLogs().some((row) => row.message === 'Recovery action: interrupted and injected message after respawn')).toBe(true);
        }
      }
      const rows = mocks.logManager!.getRecentLogs(); expect(rows.length).toBeGreaterThan(0);
      const diagnostics: Record<typeof mode, string> = { spawn: 'Failed to spawn/initialize CLI', rlm: 'Instance background init failed',
        'initial-send': 'Initial prompt failed after successful spawn; preserving session', hibernate: 'Failed to hibernate instance',
        wake: 'Failed to wake instance', 'restart-fresh': 'Failed to restart CLI with fresh context', 'rollback-cleanup': 'Spawn transaction rollback action failed',
        nudge: 'Recovery action: interrupted and injected message after respawn', 'create-summary': 'Creating instance', title: 'Auto-title callback (lifecycle)' };
      expect(rows.some((row) => row.message === diagnostics[mode])).toBe(true);
      if (mode === 'title') expect(instance?.displayName).toBe(source);
      expect(serialize(rows)).not.toContain(source);
      expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(source);
    } finally { harness.manager.destroy(); }
  });
});

describe('real manager logging callers preserve their original payload', () => {
  it('forwards original input-required metadata while logging only diagnostics', async () => {
    const communication = new EventEmitter(); const state = Object.assign(new EventEmitter(), { isInstancePending: () => false });
    const lifecycle = new EventEmitter(); const handleInputRequired = vi.fn();
    Reflect.get(InstanceManager.prototype, 'setupEventForwarding').call({ state, communication, lifecycle, permissionRequests: { handleInputRequired } });
    const payload = { instanceId: 'local-instance', requestId: 'local-request', timestamp: 1, prompt: source,
      metadata: { type: source, action: source, path: source, permissionKey: source } };
    const log = vi.spyOn(mocks.logManager!, 'log'); const logError = vi.spyOn(mocks.logManager!, 'logError');
    communication.emit('input-required', payload);
    expect(handleInputRequired).toHaveBeenCalledWith(payload); expect(handleInputRequired.mock.calls[0][0]).toBe(payload);
    expect(mocks.logManager!.getRecentLogs().some((row) => row.message === 'Input-required event received')).toBe(true);
    expect(serialize(mocks.logManager!.getRecentLogs())).not.toContain(source);
    expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(source);
  });
  it('rejects resource-blocked creation without exposing native prompt/config bodies', async () => {
    const log = vi.spyOn(mocks.logManager!, 'log'); const logError = vi.spyOn(mocks.logManager!, 'logError');
    const config = { workingDirectory: '/tmp/project', initialPrompt: source,
      attachments: [{ name: source, type: 'text/plain', size: 1, data: source }],
      initialOutputBuffer: [{ id: 'local-output', timestamp: 1, type: 'user' as const, content: source, metadata: { source } }] };
    await expect(InstanceManager.prototype.createInstance.call({} as InstanceManager, config)).rejects.toThrow('memory-critical');
    expect(config.initialPrompt).toBe(source); expect(config.initialOutputBuffer[0].content).toBe(source);
    expect(mocks.logManager!.getRecentLogs().some((row) => row.message.startsWith('Refusing to create instance'))).toBe(true);
    expect(serialize(mocks.logManager!.getRecentLogs())).not.toContain(source);
    expect(serialize([log.mock.calls, logError.mock.calls])).not.toContain(source);
  });
});
