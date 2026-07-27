import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-local-ai-guard-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import {
  createInitializationSteps,
  createLocalAiGuardInitializationStep,
} from './initialization-steps';

describe('Local AI Guard initialization', () => {
  it('initializes fail-soft when runtime startup throws', () => {
    const initialize = vi.fn(() => {
      throw new Error('sensitive startup detail');
    });
    const step = createLocalAiGuardInitializationStep(initialize);

    expect(() => step.fn()).not.toThrow();
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('runs after Auxiliary LLM configuration and before IPC handlers', () => {
    const steps = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const names = steps.map((step) => step.name);
    const guard = names.indexOf('Local AI Guard');

    expect(guard).toBe(names.indexOf('Auxiliary LLM service') + 1);
    expect(guard).toBeLessThan(names.indexOf('IPC handlers'));
  });
});
