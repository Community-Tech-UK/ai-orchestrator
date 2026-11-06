/**
 * The FIRST spawn of an interactive Claude session must carry the RTK trial
 * arm (plan 18b item 5). The respawn and reconciler call sites are covered in
 * `interrupt-respawn-handler.rtk-arm.spec.ts` and
 * `runtime-reconciler.runtime-change.spec.ts`; this drives the real
 * `createInstance` path so deleting the first-spawn `stampRtkArm(...)` call in
 * `instance-lifecycle.ts` fails here. Without it a new trial session carries
 * no arm on its instance, every cost row for it is unlabelled, and the Step
 * 18b trial cannot be measured.
 *
 * The real manager runs against the shared lifecycle fixture; only
 * `getRtkSpawnConfig` is replaced, with the config shapes the real resolver
 * returns (`resolveRtkSpawnConfig` in `rtk-rollout.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();
type Harness = ReturnType<typeof makeHarness>;

function stubRtkConfig(harness: Harness, build: (key: string) => unknown) {
  const builder = (harness.manager as unknown as {
    spawnConfigBuilder: { getRtkSpawnConfig(key?: string): unknown };
  }).spawnConfigBuilder;
  return vi.spyOn(builder, 'getRtkSpawnConfig').mockImplementation((key?: string) =>
    key === undefined ? undefined : build(key));
}

const onArm = (key: string) => ({
  enabled: true,
  binaryPath: '/placeholder/rtk',
  yoloHookPath: '/placeholder/rtk-defer-hook.mjs',
  rtkArm: 'on',
  rtkTrialEligible: true,
  rtkTrialKey: key,
});

const offArm = (key: string) => ({
  enabled: true,
  binaryPath: '/placeholder/rtk',
  rtkArm: 'off',
  rtkTrialEligible: true,
  rtkTrialKey: key,
});

describe('InstanceLifecycleManager.createInstance stamps the RTK trial arm on the first spawn', () => {
  let harness: Harness;
  let adapter: ReturnType<typeof makeFakeAdapter>;
  const trialConfig: InstanceCreateConfig = {
    workingDirectory: '/tmp/project',
    provider: 'claude',
    initialPrompt: 'hello',
    yoloMode: true,
  };

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

  it('hands the adapter the config from getRtkSpawnConfig and records the arm on the instance', async () => {
    const spy = stubRtkConfig(harness, onArm);

    const instance = await harness.manager.createInstance(trialConfig);
    await instance.readyPromise;

    expect(spy).toHaveBeenCalledWith(instance.id);
    expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
    expect(mocks.createAdapter).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({
        rtk: expect.objectContaining({ rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: instance.id }),
      }),
    }));
    // The stamp is what cost rows read (communication-completion-cost.ts).
    expect(instance.metadata).toMatchObject({
      rtkArm: 'on',
      rtkTrialEligible: true,
      rtkTrialKey: instance.id,
    });
  });

  it('records the off arm too, so the control group is measurable', async () => {
    stubRtkConfig(harness, offArm);

    const instance = await harness.manager.createInstance(trialConfig);
    await instance.readyPromise;

    expect(mocks.createAdapter).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ rtk: expect.objectContaining({ rtkArm: 'off' }) }),
    }));
    expect(instance.metadata).toMatchObject({
      rtkArm: 'off',
      rtkTrialEligible: true,
      rtkTrialKey: instance.id,
    });
  });

  it('records no arm when the session is not eligible (not in YOLO mode)', async () => {
    stubRtkConfig(harness, onArm);

    const instance = await harness.manager.createInstance({ ...trialConfig, yoloMode: false });
    await instance.readyPromise;

    expect(instance.metadata?.['rtkArm']).toBeUndefined();
    expect(instance.metadata?.['rtkTrialEligible']).toBeUndefined();
    expect(instance.metadata?.['rtkTrialKey']).toBeUndefined();
  });
});
