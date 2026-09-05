import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Automation,
  AutomationRun,
  AutomationDestination,
} from '../../shared/types/automation.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { SessionRevivalService } from '../session/session-revival-service';
import type { AutomationStore } from './automation-store';

const mockAdmitAutomatedWrite = vi.fn().mockReturnValue({ kind: 'admitted', admissionId: 'adm-default' });
const mockMarkDelivered = vi.fn();
const mockMarkFailed = vi.fn();
const mockRegisterRedeliveryHandler = vi.fn();

vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    admitAutomatedWrite: mockAdmitAutomatedWrite,
    markDelivered: mockMarkDelivered,
    markFailed: mockMarkFailed,
    registerRedeliveryHandler: mockRegisterRedeliveryHandler,
  }),
}));

import { ThreadWakeupRunner } from './thread-wakeup-runner';

function makeAutomation(destination: AutomationDestination): Automation {
  return {
    id: 'automation-1',
    name: 'Wake thread',
    enabled: true,
    active: true,
    workspaceId: '/repo',
    schedule: { type: 'oneTime', runAt: 2_000, timezone: 'UTC' },
    trigger: { kind: 'schedule' },
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
    loopRunId: null,
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
    attempt: 1,
    maxAttempts: 1,
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
    mockAdmitAutomatedWrite.mockReturnValue({ kind: 'admitted', admissionId: 'adm-default' });
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
    expect(sendInput).toHaveBeenCalledWith(
      'instance-1',
      'Continue the work',
      automation.action.attachments,
      { automatedInput: true },
    );
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

  describe('SessionAdmissionService gating (A5)', () => {
    it('does not send when admission suppresses the revived instance, and marks the run deferred/failed', async () => {
      const destination: AutomationDestination = {
        kind: 'thread',
        instanceId: 'instance-1',
        reviveIfArchived: false,
      };
      const automation = makeAutomation(destination);
      const run = makeRun();
      const attached = { ...run, instanceId: 'instance-1' };
      const deferred = {
        ...attached,
        status: 'failed' as const,
        error: 'Thread wakeup deferred: instance not ready to receive input (awaiting-human).',
      };

      revive.mockResolvedValue({ status: 'live', instanceId: 'instance-1' });
      attachInstance.mockReturnValue(attached);
      terminalizeRun.mockReturnValue(deferred);
      mockAdmitAutomatedWrite.mockReturnValue({
        kind: 'suppressed',
        reason: 'awaiting-human',
        admissionId: 'adm-suppressed',
      });

      const result = await runner.fireThreadWakeup({ run, automation, destination });

      expect(sendInput).not.toHaveBeenCalled();
      expect(mockAdmitAutomatedWrite).toHaveBeenCalledWith({
        instanceId: 'instance-1',
        origin: 'automation',
        message: 'Continue the work',
        attachments: automation.action.attachments,
        sourceMetadata: { automationId: 'automation-1', runId: 'run-1' },
      });
      expect(terminalizeRun).toHaveBeenCalledWith(
        'run-1',
        'failed',
        expect.stringContaining('awaiting-human'),
        undefined,
        3_000,
      );
      expect(result).toEqual(deferred);
    });

    it('sends and marks delivered when admission admits', async () => {
      const destination: AutomationDestination = {
        kind: 'thread',
        instanceId: 'instance-1',
        reviveIfArchived: false,
      };
      const automation = makeAutomation(destination);
      const run = makeRun();
      const attached = { ...run, instanceId: 'instance-1' };
      const completed = { ...attached, status: 'succeeded' as const };

      revive.mockResolvedValue({ status: 'live', instanceId: 'instance-1' });
      attachInstance.mockReturnValue(attached);
      terminalizeRun.mockReturnValue(completed);
      mockAdmitAutomatedWrite.mockReturnValue({ kind: 'admitted', admissionId: 'adm-admitted' });
      sendInput.mockResolvedValue(undefined);

      await runner.fireThreadWakeup({ run, automation, destination });

      expect(sendInput).toHaveBeenCalledWith(
        'instance-1',
        'Continue the work',
        automation.action.attachments,
        { automatedInput: true },
      );
      expect(mockMarkDelivered).toHaveBeenCalledWith('adm-admitted');
    });

    it('registers a redelivery handler for the automation origin that resends directly', () => {
      expect(mockRegisterRedeliveryHandler).toHaveBeenCalledWith('automation', expect.any(Function));
      const handler = mockRegisterRedeliveryHandler.mock.calls[0][1] as (ctx: {
        admissionId: string;
        instanceId: string;
        message: string;
        attachments?: unknown[];
      }) => void;

      sendInput.mockResolvedValue(undefined);
      handler({ admissionId: 'adm-redeliver', instanceId: 'instance-9', message: 'wake up' });

      expect(sendInput).toHaveBeenCalledWith(
        'instance-9',
        'wake up',
        undefined,
        { automatedInput: true },
      );
    });
  });
});
