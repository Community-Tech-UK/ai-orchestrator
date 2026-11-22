/**
 * LT-1108: switching an idle Claude session between Build and Plan stops the old
 * CLI process on purpose. That process's exit must not be handled as an
 * unexpected exit, or the idle session auto-respawns while the mode change is
 * spawning its own replacement and the session is destroyed.
 *
 * The exit handler skips any adapter marked as stopping, so the old adapter has
 * to carry that mark before `terminate` is called (the exit can arrive inside it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { isAdapterStopping } from '../../providers/adapter-stop-state';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();

describe('changeAgentMode fences the old adapter before stopping it', () => {
  let harness: ReturnType<typeof makeHarness>;
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
  });
  afterEach(() => harness.manager.destroy());

  it('marks the old adapter as stopping by the time terminate runs, and not the replacement', async () => {
    const oldAdapter = makeFakeAdapter();
    const replacement = makeFakeAdapter();
    mocks.createAdapter.mockReturnValueOnce(oldAdapter).mockReturnValue(replacement);
    const instance = await harness.manager.createInstance(createConfig);
    await instance.readyPromise;

    let stoppingDuringTerminate: boolean | undefined;
    oldAdapter.terminate.mockImplementation(async () => {
      stoppingDuringTerminate = isAdapterStopping(oldAdapter);
    });

    await harness.manager.changeAgentMode(instance.id, 'plan');

    expect(stoppingDuringTerminate).toBe(true);
    expect(isAdapterStopping(replacement)).toBe(false);
    expect(instance.agentId).toBe('plan');
  });
});
