import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-child-auto-announce-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import type { InstanceManager } from '../instance/instance-manager';
import { ChildAnnouncer, getChildAnnouncer } from '../orchestration/child-announcer';
import type { WindowManager } from '../window-manager';
import { createLateRuntimeInitializationSteps } from './late-runtime-initialization-steps';

describe('late runtime child auto-announcement', () => {
  afterEach(() => ChildAnnouncer._resetForTesting());

  it('marks the parent delivery as automated without auto-continuation budget semantics', async () => {
    const sendInput = vi.fn(async () => undefined);
    const instanceManager = {
      getInstance: vi.fn(() => ({ id: 'parent-1', status: 'idle' })),
      sendInput,
    } as unknown as InstanceManager;
    const steps = createLateRuntimeInitializationSteps({
      instanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const step = steps.find((candidate) => candidate.name === 'Child auto-announce');
    expect(step).toBeDefined();
    await step!.fn();

    getChildAnnouncer().emit('child:announced', 'parent-1', [], 'Child completed.');
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledOnce());

    expect(sendInput).toHaveBeenCalledWith(
      'parent-1',
      'Child completed.',
      undefined,
      { automatedInput: true },
    );
  });
});
