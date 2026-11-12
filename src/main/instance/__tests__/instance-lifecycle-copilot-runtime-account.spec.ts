import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import type { CopilotRouteOutcome } from '../../../shared/types/copilot-account.types';
import type { CopilotAccountRoutingService } from '../../providers/copilot/copilot-account-routing-service';
import { _resetAdapterLoansForTesting } from '../lifecycle/adapter-loan-registry';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const routing = vi.hoisted(() => ({
  resolveRouteForSpawn: vi.fn<CopilotAccountRoutingService['resolveRouteForSpawn']>(),
  profileId: 'personal',
}));
vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => routing,
}));
vi.mock('../lifecycle/model-change-provider-swap', async (original) => ({
  ...await original<typeof import('../lifecycle/model-change-provider-swap')>(),
  assertSwapTargetCliAvailable: vi.fn().mockResolvedValue(undefined),
}));

const mocks = getMocks();
type Harness = ReturnType<typeof makeHarness>;

describe('switching an existing session to Copilot validates its routed account', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetAdapterLoansForTesting();
    routing.profileId = 'personal';
    routing.resolveRouteForSpawn.mockReset().mockImplementation(async (input): Promise<CopilotRouteOutcome> => ({
      ok: true,
      route: {
        profileId: input.persistedProfileId ?? routing.profileId,
        source: input.persistedProfileId ? 'persisted' : 'default',
        executionNodeId: input.executionNodeId ?? 'local',
      },
    }));
    mocks.createAdapter.mockReset().mockReturnValue(makeFakeAdapter());
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: true, supportsForkSession: false, supportsNativeCompaction: false,
      supportsPermissionPrompts: false, supportsDeferPermission: false, selfManagedAutoCompaction: false,
    });
    mocks.continuityStartTracking.mockResolvedValue(undefined);
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.continuityUpdateState.mockResolvedValue(undefined);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
    mocks.getKnownModelsForCli.mockReset().mockImplementation(async (provider: string, profileId?: string) =>
      provider !== 'copilot' ? ['sonnet'] : profileId === 'personal' ? ['auto', 'gpt-4.1'] : ['auto', 'claude-opus-5.5']);
    harness = makeHarness();
  });

  afterEach(() => { harness.manager.destroy(); _resetAdapterLoansForTesting(); });

  async function claudeSession() {
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project', provider: 'claude', modelOverride: 'sonnet',
    });
    await instance.readyPromise;
    mocks.getKnownModelsForCli.mockClear();
    mocks.createAdapter.mockClear();
    mocks.resolveCliType.mockResolvedValue('copilot');
    return instance;
  }

  it.each([
    { profileId: 'personal', expectedModel: 'auto' },
    { profileId: 'work', expectedModel: 'claude-opus-5.5' },
  ])('routes to $profileId before selecting $expectedModel', async ({ profileId, expectedModel }) => {
    const instance = await claudeSession();
    routing.profileId = profileId;
    await harness.manager.changeModel(instance.id, 'claude-opus-5.5', undefined, undefined, 'copilot');

    expect(mocks.getKnownModelsForCli).toHaveBeenCalledExactlyOnceWith('copilot', profileId);
    expect(routing.resolveRouteForSpawn).toHaveBeenCalledTimes(1);
    expect(routing.resolveRouteForSpawn.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getKnownModelsForCli.mock.invocationCallOrder[0]!);
    expect(instance).toMatchObject({ provider: 'copilot', currentModel: expectedModel, copilotAccountProfileId: profileId });
    expect(mocks.createAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      options: expect.objectContaining({ model: expectedModel, copilotAccountRoute: expect.objectContaining({ profileId }) }),
    }));
  });

  it('restores the previous Copilot stamp if destination construction fails after stamping', async () => {
    const instance = await claudeSession();
    instance.copilotAccountProfileId = 'work';
    instance.copilotRoutingSource = 'path-prefix';
    instance.copilotRoutingRuleId = 'example-rule';
    mocks.createAdapter.mockImplementationOnce(() => { throw new Error('Example construction failure'); });
    await expect(harness.manager.changeModel(instance.id, 'claude-opus-5.5', undefined, undefined, 'copilot'))
      .rejects.toThrow('Example construction failure');

    expect(instance).toMatchObject({ provider: 'claude', currentModel: 'sonnet', copilotAccountProfileId: 'work',
      copilotRoutingSource: 'path-prefix', copilotRoutingRuleId: 'example-rule', status: 'error' });
  });

  it('leaves an unstamped source unstamped after a failed Copilot spawn', async () => {
    const instance = await claudeSession();
    const adapter = makeFakeAdapter();
    adapter.spawn.mockRejectedValue(new Error('Example spawn failure'));
    mocks.createAdapter.mockReturnValueOnce(adapter);
    await expect(harness.manager.changeModel(instance.id, 'claude-opus-5.5', undefined, undefined, 'copilot'))
      .rejects.toThrow('Example spawn failure');

    expect(instance.provider).toBe('claude');
    expect(instance.copilotAccountProfileId).toBeUndefined();
    expect(instance.copilotRoutingSource).toBeUndefined();
    expect(instance.copilotRoutingRuleId).toBeUndefined();
  });

  it('keeps a remote Copilot selection for worker validation without consulting local account models', async () => {
    const instance = await claudeSession();
    instance.executionLocation = { type: 'remote', nodeId: 'example-worker' };
    await harness.manager.changeModel(instance.id, 'claude-opus-5.5', undefined, undefined, 'copilot');

    expect(mocks.getKnownModelsForCli).not.toHaveBeenCalled();
    expect(instance.currentModel).toBe('claude-opus-5.5');
    expect(routing.resolveRouteForSpawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ executionNodeId: 'example-worker' }));
    expect(mocks.createAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      executionLocation: { type: 'remote', nodeId: 'example-worker' },
      options: expect.objectContaining({ model: 'claude-opus-5.5' }),
    }));
  });
});
