import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import type { Automation, AutomationRun } from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { AutomationStore } from './automation-store';
import { AutomationRunner } from './automation-runner';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/ai-orchestrator-test'),
  },
}));

vi.mock('../plugins/hook-emitter', () => ({
  emitPluginHook: vi.fn(),
}));

vi.mock('../channels/channel-manager', () => ({
  getChannelManager: () => ({
    getAdapter: vi.fn(),
    emitResponseSent: vi.fn(),
  }),
}));

function makeAutomation(): Automation {
  return {
    id: 'automation-1',
    name: 'Wake thread',
    enabled: true,
    active: true,
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: {
      kind: 'thread',
      instanceId: 'instance-1',
      reviveIfArchived: true,
    },
    action: {
      prompt: 'Current prompt',
      workingDirectory: '/repo/current',
    },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function makeRun(): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    status: 'running',
    trigger: 'scheduled',
    scheduledAt: 2_000,
    startedAt: 2_000,
    finishedAt: null,
    instanceId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'silent',
    seenAt: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    configSnapshot: {
      name: 'Snapshot wake thread',
      schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: 'instance-1',
        historyEntryId: 'history-1',
        reviveIfArchived: true,
      },
      action: {
        prompt: 'Snapshot prompt',
        workingDirectory: '/repo/snapshot',
      },
    },
  };
}

describe('AutomationRunner thread wakeups', () => {
  const store = {
    get: vi.fn(),
    decideAndInsertRun: vi.fn(),
    claimNextPending: vi.fn(),
    failRunningRuns: vi.fn(),
  } as unknown as AutomationStore;
  const manager = Object.assign(new EventEmitter(), {
    createInstance: vi.fn(),
  }) as unknown as InstanceManager & { createInstance: ReturnType<typeof vi.fn> };
  const fireThreadWakeup = vi.fn();
  const threadWakeupFactory = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    const automation = makeAutomation();
    const run = makeRun();
    const completed = {
      ...run,
      status: 'succeeded' as const,
      finishedAt: 3_000,
      outputSummary: 'Wakeup prompt delivered to thread instance-1.',
    };

    vi.mocked(store.get).mockResolvedValue(automation);
    vi.mocked(store.decideAndInsertRun).mockReturnValue({ kind: 'started', run });
    vi.mocked(store.claimNextPending).mockReturnValue(null);
    vi.mocked(store.failRunningRuns).mockReturnValue([]);
    fireThreadWakeup.mockResolvedValue(completed);
    threadWakeupFactory.mockReturnValue({ fireThreadWakeup });
  });

  it('dispatches thread destinations without creating a fresh instance', async () => {
    const runner = new AutomationRunner(
      store,
      undefined,
      () => 2_000,
      threadWakeupFactory,
    );
    runner.initialize(manager);

    const result = await runner.fire('automation-1', {
      trigger: 'scheduled',
      scheduledAt: 2_000,
    });

    expect(result.status).toBe('started');
    expect(manager.createInstance).not.toHaveBeenCalled();
    expect(fireThreadWakeup).toHaveBeenCalledWith({
      run: expect.objectContaining({ id: 'run-1' }),
      automation: expect.objectContaining({
        name: 'Snapshot wake thread',
        action: expect.objectContaining({
          prompt: 'Snapshot prompt',
          workingDirectory: '/repo/snapshot',
        }),
      }),
      destination: expect.objectContaining({
        kind: 'thread',
        historyEntryId: 'history-1',
      }),
    });
  });
});
