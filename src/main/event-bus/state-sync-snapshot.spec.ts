import { describe, expect, it, vi } from 'vitest';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { LoopState } from '../../shared/types/loop.types';
import { buildStateSyncSnapshot } from './state-sync-snapshot';

describe('buildStateSyncSnapshot', () => {
  it('requires an explicit stream sequence supplier instead of falling back to global bus state', () => {
    expect(() => buildStateSyncSnapshot({
      instanceManager: {
        getAllInstancesForIpc: () => [],
      },
      loopCoordinator: {
        getActiveLoops: () => [],
      },
      automationStore: {
        listRuns: () => [],
      },
      pauseCoordinator: {
        toPayload: () => ({
          isPaused: false,
          reasons: [],
          pausedAt: null,
          lastChange: 0,
        }),
      },
      appStore: {
        getState: () => ({
          global: {
            memoryPressure: 'normal',
          },
        }),
      },
    } as never)).toThrow('State sync snapshots require a caller-scoped sequence supplier');
  });

  it('projects active orchestrator state into the thin-client resync snapshot', () => {
    const snapshot = buildStateSyncSnapshot({
      instanceManager: {
        getAllInstancesForIpc: () => [
          {
            id: 'inst-1',
            displayName: 'Claude',
            status: 'busy',
            provider: 'claude',
            workingDirectory: '/workspace',
          },
        ],
      },
      loopCoordinator: {
        getActiveLoops: () => [
          {
            id: 'loop-1',
            chatId: 'chat-1',
            status: 'provider-limit',
            startedAt: 100,
            endedAt: null,
            totalIterations: 2,
            totalTokens: 900,
            totalCostCents: 12,
            config: {
              initialPrompt: 'Fix it',
              iterationPrompt: 'Continue',
              workspaceCwd: '/workspace',
            },
          } as LoopState,
        ],
      },
      automationStore: {
        listActiveRuns: () => [
          makeAutomationRun({ id: 'run-1', automationId: 'auto-1', status: 'running' }),
        ],
        listRuns: () => [
          makeAutomationRun({ id: 'run-2', automationId: 'auto-2', status: 'succeeded' }),
        ],
      },
      pauseCoordinator: {
        toPayload: () => ({
          isPaused: true,
          reasons: ['user'],
          pausedAt: 1_000,
          lastChange: 1_500,
        }),
      },
      appStore: {
        getState: () => ({
          global: {
            memoryPressure: 'critical',
          },
        }),
      },
      getSeq: () => 42,
    });

    expect(snapshot).toEqual({
      instances: [
        {
          id: 'inst-1',
          displayName: 'Claude',
          status: 'busy',
          provider: 'claude',
          workingDirectory: '/workspace',
        },
      ],
      loopRuns: [
        {
          loopRunId: 'loop-1',
          chatId: 'chat-1',
          status: 'provider-limit',
          phase: 'paused',
          totalIterations: 2,
          totalTokens: 900,
          totalCostCents: 12,
          startedAt: 100,
          endedAt: null,
          endReason: null,
          initialPrompt: 'Fix it',
          iterationPrompt: 'Continue',
          workspaceCwd: '/workspace',
        },
      ],
      automationRuns: [
        {
          runId: 'run-1',
          automationId: 'auto-1',
          status: 'running',
          phase: 'running',
          instanceId: null,
          scheduledAt: 0,
          startedAt: null,
          finishedAt: null,
        },
      ],
      pauseState: {
        isPaused: true,
        reasons: ['user'],
        pausedAt: 1_000,
        lastChange: 1_500,
      },
      memoryPressure: 'critical',
      seq: 42,
    });
  });

  it('uses the active automation run query instead of recent run history when available', () => {
    const listActiveRuns = vi.fn(() => [
      makeAutomationRun({ id: 'run-active', automationId: 'auto-active', status: 'pending' }),
    ]);
    const listRuns = vi.fn(() => [
      makeAutomationRun({ id: 'run-terminal', automationId: 'auto-terminal', status: 'succeeded' }),
    ]);

    const snapshot = buildStateSyncSnapshot({
      instanceManager: {
        getAllInstancesForIpc: () => [],
      },
      loopCoordinator: {
        getActiveLoops: () => [],
      },
      automationStore: {
        listActiveRuns,
        listRuns,
      },
      pauseCoordinator: {
        toPayload: () => ({
          isPaused: false,
          reasons: [],
          pausedAt: null,
          lastChange: 0,
        }),
      },
      appStore: {
        getState: () => ({
          global: {
            memoryPressure: 'normal',
          },
        }),
      },
      getSeq: () => 7,
    });

    expect(listActiveRuns).toHaveBeenCalledOnce();
    expect(listRuns).not.toHaveBeenCalled();
    expect(snapshot.automationRuns).toEqual([
      {
        runId: 'run-active',
        automationId: 'auto-active',
        status: 'pending',
        phase: 'pending',
        instanceId: null,
        scheduledAt: 0,
        startedAt: null,
        finishedAt: null,
      },
    ]);
  });

  it('projects ended provider-limit loops as failed in the thin-client snapshot', () => {
    const snapshot = buildStateSyncSnapshot({
      instanceManager: {
        getAllInstancesForIpc: () => [],
      },
      loopCoordinator: {
        getActiveLoops: () => [
          {
            id: 'loop-ended-provider-limit',
            chatId: 'chat-1',
            status: 'provider-limit',
            startedAt: 100,
            endedAt: 200,
            endReason: 'provider limit reached without a reset window',
            totalIterations: 1,
            totalTokens: 900,
            totalCostCents: 12,
            config: {
              initialPrompt: 'Fix it',
              workspaceCwd: '/workspace',
            },
          } as LoopState,
        ],
      },
      automationStore: {
        listRuns: () => [],
      },
      pauseCoordinator: {
        toPayload: () => ({
          isPaused: false,
          reasons: [],
          pausedAt: null,
          lastChange: 0,
        }),
      },
      appStore: {
        getState: () => ({
          global: {
            memoryPressure: 'normal',
          },
        }),
      },
      getSeq: () => 7,
    });

    expect(snapshot.loopRuns).toEqual([
      expect.objectContaining({
        loopRunId: 'loop-ended-provider-limit',
        status: 'provider-limit',
        phase: 'failed',
        endedAt: 200,
      }),
    ]);
  });
});

function makeAutomationRun(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run',
    automationId: 'automation',
    status: 'pending',
    trigger: 'manual',
    scheduledAt: 0,
    startedAt: null,
    finishedAt: null,
    instanceId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'localOnly',
    seenAt: null,
    createdAt: 0,
    updatedAt: 0,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 1,
    ...overrides,
  };
}
