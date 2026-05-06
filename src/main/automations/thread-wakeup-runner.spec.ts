import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Automation,
  AutomationRun,
  AutomationDestination,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';
import { ThreadWakeupRunner } from './thread-wakeup-runner';

function makeAutomation(destination: AutomationDestination): Automation {
  return {
    id: 'automation-1',
    name: 'Wake thread',
    enabled: true,
    active: true,
    schedule: { type: 'oneTime', runAt: 2_000, timezone: 'UTC' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination,
    action: {
      prompt: 'Continue the work',
      workingDirectory: '/repo',
      attachments: [{ name: 'brief.txt', type: 'text/plain', size: 5, data: 'hello' }],
    },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
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
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: 2_000,
    updatedAt: 2_000,
    configSnapshot: null,
    ...overrides,
  };
}

describe('ThreadWakeupRunner', () => {
  const sendInput = vi.fn();
  const revive = vi.fn();
  const attachInstance = vi.fn();
  const terminalizeRun = vi.fn();
  let runner: ThreadWakeupRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new ThreadWakeupRunner(
      {
        sendInput,
      } as unknown as InstanceManager,
      {
        revive,
      } as unknown as SessionRevivalService,
      {
        attachInstance,
        terminalizeRun,
      } as unknown as AutomationStore,
      () => 3_000,
    );
  });

  it('sends the scheduled prompt to a live thread and marks the run succeeded', async () => {
    const destination: AutomationDestination = {
      kind: 'thread',
      instanceId: 'instance-1',
      reviveIfArchived: false,
    };
    const automation = makeAutomation(destination);
    const run = makeRun();
    const attached = { ...run, instanceId: 'instance-1' };
    const completed = {
      ...attached,
      status: 'succeeded' as const,
      finishedAt: 3_000,
      outputSummary: 'Wakeup prompt delivered to thread instance-1.',
    };

    revive.mockResolvedValue({ status: 'live', instanceId: 'instance-1' });
    attachInstance.mockReturnValue(attached);
    terminalizeRun.mockReturnValue(completed);

    await expect(runner.fireThreadWakeup({ run, automation, destination })).resolves.toEqual(completed);

    expect(revive).toHaveBeenCalledWith({
      instanceId: 'instance-1',
      historyEntryId: undefined,
      providerSessionId: undefined,
      workingDirectory: '/repo',
      reviveIfArchived: false,
      reason: 'thread-wakeup',
    });
    expect(attachInstance).toHaveBeenCalledWith('run-1', 'instance-1', 3_000);
    expect(sendInput).toHaveBeenCalledWith('instance-1', 'Continue the work', automation.action.attachments);
    expect(terminalizeRun).toHaveBeenCalledWith(
      'run-1',
      'succeeded',
      undefined,
      'Wakeup prompt delivered to thread instance-1.',
      3_000,
    );
  });

  it('marks the run failed when the target cannot be found or revived', async () => {
    const destination: AutomationDestination = {
      kind: 'thread',
      instanceId: 'missing-instance',
      historyEntryId: 'missing-history',
      reviveIfArchived: true,
    };
    const automation = makeAutomation(destination);
    const run = makeRun();
    const failed = {
      ...run,
      status: 'failed' as const,
      error: 'Thread wakeup failed: target_missing',
    };

    revive.mockResolvedValue({ status: 'failed', failureCode: 'target_missing' });
    terminalizeRun.mockReturnValue(failed);

    await expect(runner.fireThreadWakeup({ run, automation, destination })).resolves.toEqual(failed);

    expect(sendInput).not.toHaveBeenCalled();
    expect(terminalizeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      'Thread wakeup failed: target_missing',
      undefined,
      3_000,
    );
  });

  it('marks the run failed when revival throws before a target is available', async () => {
    const destination: AutomationDestination = {
      kind: 'thread',
      instanceId: 'instance-1',
      reviveIfArchived: true,
    };
    const automation = makeAutomation(destination);
    const run = makeRun();
    const failed = {
      ...run,
      status: 'failed' as const,
      error: 'Thread wakeup failed: resume_failed (history unavailable)',
    };

    revive.mockRejectedValue(new Error('history unavailable'));
    terminalizeRun.mockReturnValue(failed);

    await expect(runner.fireThreadWakeup({ run, automation, destination })).resolves.toEqual(failed);

    expect(sendInput).not.toHaveBeenCalled();
    expect(terminalizeRun).toHaveBeenCalledWith(
      'run-1',
      'failed',
      'Thread wakeup failed: resume_failed (history unavailable)',
      undefined,
      3_000,
    );
  });
});
