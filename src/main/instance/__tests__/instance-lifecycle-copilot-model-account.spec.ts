import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { CopilotRouteOutcome } from '../../../shared/types/copilot-account.types';
import type { CopilotAccountRoutingService } from '../../providers/copilot/copilot-account-routing-service';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const routing = vi.hoisted(() => ({
  resolveRouteForSpawn: vi.fn<CopilotAccountRoutingService['resolveRouteForSpawn']>(),
}));

vi.mock('../../providers/copilot/copilot-account-routing-service', () => ({
  getCopilotAccountRoutingService: () => routing,
}));

const mocks = getMocks();
type Harness = ReturnType<typeof makeHarness>;

// Keep the lifecycle, route attachment, model resolver and degradation real.
// Only the external account router, account rosters and adapter are replaced.
describe('Copilot creation validates the model against the account it will use', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    routing.resolveRouteForSpawn.mockReset().mockImplementation(async (input): Promise<CopilotRouteOutcome> => ({
      ok: true,
      route: {
        profileId: input.persistedProfileId ?? input.explicitProfileId ?? 'personal',
        source: input.persistedProfileId ? 'persisted' : input.explicitProfileId ? 'explicit' : 'default',
        executionNodeId: input.executionNodeId ?? 'local',
      },
    }));
    mocks.createAdapter.mockReset().mockReturnValue(makeFakeAdapter());
    mocks.resolveCliType.mockResolvedValue('copilot');
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
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
    // Unscoped discovery represents the picker union and contains Opus. A
    // missing profile argument would therefore reproduce the incorrect spawn.
    mocks.getKnownModelsForCli.mockReset().mockImplementation(async (_provider: string, profileId?: string) =>
      profileId === 'personal' ? ['auto', 'gpt-4.1'] : ['auto', 'claude-opus-5.5']);
    harness = makeHarness();
  });

  afterEach(() => harness.manager.destroy());

  it.each([
    { profileId: 'personal', requestedModel: 'claude-opus-5.5', expectedModel: 'auto' },
    { profileId: 'personal', requestedModel: 'claude-fable-5.2', expectedModel: 'auto' },
    { profileId: 'work', requestedModel: 'claude-opus-5.5', expectedModel: 'claude-opus-5.5' },
  ])('keeps $profileId and spawns $expectedModel when $requestedModel is selected', async ({ profileId, requestedModel, expectedModel }) => {
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project', provider: 'copilot',
      modelOverride: requestedModel, copilotAccountProfileId: profileId,
    });
    await instance.readyPromise;

    expect(routing.resolveRouteForSpawn).toHaveBeenCalledTimes(1);
    expect(mocks.getKnownModelsForCli).toHaveBeenCalledWith('copilot', profileId);
    expect(routing.resolveRouteForSpawn.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.getKnownModelsForCli.mock.invocationCallOrder[0]!);
    expect(instance.copilotAccountProfileId).toBe(profileId);
    expect(instance.currentModel).toBe(expectedModel);
    expect(mocks.createAdapter).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      cliType: 'copilot',
      options: expect.objectContaining({ model: expectedModel, copilotAccountRoute: expect.objectContaining({ profileId }) }),
    }));
    const notices = instance.outputBuffer.filter(message => message.metadata?.['kind'] === 'model-selection-degraded');
    expect(notices).toHaveLength(expectedModel === requestedModel ? 0 : 1);
  });

  it('uses the default account before checking its models when no account was selected', async () => {
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project', provider: 'copilot', modelOverride: 'claude-opus-5.5',
    });
    await instance.readyPromise;

    expect(mocks.getKnownModelsForCli).toHaveBeenCalledWith('copilot', 'personal');
    expect(instance.copilotAccountProfileId).toBe('personal');
    expect(instance.currentModel).toBe('auto');
    expect(routing.resolveRouteForSpawn).toHaveBeenCalledTimes(1);
  });

  it('preserves resume and protected override routing inputs during early selection', async () => {
    const config: InstanceCreateConfig = {
      workingDirectory: '/tmp/project', provider: 'copilot', modelOverride: 'claude-opus-5.5',
      copilotAccountProfileId: 'work', copilotConfirmProtectedOverride: true,
      resume: true, accountRouteOrigin: 'loop', accountPreferences: { avoid: ['personal'], last: [] },
    };
    const instance = await harness.manager.createInstance(config);
    await instance.readyPromise;

    expect(routing.resolveRouteForSpawn).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      explicitProfileId: 'work', persistedProfileId: 'work', confirmProtectedOverride: true,
      workingDirectory: '/tmp/project', origin: 'loop', avoidProfileIds: ['personal'],
    }));
    expect(instance.copilotAccountProfileId).toBe('work');
    expect(instance.currentModel).toBe('claude-opus-5.5');
  });

  it('stops before model discovery or adapter creation when the selected account is refused', async () => {
    routing.resolveRouteForSpawn.mockResolvedValue({
      ok: false, code: 'profile-unauthenticated', profileId: 'work', detail: 'Selected account needs sign-in.',
    });
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project', provider: 'copilot',
      modelOverride: 'claude-opus-5.5', copilotAccountProfileId: 'work',
    });
    await expect(instance.readyPromise).rejects.toThrow('Selected account needs sign-in.');

    expect(routing.resolveRouteForSpawn).toHaveBeenCalledTimes(1);
    expect(mocks.getKnownModelsForCli).not.toHaveBeenCalled();
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(instance.status).toBe('error');
  });
});
