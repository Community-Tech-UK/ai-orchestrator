/**
 * Every Claude spawn in InstanceLifecycleManager asks for its RTK config with
 * the instance id as the trial key (plan 18b item 4). The key is what keeps a
 * session in the same trial group across respawns, so a call that passes
 * nothing (or a different id) silently changes the group. The six call sites:
 * create, wake, native resume after restart, replay fallback after restart,
 * fresh restart and agent-mode change. Runtime-reconciler is covered in
 * `runtime-reconciler.runtime-change.spec.ts`.
 *
 * The real manager runs against the shared lifecycle fixture; only
 * `getRtkSpawnConfig` is replaced, with a stub that answers only for a real
 * instance id, so a wrong or missing key produces no `rtk` option at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();
type Harness = ReturnType<typeof makeHarness>;

function armRtk(harness: Harness) {
  const builder = (harness.manager as unknown as {
    spawnConfigBuilder: { getRtkSpawnConfig(key?: string): unknown };
  }).spawnConfigBuilder;
  const isInstanceId = (key?: string): key is string =>
    key !== undefined && (harness.instances.has(key) || harness.pendingInstances.has(key));
  return vi.spyOn(builder, 'getRtkSpawnConfig').mockImplementation((key?: string) => isInstanceId(key)
    ? {
        enabled: true,
        binaryPath: '/placeholder/rtk',
        yoloHookPath: '/placeholder/rtk-defer-hook.mjs',
        rtkArm: 'on',
        rtkTrialEligible: true,
        rtkTrialKey: key,
      }
    : undefined);
}

function expectKeyedByInstance(spy: ReturnType<typeof armRtk>, instanceId: string): void {
  expect(spy).toHaveBeenCalledWith(instanceId);
  expect(spy.mock.calls.every(([key]) => key === instanceId)).toBe(true);
  expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
    options: expect.objectContaining({ rtk: expect.objectContaining({ rtkTrialKey: instanceId }) }),
  }));
}

describe('InstanceLifecycleManager passes the instance id as the RTK trial key', () => {
  let harness: Harness;
  let adapter: ReturnType<typeof makeFakeAdapter>;
  const createConfig: InstanceCreateConfig = { workingDirectory: '/tmp/project', provider: 'claude', initialPrompt: 'hello' };

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
      supportsResume: true,
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
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.getKnownModelsForCli.mockResolvedValue([]);
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
    harness = makeHarness();
    adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
  });
  afterEach(() => harness.manager.destroy());

  it('createInstance', async () => {
    const spy = armRtk(harness);
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;

    expectKeyedByInstance(spy, instance.id);
  });

  it('wakeInstance', async () => {
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;
    await harness.manager.hibernateInstance(instance.id);
    const spy = armRtk(harness);

    await harness.manager.wakeInstance(instance.id);

    expectKeyedByInstance(spy, instance.id);
  });

  it('restartInstance native resume', async () => {
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;
    instance.providerSessionId = 'provider-session-1';
    // With the old adapter gone, resume capability comes from the provider registry.
    harness.adapters.delete(instance.id);
    const spy = armRtk(harness);

    await harness.manager.restartInstance(instance.id);

    expect(instance.recoveryMethod).toBe('native');
    expectKeyedByInstance(spy, instance.id);
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ resume: true }),
    }));
  });

  it('restartInstance replay fallback', async () => {
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;
    instance.sessionResumeBlacklisted = true;
    const spy = armRtk(harness);

    await harness.manager.restartInstance(instance.id);

    expect(instance.recoveryMethod).toBe('replay');
    expectKeyedByInstance(spy, instance.id);
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      options: expect.objectContaining({ resume: false }),
    }));
  });

  it('restartFreshInstance', async () => {
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;
    const spy = armRtk(harness);

    await harness.manager.restartFreshInstance(instance.id);

    expectKeyedByInstance(spy, instance.id);
  });

  it('changeAgentMode', async () => {
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;
    const spy = armRtk(harness);

    await harness.manager.changeAgentMode(instance.id, 'plan');

    expect(instance.agentId).toBe('plan');
    expectKeyedByInstance(spy, instance.id);
  });
});
