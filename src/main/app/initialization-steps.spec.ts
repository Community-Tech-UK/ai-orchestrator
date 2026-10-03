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
  createAnnounceThenHaltContinuationInitializationStep,
  createContinuationRuntimeInitializationStep,
  createCrashTurnContinuationInitializationStep,
  createReasoningCollapseContinuationInitializationStep,
  createGovernedProposalInitializationStep,
  createInitializationSteps,
  createLocalAiGuardInitializationStep,
} from './initialization-steps';

describe('Announce-then-halt continuation initialization', () => {
  it('supplies an active managed-loop ownership predicate', () => {
    const instanceManager = {} as InstanceManager;
    const initialize = vi.fn();
    const step = createAnnounceThenHaltContinuationInitializationStep(
      instanceManager,
      initialize,
      () => [
        { chatId: 'active-root', status: 'running', endedAt: null },
        { chatId: 'finished-root', status: 'completed', endedAt: 1 },
      ],
    );

    step.fn();

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toBe(instanceManager);
    const isManagedLoopInstance = initialize.mock.calls[0]?.[1] as (instanceId: string) => boolean;
    expect(isManagedLoopInstance('active-root')).toBe(true);
    expect(isManagedLoopInstance('finished-root')).toBe(false);
    expect(isManagedLoopInstance('ordinary-root')).toBe(false);
  });
});

describe('Crash-turn continuation initialization', () => {
  it('is registered and supplies an active managed-loop ownership predicate', () => {
    const instanceManager = {} as InstanceManager;
    const initialize = vi.fn();
    const step = createCrashTurnContinuationInitializationStep(
      instanceManager,
      initialize,
      () => [
        { chatId: 'active-root', status: 'running', endedAt: null },
        { chatId: 'finished-root', status: 'completed', endedAt: 1 },
      ],
    );

    step.fn();

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toBe(instanceManager);
    const isManagedLoopInstance = initialize.mock.calls[0]?.[1] as (instanceId: string) => boolean;
    expect(isManagedLoopInstance('active-root')).toBe(true);
    expect(isManagedLoopInstance('finished-root')).toBe(false);

    const names = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    }).map((candidate) => candidate.name);
    expect(names).not.toContain('Crash-turn continuation');
    expect(names.filter((name) => name === 'Provider turn-ending continuation')).toHaveLength(1);
  });
});

describe('Reasoning-collapse continuation initialization', () => {
  it('is registered and supplies an active managed-loop ownership predicate', () => {
    const instanceManager = {} as InstanceManager;
    const initialize = vi.fn();
    const step = createReasoningCollapseContinuationInitializationStep(
      instanceManager,
      initialize,
      () => [
        { chatId: 'active-root', status: 'running', endedAt: null },
        { chatId: 'finished-root', status: 'completed', endedAt: 1 },
      ],
    );

    step.fn();

    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toBe(instanceManager);
    const isManagedLoopInstance = initialize.mock.calls[0]?.[1] as (instanceId: string) => boolean;
    expect(isManagedLoopInstance('active-root')).toBe(true);
    expect(isManagedLoopInstance('finished-root')).toBe(false);

    const names = createInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    }).map((candidate) => candidate.name);
    expect(names).toContain('Provider turn-ending continuation');
  });
});

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

    expect(names).not.toContain('Announce-then-halt continuation');
    expect(names.filter((name) => name === 'Provider turn-ending continuation')).toHaveLength(1);
    expect(names).toContain('Background task publisher');
    expect(names).not.toContain('Background task continuation');
    expect(names.indexOf('Workflow invokers')).toBeLessThan(names.indexOf('Loop store'));
    expect(names.indexOf('Loop store')).toBeLessThan(names.indexOf('Channel manager'));
    expect(names.indexOf('Channel manager')).toBeLessThan(names.indexOf('Cross-project patterns'));
    expect(names.indexOf('Cross-project patterns')).toBeLessThan(names.indexOf('Governed proposal review inbox'));
  });
});


describe('Shared continuation runtime initialization', () => {
  it('starts one composed runtime with the active loop predicate', () => {
    const instanceManager = {} as InstanceManager;
    const initialize = vi.fn();
    createContinuationRuntimeInitializationStep(instanceManager, initialize, () => [
      { chatId: 'active', status: 'running', endedAt: null },
      { chatId: 'closed', status: 'completed', endedAt: 1 },
    ]).fn();
    expect(initialize).toHaveBeenCalledOnce();
    expect(initialize.mock.calls[0]?.[0]).toBe(instanceManager);
    const isManaged = initialize.mock.calls[0]?.[1] as (instanceId: string) => boolean;
    expect(isManaged('active')).toBe(true);
    expect(isManaged('closed')).toBe(false);
  });
});
