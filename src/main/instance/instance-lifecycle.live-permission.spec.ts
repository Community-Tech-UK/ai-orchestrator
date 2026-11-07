import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDefaultAgent } from '../../shared/types/agent.types';
import { getMocks, makeFakeAdapter, makeHarness } from './__tests__/instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();
const settings = Object.assign(mocks.settings, { claudeLivePermissionPrompts: false });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
  mocks.resolveCliType.mockResolvedValue('claude');
  mocks.createAdapter.mockImplementation(() => makeFakeAdapter());
  mocks.getKnownModelsForCli.mockResolvedValue([]);
  mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
  mocks.getProviderCapabilities.mockReturnValue({ supportsResume: false, supportsForkSession: false });
  settings.claudeLivePermissionPrompts = false;
});
afterEach(() => { settings.claudeLivePermissionPrompts = false; });

describe('live permission runtime spawn wiring', () => {
  it('reads the opt-in at the real construction seam for create and fresh restart', async () => {
    settings.claudeLivePermissionPrompts = true;
    const harness = makeHarness();
    try {
      const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', yoloMode: false });
      await instance.readyPromise;
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ instanceId: instance.id, livePermissionPrompts: true }),
      }));
      await harness.manager.restartFreshInstance(instance.id);
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ instanceId: instance.id, livePermissionPrompts: true }),
      }));
      settings.claudeLivePermissionPrompts = false;
      await harness.manager.restartFreshInstance(instance.id);
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ livePermissionPrompts: false }),
      }));
    } finally { harness.manager.destroy(); }
  });

  it('keeps Harness-started sessions out of the channel while opted in', async () => {
    settings.claudeLivePermissionPrompts = true;
    const harness = makeHarness();
    try {
      const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude',
        metadata: { automationId: 'automation-example' } });
      await instance.readyPromise;
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ machineSession: 'automation', livePermissionPrompts: false }),
      }));
    } finally { harness.manager.destroy(); }
  });
});
