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
  createGovernedProposalInitializationStep,
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

describe('Governed proposal review inbox initialization', () => {
  it('is fail-soft when rehydrate/backfill throws', () => {
    const initialize = vi.fn(() => {
      throw new Error('rlm database unavailable');
    });
    const step = createGovernedProposalInitializationStep(() => ({ initialize }));

    expect(() => step.fn()).not.toThrow();
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('is registered as part of the full initialization sequence', () => {
    const steps = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const names = steps.map((step) => step.name);

    expect(names).toContain('Governed proposal review inbox');
  });
});

describe('late-runtime initialization steps', () => {
  it('keeps loop, channel, and cross-project steps after the early boot list', () => {
    const steps = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const names = steps.map((step) => step.name);

    expect(names.indexOf('Workflow invokers')).toBeLessThan(names.indexOf('Loop store'));
    expect(names.indexOf('Loop store')).toBeLessThan(names.indexOf('Channel manager'));
    expect(names.indexOf('Channel manager')).toBeLessThan(names.indexOf('Cross-project patterns'));
    expect(names.indexOf('Cross-project patterns')).toBeLessThan(names.indexOf('Governed proposal review inbox'));
  });
});
