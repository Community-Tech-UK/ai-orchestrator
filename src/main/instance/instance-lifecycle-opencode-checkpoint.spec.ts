import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from './instance-manager';
import { createInstanceWithMessage } from '../ipc/handlers/instance-create-with-message';
import { instanceToContinuityState } from '../session/session-continuity-instance-state';
import { getDefaultAgent } from '../../shared/types/agent.types';
import { getMocks, makeFakeAdapter, makeHarness } from './__tests__/instance-lifecycle-source-diagnostics.fixture';

const mocks = getMocks();
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createAdapter.mockReset();
  mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
  mocks.resolveCliType.mockResolvedValue('opencode');
  mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
  mocks.getKnownModelsForCli.mockResolvedValue([]);
  mocks.getProviderCapabilities.mockReturnValue({ supportsResume: false, supportsForkSession: false });
  mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
  mocks.continuityResumeSession.mockResolvedValue(null);
  mocks.settings.defaultModel = undefined;
  mocks.settings.defaultModelByProvider = {};
});

describe('actual OpenCode lifecycle checkpoint and version wiring', () => {
  it('publishes verifiable fresh current-submission provenance through the actual lifecycle while rejecting cloned and unknown seed records', async () => {
    const harness = makeHarness();
    const origins: boolean[] = []; const clonedOrigins: boolean[] = [];
    mocks.createAdapter.mockImplementation(() => makeFakeAdapter());
    harness.manager.on('created', (payload: { id: string }) => {
      const live = harness.instances.get(payload.id)!;
      const policy = { persistSessionContent: true, redactToolOutputs: false };
      origins.push(instanceToContinuityState(live, policy).conversationHistoryOriginKnown === true);
      clonedOrigins.push(instanceToContinuityState({ ...live }, policy).conversationHistoryOriginKnown === true);
    });
    try {
      await createInstanceWithMessage(harness.manager as unknown as InstanceManager,
        { provider: 'opencode', message: 'placeholder fresh request' }, '/tmp/project', undefined);
      const created = [...harness.instances.values()][0]; await created.readyPromise;
      expect(origins).toEqual([true]);
      expect(clonedOrigins).toEqual([false]);
      expect(created.outputBuffer.filter((message) => message.type === 'user')).toHaveLength(1);
      const unknown = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'opencode',
        initialPrompt: 'placeholder old request', initialOutputBuffer: [{ id: 'old', type: 'user', timestamp: 1, content: 'placeholder old request' }] });
      await unknown.readyPromise;
      expect(origins).toEqual([true, false]);
      expect(clonedOrigins).toEqual([false, false]);
    } finally { harness.manager.destroy(); }
  });
  it('loads a cloned native fork when its retained seed has no completeness proof', async () => {
    const harness = makeHarness();
    mocks.createAdapter.mockImplementation(() => makeFakeAdapter());
    try {
      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project', provider: 'opencode',
        initialOutputBuffer: [{ id: 'retained-tail', type: 'assistant', timestamp: 1, content: 'Only the retained tail.' }],
        metadata: { openCodeForkSessionId: 'cloned-native-placeholder' },
      });
      await instance.readyPromise;
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ sessionId: 'cloned-native-placeholder', resume: true, transcriptKnown: false }),
      }));
    } finally { harness.manager.destroy(); }
  });
  it('preserves major-only placement and binds the checkpoint on creation and restart', async () => {
    const harness = makeHarness();
    mocks.createAdapter.mockImplementation(() => makeFakeAdapter());
    try {
      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project', provider: 'opencode',
        nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 },
      });
      await instance.readyPromise;
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ instanceId: instance.id,
          nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 },
          beforeProviderPrompt: expect.any(Function) }),
      }));
      await harness.manager.restartFreshInstance(instance.id);
      expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
        options: expect.objectContaining({ instanceId: instance.id,
          nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 },
          beforeProviderPrompt: expect.any(Function) }),
      }));
    } finally { harness.manager.destroy(); }
  });
});
